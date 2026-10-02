package expo.modules.guardianprotection

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.guardianprotection.health.CapabilityDetector
import expo.modules.guardianprotection.policy.PolicyManager
import expo.modules.guardianprotection.policy.GuardianPolicyRuntime
import expo.modules.guardianprotection.storage.EncryptedPolicyStore
import expo.modules.guardianprotection.reputation.EncryptedReputationStore
import expo.modules.guardianprotection.reputation.ReputationManager
import expo.modules.guardianprotection.policy.PolicyVerifier
import expo.modules.guardianprotection.usage.UsageCollector
import expo.modules.guardianprotection.vpn.GuardianVpnService
import expo.modules.guardianprotection.vpn.GuardianVpnPreferences
import expo.modules.guardianprotection.vpn.UserInitiatedEnableIntent
import expo.modules.guardianprotection.vpn.UserInitiatedEnableIntentAction
import expo.modules.guardianprotection.vpn.ProtectionStatusChange
import expo.modules.guardianprotection.vpn.ProtectionStatusEvents
import expo.modules.guardianprotection.inventory.PackageInventory
import expo.modules.guardianprotection.content.ContentSafetyConsentStore
import expo.modules.guardianprotection.content.ContentSafetyServiceRuntime
import expo.modules.guardianprotection.content.ContentBlockCoordinator
import expo.modules.guardianprotection.content.ContentApproval
import expo.modules.guardianprotection.accessibility.GuardianAccessibilityService
import expo.modules.guardianprotection.accessibility.GuardianBlockActivity
import expo.modules.guardianprotection.observability.GuardianPerformanceMetrics
import android.util.Log
import android.os.SystemClock
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

class GuardianProtectionModule : Module() {
  private val store by lazy { EncryptedPolicyStore(requireNotNull(appContext.reactContext)) }
  private val policyManager by lazy {
    PolicyManager(
      store,
      BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS,
      BuildConfig.GUARDIAN_POLICY_KEY_ID,
    )
  }
  private val reputationManager by lazy {
    val verifier = PolicyVerifier(parseTrustedKeys(BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS))
    ReputationManager(EncryptedReputationStore(requireNotNull(appContext.reactContext))) { verifier.verify(it) }
  }
  private val capabilities by lazy { CapabilityDetector(requireNotNull(appContext.reactContext)) }
  private val usage by lazy { UsageCollector(requireNotNull(appContext.reactContext), store) }
  private val lastCapabilities = AtomicReference<Map<String, Map<String, Any?>>?>()
  private val moduleCreatedAtMillis = SystemClock.elapsedRealtime()

