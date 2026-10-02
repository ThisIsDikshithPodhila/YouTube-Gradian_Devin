package expo.modules.guardianprotection.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import expo.modules.guardianprotection.usage.deviceTotalSeconds
import expo.modules.guardianprotection.content.ContentApproval
import expo.modules.guardianprotection.content.ContentBlockReference
import expo.modules.guardianprotection.content.ContentAction
import expo.modules.guardianprotection.content.ContentCapabilityLevel
import expo.modules.guardianprotection.content.ContentRiskCategory
import expo.modules.guardianprotection.content.ContentRiskSeverity
import expo.modules.guardianprotection.content.SignalSource
import org.json.JSONArray
import java.time.Instant

interface PolicySnapshotStore {
  fun active(): String?
  fun previous(): String?
  fun appliedVersion(): Long?
  fun hasCorruptState(): Boolean
  fun swap(active: String, version: Long)
  fun clearChildIdentity()
}

class EncryptedPolicyStore(
  context: Context,
  preferenceName: String = "guardian-protection",
) : PolicySnapshotStore {
  private val preferences = context.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
  private val alias = "guardian-protection-state"
  private val corruptState = AtomicBoolean(false)

  override fun active(): String? = read("active")
  override fun previous(): String? = read("previous")
  override fun appliedVersion(): Long? = preferences.getLong("applied-version", -1).takeIf { it >= 0 }
  override fun hasCorruptState(): Boolean = corruptState.get()

  override fun swap(active: String, version: Long) {
    val old = read("active")
    preferences.edit()
      .putString("previous", old?.let { encrypt(it) })
      .putString("active", encrypt(active))
      .putLong("applied-version", version)
      .commit()
  }

  @Synchronized
  fun addUsage(target: String, deltaSeconds: Long, elapsedRealtime: Long) {
    require(target.isNotBlank()) { "Usage target cannot be blank" }
    require(deltaSeconds >= 0) { "Usage deltas cannot be negative" }
    require(elapsedRealtime >= 0) { "Elapsed realtime cannot be negative" }
    val counters = usageCounters()
    val current = counters[target] ?: CounterState()
    val next = MonotonicCounterStore().also {
      it.restore(current.totalSeconds, current.lastElapsedRealtime)
    }.add(deltaSeconds, elapsedRealtime)
    counters[target] = CounterState(next, elapsedRealtime)
    val json = JSONObject().apply {
      counters.toSortedMap().forEach { (key, value) ->
        put(key, JSONObject().apply {
          put("total_seconds", value.totalSeconds)
          put("last_elapsed_realtime", value.lastElapsedRealtime)
        })
      }
    }
    preferences.edit().putString("usage-counters", encrypt(json.toString())).commit()
  }

  fun usageSummary(range: Map<String, Any?>): Map<String, Any?> {
    val byTarget = usageCounters().mapValues { it.value.totalSeconds }
    return mapOf(
      "range" to range,
      "totalSeconds" to deviceTotalSeconds(byTarget),
      "byTarget" to byTarget,
    )
  }

  @Synchronized
  fun mergeUsageSnapshot(date: String, totals: Map<String, Long>) {
    require(date.isNotBlank()) { "Usage date cannot be blank" }
    require(totals.values.all { it >= 0 }) { "Usage totals cannot be negative" }
    val root = usageSnapshots().toMutableMap()
    val current = root[date].orEmpty().toMutableMap()
    totals.forEach { (target, value) ->
      if (target.isNotBlank()) current[target] = maxOf(current[target] ?: 0L, value)
    }
    root[date] = current
    val json = JSONObject().apply {
      root.toSortedMap().forEach { (day, values) ->
        put(day, JSONObject().apply {
          values.toSortedMap().forEach { (target, total) -> put(target, total) }
        })
      }
    }
    preferences.edit().putString("usage-snapshots", encrypt(json.toString())).commit()
  }

  fun usageSnapshots(): Map<String, Map<String, Long>> {
    val encoded = preferences.getString("usage-snapshots", null) ?: return emptyMap()
    val decoded = runCatching { JSONObject(decrypt(encoded)) }.getOrElse {
      corruptState.set(true)
      return emptyMap()
    }
    return decoded.keys().asSequence().associateWith { day ->
      val values = decoded.getJSONObject(day)
      values.keys().asSequence().associateWith { target -> values.getLong(target) }
    }
  }

  /** Device-local HMAC material; the raw observed text is never stored with it. */
  @Synchronized
  fun contentFingerprintKey(): ByteArray {
    read("content-fingerprint-key")?.let { encoded ->
      return Base64.decode(encoded, Base64.NO_WRAP)
    }
    return ByteArray(32).also { key ->
      SecureRandom().nextBytes(key)
      write("content-fingerprint-key", Base64.encodeToString(key, Base64.NO_WRAP))
    }
  }

  /** Pairing records the server device reference once; it is never synthesized locally. */
  @Synchronized
  fun setContentDeviceId(deviceId: String) {
    require(DEVICE_ID_PATTERN.matches(deviceId)) { "Invalid device reference" }
    write("content-device-id", deviceId)
  }

  fun contentDeviceId(): String? = read("content-device-id")?.takeIf(DEVICE_ID_PATTERN::matches)

  /** An explicit re-pairing discards the prior child's credentials and signed local state. */
  @Synchronized
  override fun clearChildIdentity() {
    preferences.edit()
      .remove("active")
      .remove("previous")
      .remove("applied-version")
      .remove("content-device-id")
      .remove("content-approvals")
      .remove("content-risk-events")
      .remove("content-review-outbox")
      .remove("active-content-block")
      .remove("content-fingerprint-key")
      .remove("usage-counters")
      .remove("usage-snapshots")
      .commit()
    corruptState.set(false)
  }

  /** Bounded encrypted queue used while the JS runtime is absent. Values are pre-minimized. */
  @Synchronized
  fun appendContentRiskEvent(event: Map<String, Any>): Boolean {
    require(event.keys == CONTENT_RISK_EVENT_FIELDS) { "Unexpected content event field" }
    val queue = read("content-risk-events")?.let { encoded -> JSONArray(encoded) } ?: JSONArray()
    val duplicate = (0 until queue.length()).any { index ->
      val prior = queue.optJSONObject(index) ?: return@any false
      prior.optString("app_ref") == event["app_ref"] &&
        prior.optString("signal_source") == event["signal_source"] &&
        prior.optString("fingerprint") == event["fingerprint"]
    }
    if (duplicate) return false
    while (queue.length() >= MAX_CONTENT_RISK_EVENTS) queue.remove(0)
    queue.put(JSONObject(event))
    write("content-risk-events", queue.toString())
    return true
  }

  /** Strict minimized events for transport; raw observed text is never bridged. */
  @Synchronized
  fun pendingContentRiskEvents(): List<Map<String, Any>> =
    read("content-risk-events")?.let { encoded ->
      runCatching {
        val queue = JSONArray(encoded)
        (0 until queue.length()).mapNotNull { index ->
          val item = queue.optJSONObject(index) ?: return@mapNotNull null
          runCatching {
            val source = SignalSource.valueOf(item.getString("signal_source"))
            val category = ContentRiskCategory.valueOf(item.getString("category"))
            val severity = ContentRiskSeverity.valueOf(item.getString("severity"))
            val capability = ContentCapabilityLevel.valueOf(item.getString("capability_level"))
            val action = ContentAction.valueOf(item.getString("action"))
            val appRef = item.getString("app_ref")
            val fingerprint = item.getString("fingerprint")
            val reasonCode = item.getString("reason_code")
            val classifierVersion = item.getString("classifier_version")
            val confidence = item.getDouble("confidence")
            val occurredAtMillis = item.getLong("occurred_at_millis")
            require(appRef.isNotBlank() && fingerprint.matches(Regex("^[a-f0-9]{64}$")))
            require(reasonCode.isNotBlank() && classifierVersion.isNotBlank())
            require(confidence in 0.0..1.0 && occurredAtMillis > 0)
            mapOf(
              "signal_source" to source.name,
              "app_ref" to appRef,
              "fingerprint" to fingerprint,
              "category" to category.name,
              "severity" to severity.name,
              "confidence" to confidence,
              "reason_code" to reasonCode,
              "classifier_version" to classifierVersion,
              "capability_level" to capability.name,
              "action" to action.name,
              "occurred_at_millis" to occurredAtMillis,
            )
          }.getOrNull()
        }
      }.getOrElse {
        corruptState.set(true)
        emptyList()
      }
    } ?: emptyList()

  /** Remove exactly a successfully delivered minimized fingerprint tuple. */
  @Synchronized
  fun acknowledgeContentRiskEvent(signalSource: String, appRef: String, fingerprint: String) {
    val queue = read("content-risk-events")?.let { encoded -> JSONArray(encoded) } ?: return
    val remaining = JSONArray()
    (0 until queue.length()).forEach { index ->
      val item = queue.optJSONObject(index) ?: return@forEach
      if (item.optString("signal_source") != signalSource ||
        item.optString("app_ref") != appRef ||
        item.optString("fingerprint") != fingerprint
      ) remaining.put(item)
    }
    write("content-risk-events", remaining.toString())
  }

  @Synchronized
  fun activeContentBlock(): ContentBlockReference? = read("active-content-block")?.let { encoded ->
    runCatching {
      val item = JSONObject(encoded)
      ContentBlockReference(
        appRef = item.getString("app_ref"),
        fingerprint = item.getString("fingerprint"),
        category = ContentRiskCategory.valueOf(item.getString("category")),
        severity = ContentRiskSeverity.valueOf(item.getString("severity")),
        confidence = item.getDouble("confidence"),
        reasonCode = item.getString("reason_code"),
        occurredAtMillis = item.getLong("occurred_at_millis"),
      )
    }.getOrElse {
      corruptState.set(true)
      null
    }
  }

  @Synchronized
  fun saveActiveContentBlock(reference: ContentBlockReference) {
    write("active-content-block", JSONObject().apply {
      put("app_ref", reference.appRef)
      put("fingerprint", reference.fingerprint)
      put("category", reference.category.name)
      put("severity", reference.severity.name)
      put("confidence", reference.confidence)
      put("reason_code", reference.reasonCode)
      put("occurred_at_millis", reference.occurredAtMillis)
    }.toString())
  }

  @Synchronized
  fun clearActiveContentBlock(appRef: String? = null, fingerprint: String? = null) {
    val active = activeContentBlock()
    if (appRef != null && (active?.appRef != appRef || active?.fingerprint != fingerprint)) return
    preferences.edit().remove("active-content-block").commit()
  }

  /** Deduped `CONTENT_REVIEW` outbox. It contains only backend-contract evidence. */
  @Synchronized
  fun enqueueContentReview(reference: ContentBlockReference): Boolean {
    val queue = read("content-review-outbox")?.let { encoded -> JSONArray(encoded) } ?: JSONArray()
    if ((0 until queue.length()).any { index ->
        val prior = queue.optJSONObject(index) ?: return@any false
        prior.optString("app_ref") == reference.appRef && prior.optString("fingerprint") == reference.fingerprint
      }) return false
    while (queue.length() >= MAX_CONTENT_RISK_EVENTS) queue.remove(0)
    queue.put(JSONObject().apply {
      put("request_type", "CONTENT_REVIEW")
      put("app_ref", reference.appRef)
      put("fingerprint", reference.fingerprint)
      put("category", reference.category.name)
      put("severity", reference.severity.name)
      put("confidence", reference.confidence)
      put("reason_code", reference.reasonCode)
      put("occurred_at_millis", reference.occurredAtMillis)
    })
    write("content-review-outbox", queue.toString())
    return true
  }

  /** Transport seam: returns the strict backend request shape and never source text. */
  @Synchronized
  fun pendingContentReviewRequests(): List<Map<String, Any>> =
    read("content-review-outbox")?.let { encoded ->
      runCatching {
        val queue = JSONArray(encoded)
        (0 until queue.length()).mapNotNull { index ->
          val item = queue.optJSONObject(index) ?: return@mapNotNull null
          runCatching {
            val evidence = mapOf<String, Any>(
              "app_ref" to item.getString("app_ref"),
              "fingerprint" to item.getString("fingerprint"),
              "category" to item.getString("category"),
              "severity" to item.getString("severity"),
              "confidence" to item.getDouble("confidence"),
              "reason_code" to item.getString("reason_code"),
            )
            ContentBlockReference(
              evidence.getValue("app_ref") as String,
              evidence.getValue("fingerprint") as String,
              ContentRiskCategory.valueOf(evidence.getValue("category") as String),
              ContentRiskSeverity.valueOf(evidence.getValue("severity") as String),
              evidence.getValue("confidence") as Double,
              evidence.getValue("reason_code") as String,
              item.getLong("occurred_at_millis"),
            )
            mapOf("request_type" to "CONTENT_REVIEW", "content_review" to evidence)
          }.getOrNull()
        }
      }.getOrElse {
        corruptState.set(true)
        emptyList()
      }
    } ?: emptyList()

  @Synchronized
  fun acknowledgeContentReviewRequest(appRef: String, fingerprint: String) {
    val queue = read("content-review-outbox")?.let { encoded -> JSONArray(encoded) } ?: return
    val remaining = JSONArray()
    (0 until queue.length()).forEach { index ->
      val item = queue.optJSONObject(index) ?: return@forEach
      if (item.optString("app_ref") != appRef || item.optString("fingerprint") != fingerprint) remaining.put(item)
    }
    write("content-review-outbox", remaining.toString())
  }

  @Synchronized
  fun replaceContentApprovals(approvals: Iterable<ContentApproval>, now: Instant = Instant.now()) {
    val deviceId = contentDeviceId() ?: return
    val valid = approvals.filter {
      it.deviceId == deviceId && it.expiresAt.isAfter(now) && !it.expiresAt.isAfter(now.plusSeconds(900))
    }.toList()
    val json = JSONArray().apply {
      valid.forEach { approval -> put(JSONObject().apply {
        put("device_id", approval.deviceId)
        put("app_ref", approval.appRef)
        put("fingerprint", approval.fingerprint)
        put("expires_at", approval.expiresAt.toString())
      }) }
    }
    write("content-approvals", json.toString())
  }

  @Synchronized
  fun contentApprovals(now: Instant = Instant.now()): List<ContentApproval> =
    read("content-approvals")?.let { encoded ->
      runCatching {
        val queue = JSONArray(encoded)
        (0 until queue.length()).mapNotNull { index ->
          val item = queue.optJSONObject(index) ?: return@mapNotNull null
          runCatching {
            ContentApproval(
              item.getString("device_id"),
              item.getString("app_ref"),
              item.getString("fingerprint"),
              Instant.parse(item.getString("expires_at")),
            )
          }.getOrNull()?.takeIf { it.expiresAt.isAfter(now) }
        }
      }.getOrElse {
        corruptState.set(true)
        emptyList()
      }
    } ?: emptyList()
  private fun read(key: String): String? {
    val encoded = preferences.getString(key, null) ?: return null
    return runCatching { decrypt(encoded) }.getOrElse {
      corruptState.set(true)
      null
    }
  }

  private fun write(key: String, value: String) {
    preferences.edit().putString(key, encrypt(value)).commit()
  }

  private fun usageCounters(): MutableMap<String, CounterState> {
    val encoded = preferences.getString("usage-counters", null) ?: return mutableMapOf()
    val decoded = runCatching { JSONObject(decrypt(encoded)) }.getOrElse {
      corruptState.set(true)
      throw IllegalStateException("Encrypted usage state is corrupt", it)
    }
    return decoded.keys().asSequence().associateWith { key ->
      val value = decoded.getJSONObject(key)
      CounterState(
        value.getLong("total_seconds"),
        value.getLong("last_elapsed_realtime"),
      )
    }.toMutableMap()
  }

  private fun key() = (KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null)
    ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUserAuthenticationRequired(false)
        .build())
    }.generateKey())

  private fun encrypt(value: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  }

  private fun decrypt(value: String): String {
    val bytes = Base64.decode(value, Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    return cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
  }

  private data class CounterState(
    val totalSeconds: Long = 0,
    val lastElapsedRealtime: Long = 0,
  )

  private companion object {
    const val MAX_CONTENT_RISK_EVENTS = 50
    val DEVICE_ID_PATTERN = Regex("^[A-Za-z0-9-]{1,128}$")
    val CONTENT_RISK_EVENT_FIELDS = setOf(
      "signal_source",
      "app_ref",
      "fingerprint",
      "category",
      "severity",
      "confidence",
      "reason_code",
      "classifier_version",
      "capability_level",
      "action",
      "occurred_at_millis",
    )
  }
}
