package expo.modules.guardianprotection.reputation

import expo.modules.guardianprotection.policy.CanonicalJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ReputationManagerTest {
  private class MemoryStore : ReputationSnapshotStore {
    var activeValue: String? = null
    var previousValue: String? = null
    var version: Long? = null

    override fun active() = activeValue
    override fun previous() = previousValue
    override fun appliedVersion() = version

    override fun swap(active: String, version: Long) {
      previousValue = activeValue
      activeValue = active
      this.version = version
    }

    override fun clear() {
      activeValue = null
      previousValue = null
      version = null
    }
  }

  private fun entry(identifier: String, verdict: String, expiresAt: String) = mapOf<String, Any?>(
    "target_kind" to "DOMAIN",
    "identifier" to identifier,
    "verdict" to verdict,
    "source" to "test",
    "rationale" to "deterministic test verdict",
    "expires_at" to expiresAt,
    "bundle_version" to 1,
  )

  @Test
  fun fullThenChainedDeltaUpdatesLookup() {
    val manager = ReputationManager(MemoryStore()) { true }
    assertEquals(
      "APPLIED",
      manager.apply(
        mapOf(
          "schema_version" to 1,
          "kind" to "FULL",
          "bundle_version" to 1,
          "base_version" to null,
          "expires_at" to "2030-01-01T00:00:00Z",
          "entries" to listOf(entry("safe.example", "KNOWN_SAFE", "2030-01-01T00:00:00Z")),
          "key_id" to "test",
          "signature" to "valid",
        ),
      ).reason,
    )
    assertEquals("KNOWN_SAFE", manager.lookup("safe.example", 0L)?.verdict)

    val result = manager.apply(
      mapOf(
        "schema_version" to 1,
        "kind" to "DELTA",
        "bundle_version" to 2,
        "base_version" to 1,
        "expires_at" to "2030-01-01T00:00:00Z",
        "entries" to listOf(entry("risk.example", "KNOWN_RISK", "2030-01-01T00:00:00Z")),
        "key_id" to "test",
        "signature" to "valid",
      ),
    )
    assertEquals("APPLIED", result.reason)
    assertEquals("KNOWN_RISK", manager.lookup("risk.example", 0L)?.verdict)
  }

  @Test
  fun deltaGapRetainsLastKnownGoodSnapshot() {
    val manager = ReputationManager(MemoryStore()) { true }
    manager.apply(
      mapOf(
        "schema_version" to 1,
        "kind" to "FULL",
        "bundle_version" to 4,
        "base_version" to null,
        "expires_at" to "2030-01-01T00:00:00Z",
        "entries" to listOf(entry("safe.example", "KNOWN_SAFE", "2030-01-01T00:00:00Z")),
        "key_id" to "test",
        "signature" to "valid",
      ),
    )
    val result = manager.apply(
      mapOf(
        "schema_version" to 1,
        "kind" to "DELTA",
        "bundle_version" to 6,
        "base_version" to 5,
        "expires_at" to "2030-01-01T00:00:00Z",
        "entries" to emptyList<Map<String, Any?>>(),
        "key_id" to "test",
        "signature" to "valid",
      ),
    )
    assertEquals("DELTA_GAP", result.reason)
    assertEquals(4L, manager.version())
    assertEquals("KNOWN_SAFE", manager.lookup("safe.example", 0L)?.verdict)
  }

  @Test
  fun expiredEntryReturnsUnknownWithoutDestroyingSnapshot() {
    val manager = ReputationManager(MemoryStore()) { true }
    manager.apply(
      mapOf(
        "schema_version" to 1,
        "kind" to "FULL",
        "bundle_version" to 1,
        "base_version" to null,
        "expires_at" to "2030-01-01T00:00:00Z",
        "entries" to listOf(entry("old.example", "KNOWN_SAFE", "2020-01-01T00:00:00Z")),
        "key_id" to "test",
        "signature" to "valid",
      ),
    )
    assertNull(manager.lookup("old.example", 2_000_000_000_000L))
    assertNotNull(manager.snapshot())
  }

  @Test
  fun expiredBundleIsRejected() {
    val result = ReputationManager(MemoryStore()) { true }.apply(
      mapOf(
        "schema_version" to 1,
        "kind" to "FULL",
        "bundle_version" to 1,
        "base_version" to null,
        "expires_at" to "2020-01-01T00:00:00Z",
        "entries" to emptyList<Map<String, Any?>>(),
        "key_id" to "test",
        "signature" to "valid",
      ),
    )
    assertEquals("BUNDLE_EXPIRED", result.reason)
  }

  @Test
  fun invalidPersistedSnapshotIsNotRestored() {
    val store = MemoryStore()
    store.activeValue = CanonicalJson.encode(
      mapOf(
        "schema_version" to 1,
        "kind" to "FULL",
        "bundle_version" to 1,
        "base_version" to null,
        "expires_at" to "2030-01-01T00:00:00Z",
        "entries" to listOf(entry("safe.example", "KNOWN_SAFE", "2030-01-01T00:00:00Z")),
        "key_id" to "test",
        "signature" to "invalid",
      ),
    )
    store.version = 1
    val manager = ReputationManager(store) { false }
    assertNull(manager.snapshot())
    assertNull(manager.lookup("safe.example", 0L))
    assertNull(manager.version())
  }

  @Test
  fun largeBundleReportsEncodedSizeAndApplyTime() {
    val entries = (0 until 10_000).map { index ->
      entry("domain-$index.example", "UNKNOWN", "2030-01-01T00:00:00Z")
    }
    val result = ReputationManager(MemoryStore()) { true }.apply(
      mapOf(
        "schema_version" to 1,
        "kind" to "FULL",
        "bundle_version" to 1,
        "base_version" to null,
        "expires_at" to "2030-01-01T00:00:00Z",
        "entries" to entries,
        "key_id" to "test",
        "signature" to "valid",
      ),
    )
    assertEquals("APPLIED", result.reason)
    assertEquals(10_000, result.entryCount)
    assertEquals(true, result.encodedBytes > 100_000)
    assertEquals(true, result.applyMillis >= 0)
    assertEquals(5_120_000L, result.estimatedMemoryBytes)
    println(
      "large_bundle_measurement entries=${result.entryCount} encoded_bytes=${result.encodedBytes} " +
        "apply_ms=${result.applyMillis} estimated_memory_bytes=${result.estimatedMemoryBytes}",
    )
  }
}
