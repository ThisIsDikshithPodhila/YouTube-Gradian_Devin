package expo.modules.guardianprotection.reputation

import expo.modules.guardianprotection.policy.CanonicalJson
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

interface ReputationSnapshotStore {
  fun active(): String?
  fun previous(): String?
  fun appliedVersion(): Long?
  fun swap(active: String, version: Long)
  fun clear()
}

data class ReputationEntry(
  val identifier: String,
  val verdict: String,
  val source: String,
  val rationale: String,
  val expiresAt: Instant,
)

data class ReputationSnapshot(
  val version: Long,
  val entries: Map<String, ReputationEntry>,
)

data class ReputationApplyResult(
  val applied: Boolean,
  val version: Long?,
  val reason: String,
  val entryCount: Int = 0,
  val encodedBytes: Int = 0,
  val applyMillis: Long = 0,
  val estimatedMemoryBytes: Long = 0,
)

class ReputationManager(
  private val store: ReputationSnapshotStore,
  private val verify: (Map<String, Any?>) -> Boolean,
) {
  @Volatile private var active: ReputationSnapshot? = restore()
  private val pending = ConcurrentHashMap<String, Long>()

  fun apply(bundle: Map<String, Any?>): ReputationApplyResult {
    val started = System.nanoTime()
    val version = (bundle["bundle_version"] as? Number)?.toLong()
      ?: return failure("INVALID_BUNDLE_VERSION")
    val schemaError = validateSchema(bundle, version)
    if (schemaError != null) return failure(schemaError, version)
    if (!verify(bundle)) return failure("SIGNATURE_INVALID", active?.version)
    val parsedEntries = runCatching { parseEntries(bundle["entries"]) }
      .getOrElse { return failure("SCHEMA_INVALID", active?.version) }
    val current = active
    val kind = bundle["kind"] as String
    if (current != null && version <= current.version) return failure("VERSION_NOT_MONOTONIC", current.version)
    if (kind == "DELTA" && (bundle["base_version"] as? Number)?.toLong() != current?.version) {
      return failure("DELTA_GAP", current?.version)
    }
    val entries = parsedEntries
    val next = if (kind == "FULL") {
      ReputationSnapshot(version, entries.associateBy { it.identifier })
    } else {
      val merged = current?.entries.orEmpty().toMutableMap()
      entries.forEach { merged[it.identifier] = it }
      ReputationSnapshot(version, merged)
    }
    return runCatching {
      val encoded = CanonicalJson.encode(bundle)
      store.swap(encoded, version)
      active = next
      entries.forEach { pending.remove(it.identifier) }
      ReputationApplyResult(
        applied = true,
        version = version,
        reason = "APPLIED",
        entryCount = next.entries.size,
        encodedBytes = encoded.toByteArray(Charsets.UTF_8).size,
        applyMillis = (System.nanoTime() - started) / 1_000_000,
        estimatedMemoryBytes = estimatedMemoryBytes(next.entries.size),
      )
    }.getOrElse { failure("LOCAL_STATE_REJECTED", current?.version) }
  }

  fun lookup(identifier: String, nowMillis: Long = System.currentTimeMillis()): ReputationEntry? {
    val entry = active?.entries?.get(identifier.trim().lowercase()) ?: return null
    return entry.takeIf { it.expiresAt.toEpochMilli() > nowMillis }
  }

  fun snapshot(): ReputationSnapshot? = active

  fun version(): Long? = active?.version

  fun clear() {
    active = null
    pending.clear()
    store.clear()
  }

  fun markPending(identifier: String, timeoutMillis: Long = DEFAULT_PENDING_TIMEOUT_MS): Long {
    val expires = System.currentTimeMillis() + timeoutMillis.coerceIn(1_000L, MAX_PENDING_TIMEOUT_MS)
    pending.putIfAbsent(identifier.trim().lowercase(), expires)
    return pending[identifier.trim().lowercase()] ?: expires
  }

  fun pendingUntil(identifier: String): Long? {
    val key = identifier.trim().lowercase()
    return pending[key]
  }

  private fun validateSchema(bundle: Map<String, Any?>, version: Long): String? {
    if ((bundle["schema_version"] as? Number)?.toInt() != 1) return "UNSUPPORTED_SCHEMA"
    if (bundle["kind"] !in setOf("FULL", "DELTA")) return "SCHEMA_INVALID"
    if (bundle["kind"] == "DELTA" && bundle["base_version"] !is Number) return "SCHEMA_INVALID"
    if (version <= 0 || bundle["entries"] !is List<*>) return "SCHEMA_INVALID"
    if (bundle["expires_at"] !is String || bundle["key_id"] !is String || bundle["signature"] !is String) {
      return "SCHEMA_INVALID"
    }
    val expiresAt = runCatching { Instant.parse(bundle["expires_at"] as String) }.getOrNull()
      ?: return "SCHEMA_INVALID"
    if (!expiresAt.isAfter(Instant.now())) return "BUNDLE_EXPIRED"
    if ((bundle["entries"] as List<*>).size > MAX_ENTRIES) return "BUNDLE_TOO_LARGE"
    return null
  }

  private fun parseEntries(raw: Any?): List<ReputationEntry> {
    return (raw as? List<*>).orEmpty().map { item ->
      val value = item as? Map<*, *> ?: error("entry is not an object")
      val identifier = value["identifier"] as? String ?: error("entry identifier missing")
      if (identifier.length !in 1..253 || identifier.any { it.isWhitespace() || it in "/?#:" }) {
        error("entry identifier invalid")
      }
      if (value["target_kind"] !in setOf("DOMAIN", "APP")) error("entry target kind invalid")
      val verdict = (value["verdict"] as? String)
        ?.takeIf { it in setOf("KNOWN_SAFE", "KNOWN_RISK", "UNKNOWN") }
        ?: error("entry verdict invalid")
      val expiresAt = Instant.parse(value["expires_at"] as? String ?: error("entry expiry missing"))
      ReputationEntry(
        identifier = identifier.trim().lowercase(),
        verdict = verdict,
        source = value["source"] as? String ?: error("entry source missing"),
        rationale = value["rationale"] as? String ?: error("entry rationale missing"),
        expiresAt = expiresAt,
      )
    }
  }

  private fun restore(): ReputationSnapshot? {
    val expectedVersion = store.appliedVersion() ?: return null
    val activeSnapshot = store.active()?.let { restoreDocument(it, expectedVersion) }
    if (activeSnapshot != null) return activeSnapshot
    return store.previous()?.let { restoreDocument(it, expectedVersion, requireFull = true) }
  }

  private fun restoreDocument(
    encoded: String,
    expectedVersion: Long,
    requireFull: Boolean = false,
  ): ReputationSnapshot? = runCatching {
      val objectValue = JSONObject(encoded)
      val map = toMap(objectValue)
      val bundleVersion = (map["bundle_version"] as? Number)?.toLong() ?: return@runCatching null
      if (bundleVersion != expectedVersion && !requireFull) return@runCatching null
      if (requireFull && map["kind"] != "FULL") return@runCatching null
      if (validateSchema(map, bundleVersion) != null) return@runCatching null
      if (!verify(map)) return@runCatching null
      val entries = parseEntries(map["entries"])
      ReputationSnapshot(bundleVersion, entries.associateBy { it.identifier })
    }.getOrNull()

  private fun toMap(value: JSONObject): Map<String, Any?> =
    value.keys().asSequence().associateWith { key ->
      when (val child = value.get(key)) {
        JSONObject.NULL -> null
        is JSONObject -> toMap(child)
        is org.json.JSONArray -> (0 until child.length()).map { index ->
          when (val item = child.get(index)) {
            is JSONObject -> toMap(item)
            JSONObject.NULL -> null
            else -> item
          }
        }
        else -> child
      }
    }

  private fun failure(reason: String, version: Long? = null) = ReputationApplyResult(false, version, reason)

  private fun estimatedMemoryBytes(entryCount: Int): Long =
    entryCount.toLong() * APPROX_ENTRY_BYTES

  companion object {
    private const val MAX_ENTRIES = 100_000
    private const val DEFAULT_PENDING_TIMEOUT_MS = 30_000L
    private const val MAX_PENDING_TIMEOUT_MS = 120_000L
    private const val APPROX_ENTRY_BYTES = 512L
  }
}
