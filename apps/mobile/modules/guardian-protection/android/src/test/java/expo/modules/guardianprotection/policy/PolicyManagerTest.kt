package expo.modules.guardianprotection.policy

import expo.modules.guardianprotection.storage.PolicySnapshotStore
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyManagerTest {
  @Test
  fun clearingChildIdentityLetsANewFamilyStartAtPolicyVersionOne() {
    val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val store = InMemoryPolicyStore()
    val trustedPublicKey = Base64.getEncoder().encodeToString(keyPair.public.encoded)
    val manager = PolicyManager(
      store,
      "{\"current\":\"$trustedPublicKey\"}",
      decodeBase64 = Base64.getDecoder()::decode,
    )

    assertTrue(manager.apply(signedPolicy(keyPair, version = 7, familyId = "family-a"))["applied"] == true)
    manager.clear()

    assertNull(store.appliedVersion())
    assertNull(manager.activeSnapshot())
    assertTrue(manager.apply(signedPolicy(keyPair, version = 1, familyId = "family-b"))["applied"] == true)
    assertEquals(1L, manager.activeSnapshot()?.policyVersion)
  }

  private fun signedPolicy(keyPair: KeyPair, version: Long, familyId: String): Map<String, Any?> {
    val bundle = mutableMapOf<String, Any?>(
      "schema_version" to 1,
      "policy_version" to version,
      "family_id" to familyId,
      "child_profile_id" to "child-$familyId",
      "issued_at" to "2026-08-22T00:00:00Z",
      "expires_soft_at" to "2026-08-29T00:00:00Z",
      "key_id" to "current",
      "age_band" to "TEEN",
      "base_policy" to emptyMap<String, Any?>(),
      "app_rules" to emptyList<Any?>(),
      "domain_rules" to emptyList<Any?>(),
      "category_rules" to emptyList<Any?>(),
      "routines" to emptyList<Any?>(),
      "temporary_overrides" to emptyList<Any?>(),
    )
    val signature = Signature.getInstance("Ed25519").apply {
      initSign(keyPair.private)
      update(CanonicalJson.unsignedBytes(bundle))
    }.sign()
    bundle["signature"] = Base64.getEncoder().encodeToString(signature)
    return bundle
  }

  private class InMemoryPolicyStore : PolicySnapshotStore {
    private var active: String? = null
    private var previous: String? = null
    private var version: Long? = null

    override fun active(): String? = active
    override fun previous(): String? = previous
    override fun appliedVersion(): Long? = version
    override fun hasCorruptState(): Boolean = false

    override fun swap(active: String, version: Long) {
      previous = this.active
      this.active = active
      this.version = version
    }

    override fun clearChildIdentity() {
      active = null
      previous = null
      version = null
    }
  }
}
