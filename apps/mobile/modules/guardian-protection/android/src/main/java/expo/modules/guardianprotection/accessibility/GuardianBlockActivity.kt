package expo.modules.guardianprotection.accessibility

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import expo.modules.guardianprotection.content.ContentBlockCoordinator

class GuardianBlockActivity : Activity() {
  private val isContentBlock: Boolean
    get() = intent.getBooleanExtra(EXTRA_CONTENT_BLOCK, false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(dp(24), dp(24), dp(24), dp(24))
      setBackgroundColor(Color.WHITE)
    }
    content.addView(TextView(this).apply {
      text = if (isContentBlock) "This content needs a parent review." else "This app is unavailable right now."
      textSize = 24f
      setTextColor(Color.BLACK)
      gravity = Gravity.CENTER
    })
    content.addView(TextView(this).apply {
      text = if (isContentBlock) {
        "Guardian did not save the content. You can ask a parent, go back, close the app, or choose something else."
      } else {
        "Your time limit or routine applies. Ask a parent to change the limit or routine if you need more time."
      }
      textSize = 16f
      setTextColor(Color.DKGRAY)
      gravity = Gravity.CENTER
      setPadding(0, dp(24), 0, dp(24))
    })
    if (isContentBlock) addContentRecoveryActions(content) else {
      content.addView(actionButton("Return") { finish() })
    }
    setContentView(content)
  }

  override fun onResume() {
    super.onResume()
    if (isContentBlock) activeContentBlockActivity = this
  }

  override fun onDestroy() {
    if (activeContentBlockActivity === this) activeContentBlockActivity = null
    super.onDestroy()
  }

  override fun onBackPressed() {
    if (isContentBlock) closeToHome() else super.onBackPressed()
  }

  private fun addContentRecoveryActions(content: LinearLayout) {
    content.addView(actionButton("Ask parent") {
      ContentBlockCoordinator.requestParent(
        this,
        intent.getStringExtra(EXTRA_APP).orEmpty(),
        intent.getStringExtra(EXTRA_CONTENT_FINGERPRINT).orEmpty(),
      )
      // A request is never an unlock. Return to Home so the child can choose other content.
      closeToHome()
    })
    content.addView(actionButton("Go back") {
      GuardianAccessibilityService.goBackFromContentBlock()
      finish()
    })
    content.addView(actionButton("Close app") { closeToHome() })
  }

  private fun actionButton(label: String, action: () -> Unit): Button = Button(this).apply {
    text = label
    minHeight = dp(48)
    minimumHeight = dp(48)
    setOnClickListener { action() }
  }

  private fun closeToHome() {
    if (!GuardianAccessibilityService.goHomeFromContentBlock()) {
      startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    finishAndRemoveTask()
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  companion object {
    const val EXTRA_APP = "blocked_app"
    const val EXTRA_REASON = "blocked_reason"
    const val EXTRA_CONTENT_BLOCK = "content_block"
    const val EXTRA_CONTENT_FINGERPRINT = "content_fingerprint"
    @Volatile private var activeContentBlockActivity: GuardianBlockActivity? = null

    fun dismissContentBlock(appRef: String, fingerprint: String) {
      val activity = activeContentBlockActivity ?: return
      if (activity.intent.getStringExtra(EXTRA_APP) != appRef ||
        activity.intent.getStringExtra(EXTRA_CONTENT_FINGERPRINT) != fingerprint
      ) return
      activity.runOnUiThread { activity.finishAndRemoveTask() }
    }

    fun dismissActiveContentBlock() {
      val activity = activeContentBlockActivity ?: return
      activity.runOnUiThread { activity.finishAndRemoveTask() }
    }
  }
}
