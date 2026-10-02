package expo.modules.guardianprotection.policy

import expo.modules.guardianprotection.storage.PolicySnapshotStore
import expo.modules.guardianprotection.observability.GuardianPerformanceMetrics
import expo.modules.guardianprotection.vpn.GuardianVpnService
import expo.modules.guardianprotection.content.ContentRiskPolicy
import android.util.Base64
import org.json.JSONObject
import java.time.Instant

class PolicyManager(
  private val store: PolicySnapshotStore,
  trustedKeysJson: String = "{}",
  activeKeyId: String = "",
  decodeBase64: (String) -> ByteArray = { Base64.decode(it, Base64.DEFAULT) },
) {
  private val trustedKeys = parseTrustedKeys(trustedKeysJson)
  private val verifier = PolicyVerifier(trustedKeys, decodeBase64)
  @Volatile private var active: CompiledPolicySnapshot? = null
  @Volatile private var previous: CompiledPolicySnapshot? = null
  init {
    require(activeKeyId.isBlank() || trustedKeys.containsKey(activeKeyId)) {
      "Configured active policy key is absent from the trusted key set"
    }
    store.active()?.let { encoded ->
      runCatching {
        val restored = compile(parseJsonObject(encoded))
        if (restored.policyVersion == store.appliedVersion()) active = restored
      }
    }
  }

  fun apply(bundle: Map<String, Any?>): Map<String, Any?> {
    val started = System.nanoTime()
    if (store.hasCorruptState()) return failure("LOCAL_STATE_CORRUPT", store.appliedVersion())
    val version = (bundle["policy_version"] as? Number)?.toLong()
      ?: return failure("INVALID_POLICY_VERSION")
    val schemaError = validateSchema(bundle)
    if (schemaError != null) return failure(schemaError)
    val current = store.appliedVersion()
    if (current != null && version <= current) return failure("POLICY_VERSION_NOT_MONOTONIC", current)
    if (!verifier.verify(bundle)) return failure("SIGNATURE_INVALID", current)
    val result = runCatching {
      val compiled = compile(bundle)
      previous = active
      store.swap(CanonicalJson.encode(bundle), version)
      active = compiled
      mapOf("applied" to true, "policyVersion" to version)
    }.getOrElse {
      failure("POLICY_REJECTED")
    }
    GuardianPerformanceMetrics.recordPolicyApply(System.nanoTime() - started)
    return result
  }

  fun rollback(): Boolean {
    val encoded = store.previous() ?: return false
    val restored = runCatching { compile(parseJsonObject(encoded)) }.getOrNull() ?: return false
    val snapshot = previous
    store.swap(encoded, restored.policyVersion)
    previous = active ?: snapshot
    active = restored
    return true
  }

  fun clear() {
    active = null
    previous = null
    store.clearChildIdentity()
  }

  fun activeSnapshot(): CompiledPolicySnapshot? = active

  fun protectionStatus(capabilities: Map<String, Map<String, Any?>>): Map<String, Any?> {
    return ProtectionStatusEvaluator.evaluate(
      active = GuardianVpnService.isRunning(),
      policyVersion = active?.policyVersion ?: store.appliedVersion(),
      capabilities = capabilities,
    )
  }

  private fun compile(bundle: Map<String, Any?>): CompiledPolicySnapshot {
    val ageBand = bundle["age_band"] as String
    val contentSafety = when (val raw = bundle["content_safety"]) {
      null -> null
      is Map<*, *> -> raw.cast()
      else -> throw IllegalArgumentException("Invalid content_safety policy section")
    }
    val communicationSafety = when (val raw = bundle["communication_safety"]) {
      null -> emptyMap()
      is Map<*, *> -> raw.cast()
      else -> throw IllegalArgumentException("Invalid communication_safety policy section")
    }
    val appRules = (bundle["app_rules"] as? List<*>).orEmpty()
      .filterIsInstance<Map<*, *>>()
      .mapNotNull { rule -> (rule["app_ref"] as? String)?.let { it to rule.cast() } }
      .toMap()
    val categoryRules = (bundle["category_rules"] as? List<*>).orEmpty()
      .filterIsInstance<Map<*, *>>()
      .mapNotNull { rule -> (rule["category"] as? String)?.let { it to rule.cast() } }
      .toMap()
    return CompiledPolicySnapshot(
      policyVersion = (bundle["policy_version"] as Number).toLong(),
      appRules = appRules,
      domainRules = (bundle["domain_rules"] as? List<*>)?.filterIsInstance<Map<*, *>>()?.map { it.cast() }.orEmpty(),
      categoryRules = categoryRules,
      temporaryOverrides = (bundle["temporary_overrides"] as? List<*>)?.filterIsInstance<Map<*, *>>()?.map { it.cast() }.orEmpty(),
      routines = (bundle["routines"] as? List<*>)?.filterIsInstance<Map<*, *>>()?.map { it.cast() }.orEmpty(),
      basePolicy = (bundle["base_policy"] as? Map<*, *>)?.let { it.cast() } ?: emptyMap(),
      communicationSafety = communicationSafety,
      expiresSoftAt = (bundle["expires_soft_at"] as? String)?.let { Instant.parse(it) },
      contentBlockThreshold = ContentRiskPolicy.parseSignedThreshold(ageBand, contentSafety),
    )
  }

  private fun validateSchema(bundle: Map<String, Any?>): String? {
    if ((bundle["schema_version"] as? Number)?.toInt() != 1) return "UNSUPPORTED_SCHEMA"
    val requiredStrings = listOf(
      "family_id", "child_profile_id", "issued_at", "expires_soft_at", "key_id", "age_band",
    )
    if (requiredStrings.any { bundle[it] !is String }) return "SCHEMA_INVALID"
    val policyVersion = bundle["policy_version"] as? Number
    if (policyVersion == null || policyVersion.toDouble() != policyVersion.toLong().toDouble()) {
      return "INVALID_POLICY_VERSION"
    }
    if (bundle["base_policy"] !is Map<*, *>) return "SCHEMA_INVALID"
    val ageBand = bundle["age_band"] as? String ?: return "SCHEMA_INVALID"
    if (bundle.containsKey("content_safety") && bundle["content_safety"] !is Map<*, *>) {
      return "CONTENT_SAFETY_INVALID"
    }
    if (bundle.containsKey("communication_safety") && bundle["communication_safety"] !is Map<*, *>) {
      return "COMMUNICATION_SAFETY_INVALID"
    }
    val contentSafety = (bundle["content_safety"] as? Map<*, *>)?.cast()
    if (runCatching { ContentRiskPolicy.parseSignedThreshold(ageBand, contentSafety) }.isFailure) {
      return "CONTENT_SAFETY_INVALID"
    }
    if (listOf("app_rules", "domain_rules", "category_rules", "routines", "temporary_overrides").any {
        bundle[it] !is List<*>
      }) return "SCHEMA_INVALID"
    if (bundle["signature"] !is String) return "SCHEMA_INVALID"
    return null
  }

  private fun failure(reason: String, version: Long? = null) = mapOf(
    "applied" to false,
    "policyVersion" to version,
    "reason" to reason,
  )

  private fun Map<*, *>.cast(): Map<String, Any?> =
    entries.associate { (key, value) -> key as String to value }

  private fun parseTrustedKeys(value: String): Map<String, String> {
    return runCatching {
      val json = JSONObject(value)
      json.keys().asSequence().associateWith { key -> json.getString(key) }
    }.getOrDefault(emptyMap())
  }

  private fun parseJsonObject(value: String): Map<String, Any?> {
    fun convert(raw: Any?): Any? = when (raw) {
      JSONObject.NULL -> null
      is JSONObject -> raw.keys().asSequence().associateWith { convert(raw.get(it)) }
      is org.json.JSONArray -> (0 until raw.length()).map { convert(raw.get(it)) }
      else -> raw
    }
    return convert(JSONObject(value)) as Map<String, Any?>
  }
}
