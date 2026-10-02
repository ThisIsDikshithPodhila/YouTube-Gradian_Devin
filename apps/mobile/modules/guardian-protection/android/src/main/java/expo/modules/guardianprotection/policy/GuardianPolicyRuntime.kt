package expo.modules.guardianprotection.policy

import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ConcurrentHashMap
import expo.modules.guardianprotection.accessibility.BudgetApplicability
import expo.modules.guardianprotection.usage.UsageContext
import expo.modules.guardianprotection.usage.UsageThresholdEvent
import expo.modules.guardianprotection.usage.UsageThresholdTracker
import expo.modules.guardianprotection.reputation.ReputationManager
import expo.modules.guardianprotection.content.ContentRiskSeverity

object GuardianPolicyRuntime {
  private var manager: PolicyManager? = null
  private var reputation: ReputationManager? = null
  private val listeners = CopyOnWriteArraySet<Listener>()
  private val lastBlockedAt = ConcurrentHashMap<String, Long>()
  private val thresholds = UsageThresholdTracker()

  fun install(policyManager: PolicyManager) {
    manager = policyManager
    lastBlockedAt.clear()
    thresholds.clear()
  }

  fun installReputation(reputationManager: ReputationManager) {
    reputation = reputationManager
  }

  /** Removes every child-specific in-memory enforcement reference before re-pairing. */
  fun clear() {
    manager = null
    reputation = null
    listeners.clear()
    lastBlockedAt.clear()
    thresholds.clear()
  }

  fun hasActiveSnapshot(): Boolean = manager?.activeSnapshot() != null

  fun contentBlockThreshold(): ContentRiskSeverity? = manager?.activeSnapshot()?.contentBlockThreshold

  fun hasApplicableAppBudget(packageName: String, category: String?): Boolean =
    manager?.activeSnapshot()?.let {
      BudgetApplicability.hasApplicableAppBudget(it, packageName, category)
    } == true

  fun addListener(listener: Listener) {
    listeners += listener
  }

  fun evaluateDomain(domain: String, destinationIp: String? = null): DomainDecision {
    val current = manager?.activeSnapshot()
      ?: return DomainDecision(false, "POLICY_UNAVAILABLE")
    val reputationEntry = reputation?.lookup(domain)
    val pendingUntil = if (reputationEntry == null) {
      reputation?.markPending(domain)?.let { java.time.Instant.ofEpochMilli(it) }
    } else {
      null
    }
    val result = current.let {
      PolicyEvaluator().evaluate(
        it,
        PolicyContext(
          now = java.time.Instant.now(),
          childId = "",
          packageName = null,
          domain = domain,
          destinationIp = destinationIp,
          usageTodayMs = 0,
          sessionMs = null,
          activeRoutineIds = emptySet(),
          currentManualRoutineId = (it.basePolicy["current_manual_routine_id"] as? String),
          signal = null,
          reputationVerdict = reputationEntry?.verdict,
          reputationPendingUntil = pendingUntil,
        ),
      )
    }
    val category = current.domainTrie.match(domain)?.get("category") as? String
    return DomainDecision(result.action == "BLOCK" || result.action == "LIMIT_REACHED", result.reasonCode, category)
  }

  fun evaluateApp(
    packageName: String,
    category: String?,
    usage: UsageContext,
  ): AppDecision {
    val current = manager?.activeSnapshot()
      ?: return AppDecision(false, "POLICY_UNAVAILABLE", null)
    val now = java.time.Instant.now()
    val decision = PolicyEvaluator().evaluate(
      current,
      PolicyContext(
        now = now,
        childId = "",
        packageName = packageName,
        domain = null,
        destinationIp = null,
        usageTodayMs = usage.appMillis,
        sessionMs = null,
        activeRoutineIds = emptySet(),
        currentManualRoutineId = (current.basePolicy["current_manual_routine_id"] as? String),
        signal = null,
        category = category,
        deviceUsageTodayMs = usage.deviceMillis,
      ),
    )
    val targetRef = packageName
    val appRule = current.appRules[packageName]
    val categoryRule = category?.let { current.categoryRules[it] }
    val rule = appRule ?: categoryRule
    val limitMinutes = (rule?.get("daily_minutes") as? Number)?.toLong()
      ?: (current.basePolicy["daily_device_budget_minutes"] as? Number)?.toLong()
    if (limitMinutes != null) {
      val used = when {
        appRule != null -> usage.appMillis
        categoryRule != null -> usage.categoryMillis
        else -> usage.deviceMillis
      }
      val zone = current.basePolicy["timezone"] as? String ?: "UTC"
      val key = "${now.atZone(java.time.ZoneId.of(zone)).toLocalDate()}:$targetRef"
      when (thresholds.update(key, used, limitMinutes * 60_000L)) {
        UsageThresholdEvent.WARNING -> reportTimeWarning(
          targetRef,
          ((limitMinutes * 60_000L - used).coerceAtLeast(0L)) / 1000,
        )
        UsageThresholdEvent.EXPIRED -> reportTimeExpired(targetRef)
        UsageThresholdEvent.NONE -> Unit
      }
    }
    return AppDecision(
      blocked = decision.action == "BLOCK" || decision.action == "LIMIT_REACHED",
      reasonCode = decision.reasonCode,
      policyRuleId = decision.policyRuleId,
    )
  }

  fun reportAppBlocked(packageName: String, reasonCode: String) {
    listeners.forEach { it.onAppBlocked(packageName, reasonCode) }
  }

  fun reportTimeWarning(targetRef: String, remainingSeconds: Long) {
    listeners.forEach { it.onTimeWarning(targetRef, remainingSeconds) }
  }

  fun reportTimeExpired(targetRef: String) {
    listeners.forEach { it.onTimeExpired(targetRef) }
  }

  fun reportBlocked(domain: String, reasonCode: String, category: String? = null, appRef: String? = null) {
    val now = System.currentTimeMillis()
    val previous = lastBlockedAt.putIfAbsent(domain, now)
    if (previous != null && now - previous < BLOCK_EVENT_DEDUP_MS) return
    if (previous != null) lastBlockedAt[domain] = now
    listeners.forEach { it.onWebBlocked(domain, category, appRef, reasonCode) }
  }

  fun reportFailure(reason: String) {
    listeners.forEach { it.onVpnFailure(reason) }
  }

  data class DomainDecision(val blocked: Boolean, val reasonCode: String, val category: String? = null)
  data class AppDecision(val blocked: Boolean, val reasonCode: String, val policyRuleId: String?)

  interface Listener {
    fun onWebBlocked(domain: String, category: String?, appRef: String?, reasonCode: String)
    fun onVpnFailure(reason: String)
    fun onAppBlocked(packageName: String, reasonCode: String) {}
    fun onTimeWarning(targetRef: String, remainingSeconds: Long) {}
    fun onTimeExpired(targetRef: String) {}
  }

  private const val BLOCK_EVENT_DEDUP_MS = 60_000L
}
