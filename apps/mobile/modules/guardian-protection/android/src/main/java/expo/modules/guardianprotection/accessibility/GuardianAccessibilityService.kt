package expo.modules.guardianprotection.accessibility

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.util.Log
import expo.modules.guardianprotection.BuildConfig
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.content.Intent
import android.os.SystemClock
import expo.modules.guardianprotection.content.AccessibilityContentGate
import expo.modules.guardianprotection.content.ContentSafetyConsentStore
import expo.modules.guardianprotection.content.ContentSafetyServiceRuntime
import expo.modules.guardianprotection.content.ContentBlockCoordinator
import expo.modules.guardianprotection.content.ContentSafetyObservationGate
import expo.modules.guardianprotection.inventory.InventorySource
import expo.modules.guardianprotection.inventory.PackageInventory
import expo.modules.guardianprotection.policy.GuardianPolicyRuntime
import expo.modules.guardianprotection.policy.PolicyManager
import expo.modules.guardianprotection.storage.EncryptedPolicyStore
import expo.modules.guardianprotection.usage.UsageCollector
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap

class GuardianAccessibilityService : AccessibilityService() {
  private lateinit var usage: UsageCollector
  private lateinit var inventory: PackageInventory
  private lateinit var contentConsent: ContentSafetyConsentStore
  private val enforcement = BudgetEnforcementController()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val budgetThread = HandlerThread(
    "GuardianBudgetEvaluator",
    Process.THREAD_PRIORITY_BACKGROUND,
  )
  private lateinit var budgetHandler: Handler
  @Volatile private var foregroundPackage: String? = null
  @Volatile private var foregroundCategory: String? = null
  @Volatile private var serviceDestroyed = false
  private val lastContentInspectionAt = ConcurrentHashMap<String, Long>()
  private val budgetTicker = object : Runnable {
    override fun run() {
      val packageName = foregroundPackage ?: return
      if (BuildConfig.DEBUG) Log.d("GuardianBudget", "budget_tick")
      if (!enforcement.isTickerActiveFor(packageName) ||
        !GuardianPolicyRuntime.hasActiveSnapshot() ||
        serviceDestroyed
      ) {
        stopBudgetTicker()
        return
      }
      evaluateForeground(packageName, foregroundCategory ?: inventory.categoryFor(packageName))
      if (enforcement.isTickerActiveFor(packageName)) {
        budgetHandler.postDelayed(this, BUDGET_TICK_INTERVAL_MS)
      }
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    serviceDestroyed = false
    if (!budgetThread.isAlive) budgetThread.start()
    if (!::budgetHandler.isInitialized) budgetHandler = Handler(budgetThread.looper)
    running = true
    instance = this
    val manager = PolicyManager(
      EncryptedPolicyStore(this),
      expo.modules.guardianprotection.BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS,
    )
    GuardianPolicyRuntime.install(manager)
    usage = UsageCollector(this, EncryptedPolicyStore(this))
    inventory = PackageInventory(this)
    contentConsent = ContentSafetyConsentStore(this)
    ContentSafetyServiceRuntime.bootstrap(this, BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    val packageName = event?.packageName?.toString() ?: return
    val eventType = event.eventType
    if (eventType !in setOf(
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
        AccessibilityEvent.TYPE_WINDOWS_CHANGED,
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
      )) return
    if (packageName == packageNameOfGuardian()) return
    if (eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
      updateForeground(packageName)
      ContentBlockCoordinator.reblockIfCurrentForeground(this, packageName)
      val category = foregroundCategory ?: inventory.categoryFor(packageName)
      budgetHandler.post {
        evaluateForeground(packageName, category)
      }
    }
    if (AccessibilityContentGate.shouldInspect(
        contentConsent.hasAccessibilityContentConsent(),
        ContentSafetyServiceRuntime.allowsAccessibilitySignals(
          this,
          BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS,
        ),
        eventType,
      )) {
      inspectActiveWindow(packageName)
    }
  }

  private fun inspectActiveWindow(packageName: String) {
    val now = SystemClock.elapsedRealtime()
    if (lastContentInspectionAt.put(packageName, now)?.let { now - it < CONTENT_DEBOUNCE_MS } == true) {
      return
    }
    var extraction: AccessibilityTextExtraction? = collectActiveWindowText()
    try {
      val candidate = extraction?.text
      if (ContentSafetyObservationGate.shouldProcess(candidate)) {
        // The service runtime has no JS dependency and persists only its minimized output.
        ContentSafetyServiceRuntime.processAccessibility(
          this,
          BuildConfig.GUARDIAN_POLICY_TRUSTED_PUBLIC_KEYS,
          packageName,
          requireNotNull(candidate),
          requireNotNull(extraction).complete,
        )
      }
    } finally {
      extraction = null
    }
  }

  private fun collectActiveWindowText(): AccessibilityTextExtraction {
    val root = rootInActiveWindow ?: return AccessibilityTextExtraction(null, complete = false)
    val deadline = SystemClock.elapsedRealtime() + CONTENT_TRAVERSAL_BUDGET_MS
    val queue = ArrayDeque<AccessibilityNodeInfo>()
    val text = StringBuilder(CONTENT_MAX_CHARS)
    queue.addLast(root)
    var visited = 0
    var complete = true
    try {
      while (queue.isNotEmpty()) {
        if (visited >= CONTENT_MAX_NODES || SystemClock.elapsedRealtime() >= deadline ||
          text.length >= CONTENT_MAX_CHARS
        ) {
          complete = false
          break
        }
        val node = queue.removeFirst()
        try {
          visited += 1
          if (!node.isEditable && !node.isPassword) {
            appendBounded(text, node.text)
            appendBounded(text, node.contentDescription)
          }
          if (visited < CONTENT_MAX_NODES && SystemClock.elapsedRealtime() <= deadline) {
            for (index in 0 until node.childCount) {
              node.getChild(index)?.let(queue::addLast)
            }
          }
        } finally {
          node.recycle()
        }
      }
    } finally {
      if (queue.isNotEmpty()) complete = false
      while (queue.isNotEmpty()) runCatching { queue.removeFirst().recycle() }
    }
    if (visited >= CONTENT_MAX_NODES || SystemClock.elapsedRealtime() >= deadline ||
      text.length >= CONTENT_MAX_CHARS
    ) complete = false
    return AccessibilityTextExtraction(text.takeIf { it.isNotEmpty() }?.toString(), complete)
  }

  private data class AccessibilityTextExtraction(val text: String?, val complete: Boolean)

  private fun appendBounded(destination: StringBuilder, value: CharSequence?) {
    if (value == null || destination.length >= CONTENT_MAX_CHARS) return
    if (destination.isNotEmpty()) destination.append(' ')
    destination.append(value.take(CONTENT_MAX_CHARS - destination.length))
  }

  private fun updateForeground(packageName: String) {
    // Identifier and capability source only.  This deliberately runs before
    // any optional content inspection and never persists Accessibility text.
    if (packageName != packageNameOfGuardian()) {
      inventory.recordObservedPackages(
        setOf(packageName),
        InventorySource.ACCESSIBILITY_FOREGROUND,
      )
    }
    val category = if (packageName == packageNameOfGuardian()) null else inventory.categoryFor(packageName)
    foregroundPackage = packageName
    foregroundCategory = category
    val hasBudget = GuardianPolicyRuntime.hasActiveSnapshot() &&
      GuardianPolicyRuntime.hasApplicableAppBudget(packageName, category)
    when (enforcement.updateForeground(packageName, hasBudget, packageNameOfGuardian())) {
      BudgetEnforcementController.TickerAction.START -> {
        budgetHandler.removeCallbacks(budgetTicker)
        budgetHandler.postDelayed(budgetTicker, BUDGET_TICK_INTERVAL_MS)
      }
      BudgetEnforcementController.TickerAction.STOP -> stopBudgetTicker()
      BudgetEnforcementController.TickerAction.NONE -> Unit
    }
  }

  private fun evaluateForeground(packageName: String, category: String?) {
    if (serviceDestroyed || !enforcement.isCurrentForeground(packageName)) return
    val collector = usage
    runCatching {
      collector.refresh(timezone = null)
      if (serviceDestroyed || !enforcement.isCurrentForeground(packageName)) return@runCatching
      val decision = GuardianPolicyRuntime.evaluateApp(packageName, category, collector.usageToday(packageName, category))
      if (!decision.blocked) return
      stopBudgetTicker()
      val now = System.currentTimeMillis()
      if (!enforcement.shouldReportBlock(packageName, now)) return
      GuardianPolicyRuntime.reportAppBlocked(packageName, decision.reasonCode)
      mainHandler.post {
        if (serviceDestroyed) return@post
        performGlobalAction(GLOBAL_ACTION_BACK)
        mainHandler.postDelayed({
          if (serviceDestroyed) return@postDelayed
          startActivity(
            Intent(this, GuardianBlockActivity::class.java)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
              .putExtra(GuardianBlockActivity.EXTRA_APP, packageName)
              .putExtra(GuardianBlockActivity.EXTRA_REASON, decision.reasonCode),
          )
        }, BLOCK_SURFACE_DELAY_MS)
      }
    }
  }

  override fun onInterrupt() = Unit

  override fun onDestroy() {
    serviceDestroyed = true
    stopBudgetTicker()
    if (budgetThread.isAlive) budgetThread.quitSafely()
    running = false
    if (instance === this) instance = null
    super.onDestroy()
  }

  private fun stopBudgetTicker() {
    if (::budgetHandler.isInitialized) budgetHandler.removeCallbacks(budgetTicker)
    enforcement.cancel()
  }

  private fun clearChildEnforcement() {
    foregroundPackage = null
    foregroundCategory = null
    lastContentInspectionAt.clear()
    stopBudgetTicker()
  }

  private fun packageNameOfGuardian(): String = applicationContext.packageName

  companion object {
    private const val BUDGET_TICK_INTERVAL_MS = 3_000L
    private const val BLOCK_SURFACE_DELAY_MS = 300L
    private const val CONTENT_DEBOUNCE_MS = 750L
    private const val CONTENT_TRAVERSAL_BUDGET_MS = 20L
    private const val CONTENT_MAX_NODES = 80
    private const val CONTENT_MAX_CHARS = 1_200
    @Volatile private var running = false
    @Volatile private var instance: GuardianAccessibilityService? = null

    fun isRunning(): Boolean = running

    fun goBackFromContentBlock(): Boolean =
      instance?.performGlobalAction(GLOBAL_ACTION_BACK) == true

    fun goHomeFromContentBlock(): Boolean =
      instance?.performGlobalAction(GLOBAL_ACTION_HOME) == true

    fun clearChildEnforcement() {
      instance?.clearChildEnforcement()
    }
  }
}