  override fun definition() = ModuleDefinition {
    Name("GuardianProtection")
    Events("onGuardianEvent")
    OnCreate {
      ProtectionStatusEvents.setListener(::emitProtectionStatusChanged)
      appContext.reactContext?.let { GuardianVpnService.startWithPersistedPolicy(it) }
    }
    OnDestroy {
      ProtectionStatusEvents.setListener(null)
    }
    OnActivityEntersForeground {
      GuardianPerformanceMetrics.recordStartup(SystemClock.elapsedRealtime() - moduleCreatedAtMillis)
      appContext.reactContext?.let {
        val requestedAt = GuardianVpnPreferences.enableRequestedAt(it)
        var startedFromRequest = false
        when (UserInitiatedEnableIntent.action(
          recordedAt = requestedAt,
          now = System.currentTimeMillis(),
          consentGranted = android.net.VpnService.prepare(it) == null,
        )) {
          UserInitiatedEnableIntentAction.CONSUME -> {
            if (GuardianVpnService.startWithUserInitiatedPolicy(it)) {
              GuardianVpnPreferences.clearEnableRequested(it)
              startedFromRequest = true
            }
          }
          UserInitiatedEnableIntentAction.EXPIRE -> {
            if (requestedAt != null) GuardianVpnPreferences.clearEnableRequested(it)
          }
          UserInitiatedEnableIntentAction.KEEP -> Unit
        }
        if (!startedFromRequest) GuardianVpnService.startWithPersistedPolicy(it)
      }
      reportCapabilityChanges(capabilities.getCapabilities())
    }

    AsyncFunction("getCapabilities") {
      reportCapabilityChanges(capabilities.getCapabilities())
    }
    AsyncFunction("getProtectionStatus") {
      policyManager.protectionStatus(reportCapabilityChanges(capabilities.getCapabilities()))
    }
    AsyncFunction("getPerformanceMetrics") {
      GuardianPerformanceMetrics.snapshot()
    }
    AsyncFunction("requestVpnPermission") {
      appContext.reactContext?.let { GuardianVpnPreferences.recordEnableRequested(it) }
      val result = capabilities.requestVpnPermission()
      appContext.reactContext?.let { context ->
        if (result["granted"] == true) {
          if (GuardianVpnService.startWithUserInitiatedPolicy(context)) {
            GuardianVpnPreferences.clearEnableRequested(context)
          }
        }
      }
      result
    }
    AsyncFunction("openUsageAccessSettings") {
      capabilities.openUsageAccessSettings()
    }
    AsyncFunction("openAccessibilitySettings") {
      capabilities.openAccessibilitySettings()
    }
    AsyncFunction("setAccessibilityContentConsent") { granted: Boolean ->
      val context = requireNotNull(appContext.reactContext)
      ContentSafetyConsentStore(context).setAccessibilityContentConsent(granted)
      reportCapabilityChanges(capabilities.getCapabilities())
      mapOf("granted" to granted)
    }
    AsyncFunction("setContentDeviceId") { deviceId: String ->
      store.setContentDeviceId(deviceId)
    }
    AsyncFunction("clearChildIdentity") {
      val context = requireNotNull(appContext.reactContext)
      resetChildIdentity(context)
    }
    AsyncFunction("applyContentApprovals") { approvals: List<Map<String, Any?>> ->
      val parsed = approvals.map { approval ->
        ContentApproval(
          deviceId = approval["device_id"] as? String ?: throw IllegalArgumentException("Invalid approval device"),
          appRef = approval["app_ref"] as? String ?: throw IllegalArgumentException("Invalid approval app"),
          fingerprint = approval["fingerprint"] as? String ?: throw IllegalArgumentException("Invalid approval fingerprint"),
          expiresAt = Instant.parse(approval["expires_at"] as? String ?: throw IllegalArgumentException("Invalid approval expiry")),
        )
      }
      ContentBlockCoordinator.applyApprovals(requireNotNull(appContext.reactContext), parsed)
    }
    AsyncFunction("getPendingContentRiskEvents") {
      store.pendingContentRiskEvents()
    }
    AsyncFunction("acknowledgeContentRiskEvent") { signalSource: String, appRef: String, fingerprint: String ->
      store.acknowledgeContentRiskEvent(signalSource, appRef, fingerprint)
    }
    AsyncFunction("getPendingContentReviewRequests") {
      store.pendingContentReviewRequests()
    }
    AsyncFunction("acknowledgeContentReviewRequest") { appRef: String, fingerprint: String ->
      store.acknowledgeContentReviewRequest(appRef, fingerprint)
    }
    AsyncFunction("openNotificationAccessSettings") {
      capabilities.openNotificationAccessSettings()
    }
    AsyncFunction("startProtection") {
      GuardianPolicyRuntime.install(policyManager)
      GuardianPolicyRuntime.installReputation(reputationManager)
      GuardianPolicyRuntime.addListener(eventListener)
      if (capabilities.getCapabilities()["app_usage"]?.get("level") == "FULL") {
        usage.refresh()
      }
      GuardianVpnService.start(requireNotNull(appContext.reactContext))
    }
    AsyncFunction("stopProtection") {
      GuardianVpnService.stop(requireNotNull(appContext.reactContext))
    }
    AsyncFunction("applyPolicyBundle") { bundle: Map<String, Any?> ->
      GuardianPolicyRuntime.install(policyManager)
      val result = policyManager.apply(bundle)
      if (result["applied"] == true) {
        ContentSafetyServiceRuntime.refresh(
          requireNotNull(appContext.reactContext),
          BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS,
        )
        emit(mapOf(
          "type" to "POLICY_APPLIED",
          "version" to result["policyVersion"],
        ))
      }
      result
    }
    AsyncFunction("applyReputationBundle") { bundle: Map<String, Any?> ->
      GuardianPolicyRuntime.installReputation(reputationManager)
      val result = reputationManager.apply(bundle)
      emit(mapOf(
        "type" to "REPUTATION_STATUS_CHANGED",
        "version" to result.version,
        "reason" to result.reason,
      ))
      mapOf(
        "applied" to result.applied,
        "version" to result.version,
        "reason" to result.reason,
        "entryCount" to result.entryCount,
        "encodedBytes" to result.encodedBytes,
        "applyMillis" to result.applyMillis,
        "estimatedMemoryBytes" to result.estimatedMemoryBytes,
      )
    }
    AsyncFunction("getReputationStatus") {
      mapOf(
        "version" to reputationManager.version(),
        "entryCount" to (reputationManager.snapshot()?.entries?.size ?: 0),
        "pending" to (reputationManager.snapshot()?.entries?.values?.count { it.verdict == "UNKNOWN" } ?: 0),
      )
    }
    AsyncFunction("getUsageSummary") { range: Map<String, Any?> ->
      if (capabilities.getCapabilities()["app_usage"]?.get("level") == "FULL") {
        usage.refresh()
      }
      usage.summary(range)
    }
    AsyncFunction("getObservedApps") {
      capabilities.observedApps()
    }
    AsyncFunction("markObservedAppReviewed") { packageName: String ->
      capabilities.markObservedAppReviewed(packageName)
    }
  }

