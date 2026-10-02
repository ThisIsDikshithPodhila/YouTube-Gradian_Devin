package expo.modules.guardianprotection.storage

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import expo.modules.guardianprotection.content.ContentAction
import expo.modules.guardianprotection.content.ContentCapabilityLevel
import expo.modules.guardianprotection.content.ContentApproval
import expo.modules.guardianprotection.content.ContentBlockReference
import expo.modules.guardianprotection.content.ContentRiskCategory
import expo.modules.guardianprotection.content.ContentRiskSeverity
import expo.modules.guardianprotection.content.SignalSource
import java.time.Instant
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChildIdentityResetInstrumentedTest {
  @Test
  fun contentRiskOutbox_dedupes_and_acknowledges_only_the_uploaded_minimized_tuple() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val preferenceName = "guardian-content-risk-${UUID.randomUUID()}"
    val preferences = context.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
    try {
      val store = EncryptedPolicyStore(context, preferenceName)
      val fingerprint = "a".repeat(64)
      val event = mapOf<String, Any>(
        "signal_source" to SignalSource.ACCESSIBILITY_TEXT.name,
        "app_ref" to "com.example.video",
        "fingerprint" to fingerprint,
        "category" to ContentRiskCategory.SELF_HARM_SUICIDE.name,
        "severity" to ContentRiskSeverity.HIGH.name,
        "confidence" to 0.81,
        "reason_code" to "SELF_HARM_DIRECT",
        "classifier_version" to "deterministic-rules-v1",
        "capability_level" to ContentCapabilityLevel.BEST_EFFORT.name,
        "action" to ContentAction.BLOCK_AND_REQUEST.name,
        "occurred_at_millis" to 1_700_000_000_000L,
      )

      assertTrue(store.appendContentRiskEvent(event))
      assertFalse(store.appendContentRiskEvent(event))
      assertTrue(store.appendContentRiskEvent(event + ("signal_source" to SignalSource.NOTIFICATION.name)))
      val pending = store.pendingContentRiskEvents()
      assertEquals(2, pending.size)
      assertFalse(pending.flatMap { it.keys }.any { it.contains("text", ignoreCase = true) || it.contains("title", ignoreCase = true) })

      store.acknowledgeContentRiskEvent(SignalSource.ACCESSIBILITY_TEXT.name, "com.example.video", fingerprint)

      val remaining = store.pendingContentRiskEvents()
      assertEquals(1, remaining.size)
      assertEquals(SignalSource.NOTIFICATION.name, remaining.single()["signal_source"])
    } finally {
      preferences.edit().clear().commit()
    }
  }

  @Test
  fun clearChildIdentity_removes_usage_and_pending_content_review_for_the_previous_child() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val preferenceName = "guardian-child-reset-${UUID.randomUUID()}"
    val preferences = context.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
    try {
      val store = EncryptedPolicyStore(context, preferenceName)
      val now = Instant.now()
      val reference = ContentBlockReference(
        appRef = "com.example.childa",
        fingerprint = "a".repeat(64),
        category = ContentRiskCategory.SELF_HARM_SUICIDE,
        severity = ContentRiskSeverity.CRITICAL,
        confidence = 0.99,
        reasonCode = "SELF_HARM_DIRECT",
        occurredAtMillis = now.toEpochMilli(),
      )
      store.swap("{\"child\":\"child-a\"}", 1)
      store.setContentDeviceId("device-a")
      store.addUsage("com.example.childa", 60, 60)
      store.mergeUsageSnapshot("2026-08-21", mapOf("com.example.childa" to 60))
      store.saveActiveContentBlock(reference)
      store.replaceContentApprovals(listOf(ContentApproval("device-a", reference.appRef, reference.fingerprint, now.plusSeconds(60))), now)
      assertTrue(store.enqueueContentReview(reference))

      store.clearChildIdentity()

      assertNull(store.active())
      assertNull(store.contentDeviceId())
      assertNull(store.activeContentBlock())
      assertTrue(store.contentApprovals(now).isEmpty())
      assertTrue(store.pendingContentReviewRequests().isEmpty())
      assertTrue((store.usageSummary(emptyMap())["byTarget"] as Map<*, *>).isEmpty())
      assertTrue(store.usageSnapshots().isEmpty())
      assertFalse(preferences.contains("usage-counters"))
      assertFalse(preferences.contains("usage-snapshots"))
      assertFalse(preferences.contains("content-review-outbox"))
    } finally {
      preferences.edit().clear().commit()
    }
  }
}
