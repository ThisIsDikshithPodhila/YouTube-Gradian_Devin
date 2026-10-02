package expo.modules.guardianprotection.inventory

/**
 * Sources that can prove an app was seen. This is deliberately not an installed-app
 * enumeration contract: Android package visibility and user-granted capabilities
 * determine what is observable on any given device.
 */
internal enum class InventorySource {
  LAUNCHER,
  USAGE_STATS,
  NOTIFICATION,
  VPN_ATTRIBUTION,
  ACCESSIBILITY_FOREGROUND,
}

internal object InventoryCoverage {
  const val PARTIAL = "PARTIAL"

  fun sourceLabels(sources: Set<InventorySource>): List<String> =
    sources.map { it.name }.sorted()

  fun detail(sources: Set<InventorySource>): String = when {
    sources.isEmpty() -> "No app source is currently available; inventory is incomplete."
    else -> "Partial, incomplete inventory from ${sourceLabels(sources).joinToString(", ")}. " +
      "Android may hide non-launcher packages and unavailable/revoked signals."
  }
}