  private fun parseTrustedKeys(value: String): Map<String, String> {
    return runCatching {
      val json = org.json.JSONObject(value)
      json.keys().asSequence().associateWith { key -> json.getString(key) }
    }.getOrDefault(emptyMap())
  }

  private fun resetChildIdentity(context: android.content.Context) {
    ChildProtectionReset(
      stopVpn = { GuardianVpnService.stop(context) },
      clearVpnState = { GuardianVpnPreferences.clearChildIdentity(context) },
      clearAccessibilityEnforcement = GuardianAccessibilityService::clearChildEnforcement,
      dismissContentBlock = GuardianBlockActivity::dismissActiveContentBlock,
      clearContentPresentation = ContentBlockCoordinator::clearPresentationState,
      clearPolicyRuntime = GuardianPolicyRuntime::clear,
      clearContentRuntime = ContentSafetyServiceRuntime::clear,
      clearPersistedPolicy = policyManager::clear,
      clearReputation = reputationManager::clear,
      clearPackageInventory = { PackageInventory(context).clear() },
      revokeContentConsent = { ContentSafetyConsentStore(context).setAccessibilityContentConsent(false) },
    ).reset()
  }

  private fun emit(event: Map<String, Any?>) {
    GuardianPerformanceMetrics.recordBridgeEvent()
    val correlationId = UUID.randomUUID().toString()
    Log.i("GuardianEvents", "event_type=${event["type"]} correlation_id=$correlationId")
    sendEvent("onGuardianEvent", event + ("correlationId" to correlationId))
  }

  private val eventListener = object : GuardianPolicyRuntime.Listener {
    override fun onWebBlocked(domain: String, category: String?, appRef: String?, reasonCode: String) {
      emit(mapOf(
        "type" to "WEB_BLOCKED",
        "domain" to domain,
        "category" to category,
        "appRef" to appRef,
        "reasonCode" to reasonCode,
      ))
    }

    override fun onVpnFailure(reason: String) {
      ProtectionStatusEvents.emit(false, reason)
    }

    override fun onAppBlocked(packageName: String, reasonCode: String) {
      emit(mapOf(
        "type" to "APP_BLOCKED",
        "appRef" to packageName,
        "reasonCode" to reasonCode,
      ))
    }

    override fun onTimeWarning(targetRef: String, remainingSeconds: Long) {
      emit(mapOf(
        "type" to "TIME_WARNING",
        "targetRef" to targetRef,
        "remainingSeconds" to remainingSeconds,
      ))
    }

    override fun onTimeExpired(targetRef: String) {
      emit(mapOf(
        "type" to "TIME_EXPIRED",
        "targetRef" to targetRef,
      ))
    }
  }

  private fun emitProtectionStatusChanged(change: ProtectionStatusChange) {
    if (appContext.reactContext == null) return
    val currentCapabilities = capabilities.getCapabilities()
    reportCapabilityChanges(currentCapabilities)
    val nonFull = currentCapabilities.filterValues { it["level"] != "FULL" }.keys
    val health = when {
      !change.active -> "DISABLED"
      nonFull.isEmpty() -> "HEALTHY"
      else -> "DEGRADED"
    }
    emit(mapOf(
      "type" to "PROTECTION_STATUS_CHANGED",
      "status" to mapOf(
        "active" to change.active,
        "health" to health,
        "policyVersion" to policyManager.activeSnapshot()?.policyVersion,
        "observedAt" to Instant.now().toString(),
        "details" to (change.details ?: nonFull.takeIf { it.isNotEmpty() }?.joinToString(",")),
      ),
    ))
  }

  private fun reportCapabilityChanges(current: Map<String, Map<String, Any?>>): Map<String, Map<String, Any?>> {
    val previous = lastCapabilities.getAndSet(current)
    CapabilityStateComparison.changedCapabilities(previous, current).forEach { capability ->
      emit(mapOf(
        "type" to "PERMISSION_STATE_CHANGED",
        "capability" to capability,
        "state" to (current[capability]?.get("level") as? String ?: "UNAVAILABLE"),
      ))
    }
    return current
  }
}
