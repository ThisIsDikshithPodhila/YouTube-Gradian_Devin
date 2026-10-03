package expo.modules.guardianprotection.health

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.ComponentName
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.VpnService
import android.net.ConnectivityManager
import android.os.Build
import android.provider.Settings
import android.os.Process
import expo.modules.guardianprotection.accessibility.GuardianAccessibilityService
import expo.modules.guardianprotection.communication.GuardianNotificationListenerService
import expo.modules.guardianprotection.content.ContentSafetyConsentStore
import expo.modules.guardianprotection.content.ContentSafetyServiceRuntime
import expo.modules.guardianprotection.inventory.PackageInventory
import expo.modules.guardianprotection.vpn.GuardianVpnService
import expo.modules.guardianprotection.vpn.GuardianVpnPreferences
import expo.modules.guardianprotection.vpn.GuardianVpnRuntimeState
import expo.modules.guardianprotection.vpn.DohEndpoint
import java.time.Instant

class CapabilityDetector(private val context: Context) {
  fun getCapabilities(): Map<String, Map<String, Any?>> {
    val now = Instant.now().toString()
    val accessibilitySupported = serviceRegistered(GuardianAccessibilityService::class.java)
    val notificationSupported = serviceRegistered(GuardianNotificationListenerService::class.java)
    val accessibilityPermissionGranted = accessibilitySupported && accessibilityGranted()
    val notificationPermissionGranted = notificationSupported && notificationAccessGranted()
    val accessibilityLocalConsentGranted = ContentSafetyConsentStore(context)
      .hasAccessibilityContentConsent()
    val signedPolicyAllowsAccessibility = accessibilityPermissionGranted &&
      accessibilityLocalConsentGranted && ContentSafetyServiceRuntime.allowsAccessibilitySignals(
        context,
        expo.modules.guardianprotection.BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS,
      )
    val accessibilitySignals = AccessibilitySignalCapabilityEvaluator.evaluate(
      accessibilityPermissionGranted,
      accessibilityLocalConsentGranted,
      signedPolicyAllowsAccessibility,
    )
    val vpn = vpnCapability()
    return mapOf(
      "vpn_filtering" to status(vpn.vpnLevel, now, vpn.detail),
      "app_usage" to status(if (usageAccessGranted()) "FULL" else "UNAVAILABLE", now, "Usage Access"),
      "accessibility_signals" to if (accessibilitySupported) status(
        accessibilitySignals.level, now, accessibilitySignals.detail,
      ) else status("UNAVAILABLE", now, "Accessibility content inspection is unavailable in this build."),
      "notification_signals" to status(
        if (notificationPermissionGranted) "BEST_EFFORT" else "UNAVAILABLE",
        now,
        if (!notificationSupported) "Notification-based safety is unavailable in this build."
        else if (notificationPermissionGranted) "Notification metadata is partial and may be unavailable for some apps."
        else "Notification-listener consent is required; no notification content is collected.",
      ),
      "app_blocking" to status(
        if (accessibilityPermissionGranted && GuardianAccessibilityService.isRunning()) "FULL" else "UNAVAILABLE",
        now,
        if (!accessibilitySupported) "App limits are unavailable in this build."
        else if (accessibilityPermissionGranted) "Accessibility app blocking" else "Accessibility permission",
      ),
      "web_filtering" to status(vpn.webLevel, now, vpn.webDetail),
      "communication_risk_signals" to status(
        if (notificationPermissionGranted) "BEST_EFFORT" else "UNAVAILABLE",
        now,
        if (!notificationSupported) "Notification-based safety is unavailable in this build."
        else if (notificationPermissionGranted) {
          "Android notification listener with deterministic rules; raw content is discarded in memory"
        } else {
          "Android notification-listener consent is required; no message content is collected"
        },
      ),
    )
  }

  fun requestVpnPermission(): Map<String, Any?> {
    val intent = VpnService.prepare(context)
    if (intent == null) return mapOf("granted" to true)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
    return mapOf("granted" to false, "reason" to "VPN_CONSENT_REQUIRED")
  }

