package expo.modules.guardianprotection.vpn

import android.content.Context

internal object GuardianVpnPreferences {
  private const val NAME = "guardian_protection"
  private const val ENABLED = "vpn_enabled"
  private const val ENABLE_REQUESTED_AT = "vpn_enable_requested_at"
  private const val RUNTIME_STATE = "vpn_runtime_state"
  private const val RUNTIME_REASON = "vpn_runtime_reason"
  private const val RUNTIME_OBSERVED_AT = "vpn_runtime_observed_at"

  fun setEnabled(context: Context, enabled: Boolean) {
    context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(ENABLED, enabled)
      .apply()
  }

  fun isEnabled(context: Context): Boolean =
    context.getSharedPreferences(NAME, Context.MODE_PRIVATE).getBoolean(ENABLED, false)

  fun recordEnableRequested(context: Context, recordedAt: Long = System.currentTimeMillis()) {
    context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
      .edit()
      .putLong(ENABLE_REQUESTED_AT, recordedAt)
      .apply()
  }

  fun enableRequestedAt(context: Context): Long? =
    context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
      .getLong(ENABLE_REQUESTED_AT, -1L)
      .takeIf { it >= 0L }

  fun clearEnableRequested(context: Context) {
    val preferences = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
    preferences.edit().remove(ENABLE_REQUESTED_AT).apply()
  }

  /** Removes the prior child's persisted restart intent and status. */
  fun clearChildIdentity(context: Context) {
    context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(ENABLED)
      .remove(ENABLE_REQUESTED_AT)
      .remove(RUNTIME_STATE)
      .remove(RUNTIME_REASON)
      .remove(RUNTIME_OBSERVED_AT)
      .commit()
  }

  fun recordRuntimeStatus(
    context: Context,
    state: GuardianVpnRuntimeState,
    reason: String? = null,
    observedAt: Long = System.currentTimeMillis(),
  ) {
    context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(RUNTIME_STATE, state.name)
      .putString(RUNTIME_REASON, reason)
      .putLong(RUNTIME_OBSERVED_AT, observedAt)
      .apply()
  }

  fun runtimeStatus(context: Context): GuardianVpnRuntimeStatus {
    val preferences = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
    val state = preferences.getString(RUNTIME_STATE, null)
      ?.let { value -> GuardianVpnRuntimeState.entries.firstOrNull { it.name == value } }
      ?: GuardianVpnRuntimeState.NEVER_STARTED
    return GuardianVpnRuntimeStatus(
      state = state,
      reason = preferences.getString(RUNTIME_REASON, null),
      observedAt = preferences.getLong(RUNTIME_OBSERVED_AT, -1L).takeIf { it >= 0L },
    )
  }
}

internal enum class GuardianVpnRuntimeState {
  NEVER_STARTED,
  RUNNING,
  STOPPED,
  REVOKED,
  UNAVAILABLE,
}

internal data class GuardianVpnRuntimeStatus(
  val state: GuardianVpnRuntimeState,
  val reason: String?,
  val observedAt: Long?,
) {
  fun isStale(now: Long, staleAfterMillis: Long = 5 * 60 * 1000L): Boolean =
    state == GuardianVpnRuntimeState.RUNNING && observedAt != null && now - observedAt > staleAfterMillis
}
