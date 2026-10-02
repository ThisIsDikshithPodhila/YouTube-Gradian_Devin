package expo.modules.guardianprotection.content

import android.content.Context
import expo.modules.guardianprotection.policy.PolicyManager
import expo.modules.guardianprotection.storage.EncryptedPolicyStore
import java.time.Instant

/**
 * Rehydrates from encrypted, already-verified policy storage in service processes. It intentionally
 * has no Expo module or JavaScript listener dependency.
 */
object ContentSafetyServiceRuntime {
  @Volatile private var runtime: ContentSafetyRuntime? = null

  fun bootstrap(context: Context, trustedKeysJson: String): ContentSafetyRuntime? {
    val appContext = context.applicationContext
    val store = EncryptedPolicyStore(appContext)
    val manager = PolicyManager(store, trustedKeysJson)
    if (manager.activeSnapshot() == null || store.hasCorruptState()) return null
    return ContentSafetyRuntime(
      policy = {
        manager.activeSnapshot()?.let { snapshot ->
          val expiresSoftAt = snapshot.expiresSoftAt ?: return@let null
          if (!ContentSafetyPolicyValidity.isUsable(expiresSoftAt, Instant.now())) return@let null
          ContentSafetyPolicy(
            notificationEnabled = snapshot.communicationSafety["enabled"] == true &&
              snapshot.communicationSafety["android_notification_signals"] != false,
            accessibilitySignalsEnabled = snapshot.communicationSafety["android_accessibility_signals"] == true,
            blockThreshold = snapshot.contentBlockThreshold,
          )
        }
      },
      fingerprintKey = store.contentFingerprintKey(),
      eventSink = { event -> store.appendContentRiskEvent(event.toPersistedMap()) },
      classifier = DeterministicContentRiskClassifier(),
    ).also { runtime = it }
  }

  fun refresh(context: Context, trustedKeysJson: String) {
    bootstrap(context, trustedKeysJson)
  }

  /** Drops the process-global runtime so it cannot evaluate a previous child's policy. */
  fun clear() {
    runtime = null
  }

  fun processNotification(
    context: Context,
    trustedKeysJson: String,
    packageName: String,
    isSystemNoise: Boolean,
    notificationCategory: String?,
    channelId: String?,
    title: CharSequence?,
    text: CharSequence?,
  ): MinimizedContentRiskEvent? {
    val active = runtime ?: bootstrap(context, trustedKeysJson) ?: return null
    val event = active.processNotification(
      packageName,
      isSystemNoise,
      notificationCategory,
      channelId,
      title,
      text,
    )
    ContentBlockCoordinator.observe(context, event, foregroundSignal = false)
    return event
  }

  fun processAccessibility(
    context: Context,
    trustedKeysJson: String,
    packageName: String,
    text: CharSequence,
    completeObservation: Boolean,
  ): MinimizedContentRiskEvent? {
    val active = runtime ?: bootstrap(context, trustedKeysJson) ?: return null
    val event = active.processAccessibility(packageName, text)
    // An expired signed policy is neither a safe result nor an approval: preserve a prior block.
    if (active.hasUsablePolicy()) {
      ContentBlockCoordinator.observe(
        context,
        event,
        foregroundSignal = true,
        safeObservationAppRef = packageName.takeIf {
          ContentSafetyObservationGate.mayClearActiveBlock(text, completeObservation, event)
        },
      )
    }
    return event
  }

  fun allowsAccessibilitySignals(context: Context, trustedKeysJson: String): Boolean {
    val active = runtime ?: bootstrap(context, trustedKeysJson) ?: return false
    return active.allowsAccessibilitySignals()
  }
}