  fun openUsageAccessSettings() {
    context.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  fun openAccessibilitySettings() {
    if (serviceRegistered(GuardianAccessibilityService::class.java)) {
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  fun openNotificationAccessSettings() {
    if (serviceRegistered(GuardianNotificationListenerService::class.java)) {
      context.startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  fun observedApps(): List<Map<String, Any?>> = PackageInventory(context).observedApps()

  fun markObservedAppReviewed(packageName: String) {
    PackageInventory(context).markReviewed(packageName)
  }

  private fun usageAccessGranted(): Boolean {
    val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    return appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
  }

  private fun accessibilityGranted(): Boolean {
    val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
    return enabled.split(':').any { it.startsWith(context.packageName) }
  }

  private fun notificationAccessGranted(): Boolean {
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
    return enabled.split(':').any { it.startsWith(context.packageName) }
  }

  private fun serviceRegistered(service: Class<*>): Boolean {
    val component = ComponentName(context, service)
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getServiceInfo(component, PackageManager.ComponentInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.getServiceInfo(component, 0)
      }
      true
    } catch (_: PackageManager.NameNotFoundException) {
      false
    }
  }

  private fun vpnCapability(): VpnCapability {
    val endpointConfigured = DohEndpoint.parse(expo.modules.guardianprotection.BuildConfig.GUARDIAN_DOH_URL) != null
    val consentGranted = VpnService.prepare(context) == null
    val enabled = GuardianVpnPreferences.isEnabled(context)
    val runtime = GuardianVpnPreferences.runtimeStatus(context)
    val active = GuardianVpnService.isRunning()
    if (!endpointConfigured) return VpnCapability(
      "UNAVAILABLE",
      "Encrypted DNS transport is not configured. Guardian does not intercept or proxy DNS over plaintext.",
      "UNAVAILABLE",
      "Web filtering is unavailable until an approved encrypted DNS resolver is configured.",
    )
    if (!consentGranted) return VpnCapability(
      "UNAVAILABLE",
      if (enabled) "VPN consent was revoked or another VPN is active. Re-authorize Guardian's VPN to resume protection."
      else "VPN consent is required before Guardian can start protection.",
      "UNAVAILABLE",
      "Web filtering is unavailable because Guardian's VPN is not authorized; a competing VPN may be active.",
    )
    if (!active) {
      if (!enabled && runtime.state in setOf(GuardianVpnRuntimeState.NEVER_STARTED, GuardianVpnRuntimeState.STOPPED)) {
        return VpnCapability(
          "LIMITED",
          "VPN consent and encrypted DNS transport are ready, but protection is not active yet.",
          "UNAVAILABLE",
          "Web filtering is not active yet. Guardian will not intercept DNS until the VPN starts.",
        )
      }
      val detail = when {
        runtime.isStale(System.currentTimeMillis()) ->
          "Protection was last marked active but is not running now. It may have been force-stopped or is awaiting reboot recovery; reopen Guardian."
        runtime.state == GuardianVpnRuntimeState.REVOKED ->
          "VPN permission was revoked. Re-authorize Guardian's VPN to resume protection."
        runtime.state == GuardianVpnRuntimeState.UNAVAILABLE ->
          "Guardian could not establish its VPN (${runtime.reason ?: "unknown reason"}). Another VPN or network condition may be blocking it."
        enabled -> "Protection was requested but the VPN is not running. Reopen Guardian to recover after reboot or a service stop."
        else -> "VPN protection is currently stopped."
      }
      // The transport and consent are still usable even when the service was
      // stopped. Report the inactive state honestly through web_filtering, but
      // keep vpn_filtering recoverable so the child can explicitly retry.
      return VpnCapability("LIMITED", detail, "UNAVAILABLE", "$detail DNS traffic is not being intercepted.")
    }
    val online = connectivityValidated()
    return VpnCapability(
      "LIMITED",
      if (online) "Encrypted DNS destination filtering is active; it does not provide full-device traffic visibility."
      else "VPN is active but the network is offline, captive, or unvalidated; protection may be stale until connectivity returns.",
      "LIMITED",
      if (online) "Encrypted DNS destination filtering is active. HTTPS payloads, DoH/DoT, QUIC, unknown attribution, and unrouted traffic remain partial or unavailable."
      else "Web filtering cannot be confirmed while the network is offline, captive, or unvalidated.",
    )
  }

  private fun connectivityValidated(): Boolean {
    val manager = context.getSystemService(ConnectivityManager::class.java)
    val network = manager.activeNetwork ?: return false
    return manager.getNetworkCapabilities(network)
      ?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
  }

  private fun status(level: String, updatedAt: String, detail: String) = mapOf(
    "level" to level,
    "detail" to detail,
    "updatedAt" to updatedAt,
  )

  private data class VpnCapability(
    val vpnLevel: String,
    val detail: String,
    val webLevel: String,
    val webDetail: String,
  )
}
