package expo.modules.guardianprotection

import org.junit.Assert.assertEquals
import org.junit.Test

class ChildProtectionResetTest {
  @Test
  fun `reset tears down every child enforcement owner before re-pairing`() {
    val calls = mutableListOf<String>()
    ChildProtectionReset(
      stopVpn = { calls += "vpn" },
      clearVpnState = { calls += "vpn-state" },
      clearAccessibilityEnforcement = { calls += "accessibility" },
      dismissContentBlock = { calls += "block-activity" },
      clearContentPresentation = { calls += "block-presentation" },
      clearPolicyRuntime = { calls += "policy-runtime" },
      clearContentRuntime = { calls += "content-runtime" },
      clearPersistedPolicy = { calls += "encrypted-store" },
      clearReputation = { calls += "reputation" },
      clearPackageInventory = { calls += "inventory" },
      revokeContentConsent = { calls += "content-consent" },
    ).reset()

    assertEquals(
      listOf(
        "vpn",
        "vpn-state",
        "accessibility",
        "block-activity",
        "block-presentation",
        "policy-runtime",
        "content-runtime",
        "encrypted-store",
        "reputation",
        "inventory",
        "content-consent",
      ),
      calls,
    )
  }
}
