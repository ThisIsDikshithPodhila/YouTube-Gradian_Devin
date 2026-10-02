package expo.modules.guardianprotection.inventory

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.content.pm.LauncherApps
import android.app.NotificationManager
import java.time.Instant

class PackageInventory(private val context: Context) {
  private val preferences = context.getSharedPreferences("guardian-inventory", Context.MODE_PRIVATE)

  /** Inventory belongs to the paired child and must not cross a re-pair boundary. */
  fun clear() {
    preferences.edit().clear().commit()
  }

  fun observedApps(): List<Map<String, Any?>> {
    val packageManager = context.packageManager
    recordObservedPackages(launcherPackages(), InventorySource.LAUNCHER)
    recordObservedPackages(notificationPackages(), InventorySource.NOTIFICATION)
    val packages = observedPackageNames()
    val newDetector = NewAppDetector(
      preferences.getStringSet("known-packages", emptySet()).orEmpty().toMutableSet(),
      preferences.getStringSet("pending-packages", emptySet()).orEmpty().toMutableSet(),
    )
    val newlyObserved = newDetector.newPackages(packages)
    preferences.edit()
      .putStringSet("known-packages", newDetector.knownPackages())
      .putStringSet("pending-packages", newDetector.pendingPackages())
      .apply()
    return packages.map { packageName ->
      val application = runCatching { packageManager.getApplicationInfo(packageName, 0) }.getOrNull()
      val sources = sourcesFor(packageName)
      val icon = application?.icon?.takeIf { it != 0 }?.let {
        Uri.Builder()
          .scheme("android.resource")
          .authority(packageName)
          .appendPath(it.toString())
          .build()
          .toString()
      }
      val packageInfo = runCatching { packageManager.getPackageInfo(packageName, 0) }.getOrNull()
      mapOf(
        "platformAppId" to packageName,
        "displayName" to (application?.let { packageManager.getApplicationLabel(it).toString() } ?: packageName),
        "category" to (application?.let(::category) ?: "UNKNOWN"),
        "iconUri" to icon,
        "newlyObserved" to newlyObserved.contains(packageName),
        "observedAt" to observedAt(packageName),
        "firstSeenAt" to firstSeenAt(packageName),
        "lastSeenAt" to observedAt(packageName),
        "capabilitySources" to InventoryCoverage.sourceLabels(sources),
        "inventoryCompleteness" to InventoryCoverage.PARTIAL,
        "inventoryDetail" to InventoryCoverage.detail(sources),
        "installationState" to if (application == null) "UNINSTALLED_OR_NOT_VISIBLE" else "INSTALLED",
        "versionName" to packageInfo?.versionName,
        "updatedAt" to packageInfo?.lastUpdateTime?.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).toString() },
        "policyState" to "UNKNOWN",
        "riskState" to "UNKNOWN",
      )
    }.sortedWith(compareBy<Map<String, Any?>>(
      { (it["displayName"] as? String)?.lowercase() ?: "" },
      { it["platformAppId"] as String },
    ))
  }

  /** Records package identifiers and source only; it never stores notification text or flow payloads. */
  internal fun recordObservedPackages(
    packages: Collection<String>,
    source: InventorySource,
    observedAtMillis: Long = System.currentTimeMillis(),
  ) {
    val cleanPackages = packages.filter { it.isNotBlank() && it != context.packageName }.toSet()
    if (cleanPackages.isEmpty()) return
    val editor = preferences.edit()
    cleanPackages.forEach { packageName ->
      val sourceKey = sourcesKey(packageName)
      val sources = preferences.getStringSet(sourceKey, emptySet()).orEmpty().toMutableSet()
      sources.add(source.name)
      editor.putStringSet(sourceKey, sources)
      if (!preferences.contains(firstSeenKey(packageName))) editor.putLong(firstSeenKey(packageName), observedAtMillis)
      editor.putLong(lastSeenKey(packageName), observedAtMillis)
    }
    val observed = preferences.getStringSet("observed-packages", emptySet()).orEmpty().toMutableSet()
    observed.addAll(cleanPackages)
    editor.putStringSet("observed-packages", observed).apply()
  }

  fun markReviewed(packageName: String) {
    val known = preferences.getStringSet("known-packages", emptySet()).orEmpty().toMutableSet()
    val pending = preferences.getStringSet("pending-packages", emptySet()).orEmpty().toMutableSet()
    val detector = NewAppDetector(known, pending)
    detector.markReviewed(packageName)
    preferences.edit()
      .putStringSet("known-packages", detector.knownPackages())
      .putStringSet("pending-packages", detector.pendingPackages())
      .apply()
  }

  fun category(packageName: String): String =
    runCatching { category(packageManager().getApplicationInfo(packageName, 0)) }.getOrDefault("UNKNOWN")

  fun categoryFor(packageName: String): String = category(packageName)

  private fun launcherPackages(): Set<String> = runCatching {
    val launcherApps = context.getSystemService(LauncherApps::class.java)
    launcherApps.getActivityList(null, Process.myUserHandle())
      .map { it.applicationInfo.packageName }
      .toSet()
  }.getOrDefault(emptySet())

  private fun notificationPackages(): Set<String> = runCatching {
    context.getSystemService(NotificationManager::class.java)
      .activeNotifications
      .mapNotNull { it.packageName?.takeIf(String::isNotBlank) }
      .toSet()
  }.getOrDefault(emptySet())

  private fun observedPackageNames(): List<String> = (
    preferences.getStringSet("observed-packages", emptySet()).orEmpty() +
      preferences.getStringSet("known-packages", emptySet()).orEmpty()
    )
    .filter(String::isNotBlank)
    .toSet()
    .sorted()

  private fun sourcesFor(packageName: String): Set<InventorySource> = preferences
    .getStringSet(sourcesKey(packageName), emptySet())
    .orEmpty()
    .mapNotNull { value -> InventorySource.entries.firstOrNull { it.name == value } }
    .toSet()

  private fun observedAt(packageName: String): String = timestamp(lastSeenKey(packageName))
  private fun firstSeenAt(packageName: String): String = timestamp(firstSeenKey(packageName))
  private fun timestamp(key: String): String = preferences.getLong(key, System.currentTimeMillis())
    .let { Instant.ofEpochMilli(it).toString() }
  private fun sourcesKey(packageName: String) = "sources:$packageName"
  private fun firstSeenKey(packageName: String) = "first-seen:$packageName"
  private fun lastSeenKey(packageName: String) = "last-seen:$packageName"

  private fun packageManager(): PackageManager = context.packageManager

  private fun category(application: ApplicationInfo): String =
    when {
      application.category == ApplicationInfo.CATEGORY_GAME -> "GAMES"
      application.category == ApplicationInfo.CATEGORY_AUDIO -> "MUSIC"
      application.category == ApplicationInfo.CATEGORY_VIDEO -> "STREAMING_VIDEO"
      application.category == ApplicationInfo.CATEGORY_IMAGE -> "CREATIVE"
      (application.flags and ApplicationInfo.FLAG_SYSTEM) != 0 -> "SYSTEM"
      else -> "UNKNOWN"
    }
}
