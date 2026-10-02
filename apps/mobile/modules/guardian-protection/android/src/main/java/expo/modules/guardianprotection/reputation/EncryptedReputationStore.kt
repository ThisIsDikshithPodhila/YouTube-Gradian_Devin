package expo.modules.guardianprotection.reputation

import android.content.Context

class EncryptedReputationStore(
  context: Context,
) : ReputationSnapshotStore {
  private val preferences = context.getSharedPreferences("guardian-reputation", Context.MODE_PRIVATE)

  override fun active(): String? = preferences.getString("active", null)
  override fun previous(): String? = preferences.getString("previous", null)
  override fun appliedVersion(): Long? = preferences.getLong("version", -1L).takeIf { it >= 0 }

  override fun swap(active: String, version: Long) {
    preferences.edit()
      .putString("previous", active())
      .putString("active", active)
      .putLong("version", version)
      .commit()
  }

  override fun clear() {
    preferences.edit().clear().commit()
  }
}
