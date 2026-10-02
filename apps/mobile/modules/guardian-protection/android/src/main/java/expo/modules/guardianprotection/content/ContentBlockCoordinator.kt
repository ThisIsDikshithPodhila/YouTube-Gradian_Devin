package expo.modules.guardianprotection.content

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.Intent
import android.os.SystemClock
import expo.modules.guardianprotection.accessibility.GuardianBlockActivity
import expo.modules.guardianprotection.storage.EncryptedPolicyStore
import java.time.Instant

/**
 * Native-only enforcement seam. A risk result is durable before an interstitial
 * is shown; loss of JS/network therefore never grants access.
 */
object ContentBlockCoordinator {
  @Volatile private var lastPresentationKey: String? = null
  @Volatile private var lastPresentationAt = 0L

  fun observe(
    context: Context,
    event: MinimizedContentRiskEvent?,
    foregroundSignal: Boolean,
    safeObservationAppRef: String? = null,
  ): ContentBlockDecision {
    val store = EncryptedPolicyStore(context.applicationContext)
    val active = store.activeContentBlock()
    val decision = ContentBlockStateMachine.decide(
      event,
      active,
      store.contentApprovals(),
      store.contentDeviceId(),
      Instant.now(),
    )
    if (!decision.shouldBlock) {
      safeObservationAppRef?.let { observed ->
        active?.takeIf { it.appRef == observed }?.let { store.clearActiveContentBlock(it.appRef, it.fingerprint) }
      }
      return decision
    }
    // A background notification is evidence, not proof that this exact item
    // remains visible when the child next opens the app.
    if (!ContentBlockEnforcementGate.mayPersistActiveBlock(event, foregroundSignal)) return decision
    val reference = requireNotNull(decision.reference)
    if (!mayBlock(context, reference.appRef)) {
      return ContentBlockDecision(false, null)
    }
    store.saveActiveContentBlock(reference)
    if (foregroundSignal) present(context, reference)
    return decision
  }

  /** Called from the foreground Accessibility path to restore an undismissable-in-place block. */
  fun reblockIfCurrentForeground(context: Context, appRef: String) {
    val store = EncryptedPolicyStore(context.applicationContext)
    val active = store.activeContentBlock() ?: return
    if (active.appRef != appRef || !mayBlock(context, appRef)) return
    val approved = store.contentDeviceId()?.let { deviceId ->
      ContentReviewApprovalMatcher.matches(store.contentApprovals(), deviceId, active.appRef, active.fingerprint, Instant.now())
    } == true
    if (approved) {
      store.clearActiveContentBlock(active.appRef, active.fingerprint)
      return
    }
    present(context, active)
  }

  /** Ask Parent is a durable minimized request and never a local unlock. */
  fun requestParent(context: Context, appRef: String, fingerprint: String): Boolean {
    val store = EncryptedPolicyStore(context.applicationContext)
    val active = store.activeContentBlock()
    if (active?.appRef != appRef || active?.fingerprint != fingerprint) return false
    store.enqueueContentReview(active)
    return true
  }

  fun applyApprovals(context: Context, approvals: Iterable<ContentApproval>) {
    val store = EncryptedPolicyStore(context.applicationContext)
    store.replaceContentApprovals(approvals)
    val active = store.activeContentBlock() ?: return
    val approved = store.contentDeviceId()?.let { deviceId ->
      ContentReviewApprovalMatcher.matches(store.contentApprovals(), deviceId, active.appRef, active.fingerprint, Instant.now())
    } == true
    if (approved) {
      store.clearActiveContentBlock(active.appRef, active.fingerprint)
      GuardianBlockActivity.dismissContentBlock(active.appRef, active.fingerprint)
    }
  }

  /** Clears only process memory; durable block state is removed by EncryptedPolicyStore. */
  fun clearPresentationState() {
    lastPresentationKey = null
    lastPresentationAt = 0L
  }

  private fun mayBlock(context: Context, appRef: String): Boolean {
    val info = runCatching { context.packageManager.getApplicationInfo(appRef, 0) }.getOrNull() ?: return false
    val isSystemOrUpdated = info.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
    return ContentBlockEligibility.mayBlock(appRef, context.packageName, isSystemOrUpdated)
  }

  private fun present(context: Context, reference: ContentBlockReference) {
    val now = SystemClock.elapsedRealtime()
    val key = "${reference.appRef}|${reference.fingerprint}"
    if (lastPresentationKey == key && now - lastPresentationAt < PRESENTATION_DEBOUNCE_MS) return
    lastPresentationKey = key
    lastPresentationAt = now
    context.startActivity(
      Intent(context, GuardianBlockActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(GuardianBlockActivity.EXTRA_CONTENT_BLOCK, true)
        .putExtra(GuardianBlockActivity.EXTRA_APP, reference.appRef)
        .putExtra(GuardianBlockActivity.EXTRA_CONTENT_FINGERPRINT, reference.fingerprint)
        .putExtra(GuardianBlockActivity.EXTRA_REASON, reference.reasonCode),
    )
  }

  private const val PRESENTATION_DEBOUNCE_MS = 500L
}
