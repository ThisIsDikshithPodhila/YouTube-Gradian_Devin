import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Alert, AppState, Platform, Text } from "react-native";
import { ApiError, api, sessionStorage } from "@/api/client";
import { useFamilySync } from "@/hooks/use-family-sync";
import { useNetworkStatus } from "@/state/network";
import {
  DataState,
  PrimaryButton,
  ProtectionRemovedState,
  ScreenScaffold,
  SecondaryButton,
  SectionSurface,
} from "@/design-system";
import { GuardianProtection } from "../../../modules/guardian-protection/src";
import type { GuardianNativeEvent } from "@guardian/contracts";

const ACCESSIBILITY_SIGNALS_DISABLED_BY_PARENT_POLICY =
  "Disabled by the current signed parent policy. Ask a parent to enable Android content-safety signals.";

export function appUsageEvents(byTarget: Record<string, number>, occurredAt: string) {
  return Object.entries(byTarget)
    .filter(([target, seconds]) => target.startsWith("APP:") && seconds > 0)
    .map(([target, seconds]) => ({
      event_type: "APP_USAGE",
      occurred_at: occurredAt,
      app_ref: target.slice("APP:".length),
      duration_seconds: Math.min(Math.round(seconds), 86400),
    }));
}

function isRevokedDeviceError(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 401 || error.status === 403;
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = error.status;
  return status === 401 || status === 403;
}

export default function ChildHomeRoute() {
  const router = useRouter();
  const policy = useQuery({ queryKey: ["device-policy"], queryFn: () => api.policy() });
  const { isOffline } = useNetworkStatus();
  const [familyId, setFamilyId] = useState<string>();
  const revoked = isRevokedDeviceError(policy.error);
  const [protectionMessage, setProtectionMessage] = useState("Checking web protection…");
  const [canRetryProtection, setCanRetryProtection] = useState(false);
  const [accessibilitySignals, setAccessibilitySignals] = useState<{
    level: string;
    detail?: string | null;
  } | null>(null);
  const [appBlockingAvailable, setAppBlockingAvailable] = useState<boolean | null>(null);
  const [blockedEvent, setBlockedEvent] = useState<Extract<GuardianNativeEvent, { type: "WEB_BLOCKED" }> | null>(null);
  const [blockedEventCount, setBlockedEventCount] = useState(0);
  const [appBlockedMessage, setAppBlockedMessage] = useState<string | null>(null);
  const [timeMessage, setTimeMessage] = useState<string | null>(null);
  const [reputationMessage, setReputationMessage] = useState<string | null>(null);
  const [acknowledgedVersion, setAcknowledgedVersion] = useState<number | null>(null);
  const usageUploaded = useRef(false);
  const inventoryUploaded = useRef(false);
  const policyUnavailable = isOffline || policy.isError;
  const policyState = policy.isLoading
    ? "loading"
    : policyUnavailable
      ? "stale"
      : "loaded";
  const policyStateMessage = policy.data
    ? undefined
    : isOffline
      ? "You're offline. Last-known data may be shown."
      : "We couldn't load this data.";

  const syncReputation = async () => {
    const status = await GuardianProtection.getReputationStatus();
    const response = await api.reputation(status.version ?? 0);
    const bundles = response.bundle ? [response.bundle, ...response.deltas] : response.deltas;
    for (const bundle of bundles) {
      const result = await GuardianProtection.applyReputationBundle(bundle);
      if (!result.applied && result.reason === "DELTA_GAP") {
        const full = await api.reputation(0);
        if (full.bundle) {
          const fallback = await GuardianProtection.applyReputationBundle(full.bundle);
          if (!fallback.applied) throw new Error(`Reputation full bundle rejected: ${fallback.reason}`);
        }
        break;
      }
      if (!result.applied && result.reason !== "VERSION_NOT_MONOTONIC") {
        throw new Error(`Reputation bundle rejected: ${result.reason}`);
      }
    }
  };

  const flushContentReviewOutbox = async () => {
    const requests = await GuardianProtection.getPendingContentReviewRequests();
    for (const request of requests) {
      await api.createRequest(
        request,
        `content-review:${request.content_review.app_ref}:${request.content_review.fingerprint}`,
      );
      await GuardianProtection.acknowledgeContentReviewRequest(
        request.content_review.app_ref,
        request.content_review.fingerprint,
      );
    }
  };

  const requestAccessibilityContentConsent = () => Alert.alert(
    "Optional content-safety inspection",
    "Guardian can inspect only titles, headings, and media labels exposed in the active window. It processes that text briefly on this device, excludes editable fields and passwords, and immediately discards it. It does not capture keystrokes, click history, screenshots, messages, or full Accessibility trees. Some apps use inaccessible custom views, so coverage is partial.",
    [
      {
        text: "Keep off",
        style: "cancel",
        onPress: () => { void GuardianProtection.setAccessibilityContentConsent(false); },
      },
      {
        text: "Continue to Accessibility settings",
        onPress: () => {
          void GuardianProtection.setAccessibilityContentConsent(true)
            .then(() => GuardianProtection.openAccessibilitySettings())
            .catch(() => undefined);
        },
      },
    ],
  );

  const refreshNativeProtection = async () => {
    const [status, capabilities] = await Promise.all([
      GuardianProtection.getProtectionStatus(),
      GuardianProtection.getCapabilities(),
    ]);
    const vpnCapability = capabilities.vpn_filtering;
    const webCapability = capabilities.web_filtering;
    const appBlockingCapability = capabilities.app_blocking;
    const accessibilityCapability = capabilities.accessibility_signals;
    const vpnReady = vpnCapability.level === "LIMITED" || vpnCapability.level === "FULL";
    const webActive = webCapability.level === "LIMITED" || webCapability.level === "FULL";
    const vpnActive = status.active && vpnReady;
    setCanRetryProtection(!vpnActive && vpnReady);
    setProtectionMessage(
      !vpnActive
        ? vpnReady
          ? (vpnCapability.detail ?? "Web protection is unavailable.")
          : (vpnCapability.detail ?? "Web protection permission is required.")
        : webActive
          ? "Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian."
          : "Web protection is active, but coverage may be limited. Some traffic may bypass Guardian.",
    );
    setAppBlockingAvailable(appBlockingCapability.level === "FULL");
    setAccessibilitySignals(accessibilityCapability);
  };

  useEffect(() => {
    let mounted = true;
    void sessionStorage.getFamilyId()
      .then((value) => {
        if (mounted) setFamilyId(value ?? undefined);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (__DEV__ && Platform.OS === "android") {
      void GuardianProtection.getPerformanceMetrics()
        .then((metrics) => {
          console.info("GUARDIAN_PERFORMANCE_METRICS", JSON.stringify(metrics));
        })
        .catch(() => {
          console.info("GUARDIAN_PERFORMANCE_METRICS_UNAVAILABLE");
        });
    }
  }, []);

  useFamilySync(familyId, "child");

  useEffect(() => {
    const subscription = GuardianProtection.subscribe((event) => {
      if (__DEV__ && Platform.OS === "android") {
        console.info(
          "GUARDIAN_EVENT_CORRELATION",
          JSON.stringify({ type: event.type, correlationId: event.correlationId }),
        );
      }
      if (event.type === "WEB_BLOCKED") {
        setBlockedEvent(event);
        setBlockedEventCount((count) => count + 1);
        void api.ingestEvents([{
          event_type: event.type,
          occurred_at: new Date().toISOString(),
          app_ref: event.appRef ?? null,
          domain: event.domain,
          category: event.category ?? null,
        }], event.correlationId).catch(() => undefined);
        if (event.domain && event.reasonCode.startsWith("REPUTATION_PENDING")) {
          void api.classifyDomain(event.domain)
            .then(() => syncReputation())
            .catch(() => undefined);
        }
      }
      if (event.type === "SAFETY_EVENT") {
        void api.ingestEvents([{
          event_type: `SAFETY_${event.category}`,
          occurred_at: event.occurredAt,
          app_ref: event.appRef ?? null,
          category: event.category,
          severity: event.severity,
          confidence: event.confidence,
          reason_code: event.reasonCode,
        }], event.correlationId).catch(() => undefined);
      }
      if (event.type === "APP_BLOCKED") {
        setAppBlockedMessage(`${event.appRef} · ${event.reasonCode}`);
      }
      if (event.type === "TIME_WARNING") {
        setTimeMessage(`${event.targetRef} · ${event.remainingSeconds}s remaining`);
      }
      if (event.type === "TIME_EXPIRED") {
        setTimeMessage(`${event.targetRef} · time expired`);
      }
      if (event.type === "PERMISSION_STATE_CHANGED" && event.capability === "app_blocking") {
        setAppBlockingAvailable(event.state === "FULL");
      }
      if (event.type === "PROTECTION_STATUS_CHANGED") {
        void refreshNativeProtection().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void refreshNativeProtection().catch(() => {
        if (!cancelled) {
          setProtectionMessage("Web protection is unavailable.");
          setAppBlockingAvailable(null);
        }
      });
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!policy.data?.bundle || revoked) return;
    let cancelled = false;
    const uploadUsage = async () => {
      if (usageUploaded.current) return;
      const usage = await GuardianProtection.getUsageSummary({
        start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString(),
      });
      const occurredAt = new Date().toISOString();
      const events = appUsageEvents(usage.byTarget, occurredAt);
      if (events.length) await api.ingestEvents(events);
      // A failed upload remains eligible after a relaunch/foreground sync.
      usageUploaded.current = true;
    };
    const uploadInventory = async () => {
      if (inventoryUploaded.current) return;
      const observedApps = await GuardianProtection.getObservedApps();
      await api.ingestInventory(
        observedApps.map((app) => ({
          platform_app_id: app.platformAppId,
          display_name: app.displayName,
          category: app.category,
          observed_at: app.observedAt,
          version_name: app.versionName,
          first_seen_at: app.firstSeenAt,
          last_seen_at: app.lastSeenAt,
          installation_state: app.installationState,
          capability_sources: app.capabilitySources,
          inventory_completeness: app.inventoryCompleteness,
        })),
      );
      inventoryUploaded.current = true;
    };
    const syncProtection = async () => {
      const result = await GuardianProtection.applyPolicyBundle(policy.data.bundle);
      if (cancelled) return;
      if (!result.applied && result.reason !== "POLICY_VERSION_NOT_MONOTONIC") {
        setProtectionMessage("Protection policy could not be applied.");
        return;
      }
      const capabilities = await GuardianProtection.getCapabilities();
      const vpnReady = capabilities.vpn_filtering.level === "LIMITED" || capabilities.vpn_filtering.level === "FULL";
      if (!vpnReady) {
        setProtectionMessage(capabilities.vpn_filtering.detail ?? "Web protection permission is required.");
        return;
      }
      const communication = policy.data.bundle as { communication_safety?: { enabled?: boolean } };
      if (communication.communication_safety?.enabled && capabilities.communication_risk_signals.level === "UNAVAILABLE") {
        setProtectionMessage("Communication safety permission is required.");
      }
      await GuardianProtection.startProtection();
      await api.acknowledgePolicy(policy.data.policy_version);
      const protectionStatus = await GuardianProtection.getProtectionStatus();
      const currentCapabilities = await GuardianProtection.getCapabilities();
      await api.heartbeat({
        protection_state: protectionStatus.health,
        capabilities: currentCapabilities,
      });
      // Approval transport is opportunistic. A failed refresh never unlocks locally.
      void api.contentApprovals()
        .then((approvals) => GuardianProtection.applyContentApprovals(approvals))
        .catch(() => undefined);
      void flushContentReviewOutbox().catch(() => undefined);
      setAcknowledgedVersion(policy.data.policy_version);
      setProtectionMessage("Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian.");
      // Reputation is advisory and independently retryable. A transient
      // reputation outage must never suppress policy acknowledgement,
      // heartbeat, app inventory, or usage reporting.
      void syncReputation()
        .then(() => {
          if (!cancelled) setReputationMessage(null);
        })
        .catch(() => {
          if (!cancelled) {
            setReputationMessage(
              "Reputation updates are temporarily unavailable. Protection and parent rules remain active.",
            );
          }
        });
      await Promise.allSettled([uploadUsage(), uploadInventory()]);
      if (__DEV__ && Platform.OS === "android") {
        const metrics = await GuardianProtection.getPerformanceMetrics();
        console.info("GUARDIAN_PERFORMANCE_METRICS_AFTER_SYNC", JSON.stringify(metrics));
      }
      await refreshNativeProtection();
    };
    void syncProtection().catch(() => {
      if (!cancelled) {
        void refreshNativeProtection().catch(() => {
          if (!cancelled) setProtectionMessage("Web protection is unavailable.");
        });
      }
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Launcher/Usage/Accessibility observations may have changed while
        // Guardian was backgrounded. Re-send the source-tagged partial view.
        inventoryUploaded.current = false;
        void syncProtection().catch(() => {
          if (!cancelled) {
            void refreshNativeProtection().catch(() => {
              if (!cancelled) setProtectionMessage("Web protection is unavailable.");
            });
          }
        });
      }
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [policy.data, revoked]);

  return (
    <ScreenScaffold title="My time">
      {revoked ? (
        <ProtectionRemovedState onRecover={() => router.replace("/role-selection")} />
      ) : (
        <DataState
          state={policyState}
          message={policyStateMessage}
        >
          <SectionSurface>
            <Text>Policy version: {policy.data?.policy_version ?? "Unknown"}</Text>
            <Text>
              {policy.data?.version_mismatch && acknowledgedVersion !== policy.data.policy_version
                ? "Waiting for device acknowledgement."
                : policy.data
                  ? "Policy acknowledged by this device."
                  : "Policy status is not available yet."}
            </Text>
            {policyUnavailable ? (
              <SecondaryButton
                label="Retry"
                onPress={() => void policy.refetch().catch(() => undefined)}
              />
            ) : null}
            <Text>{protectionMessage}</Text>
            {canRetryProtection ? (
              <PrimaryButton
                label="Retry web protection"
                onPress={() => {
                  void GuardianProtection.startProtection()
                    .then(() => refreshNativeProtection())
                    .catch(() => refreshNativeProtection().catch(() => undefined));
                }}
              />
            ) : null}
            {reputationMessage ? <Text accessibilityRole="alert">{reputationMessage}</Text> : null}
            {appBlockingAvailable === false ? (
              <>
                <Text>App limits are not being enforced right now. Re-enable Accessibility to restore app blocking.</Text>
                <PrimaryButton
                  label="Enable app limits"
                  onPress={() => void GuardianProtection.openAccessibilitySettings().catch(() => undefined)}
                />
              </>
            ) : null}
            {accessibilitySignals?.level === "UNAVAILABLE" &&
            accessibilitySignals.detail === ACCESSIBILITY_SIGNALS_DISABLED_BY_PARENT_POLICY ? (
              <Text accessibilityRole="alert">Disabled by parent policy. Ask a parent to enable Android content-safety signals.</Text>
            ) : (
              <>
                <Text>Content-safety inspection is separate and optional. Guardian never claims coverage for text an app does not expose to Accessibility.</Text>
                <PrimaryButton label="Enable content-safety inspection" onPress={requestAccessibilityContentConsent} />
                <SecondaryButton label="Turn off content-safety inspection" onPress={() => { void GuardianProtection.setAccessibilityContentConsent(false); }} />
              </>
            )}
            <Text>
              Communication Safety checks notification signals from supported communication apps.
              Guardian analyzes notification text briefly on this device, discards it, and sends
              only category, severity, confidence, source app, time, and reason. Guardian cannot
              read message history, passwords, or content outside notifications.
            </Text>
            {blockedEvent ? (
              <Text>
                WEB_BLOCKED events: {blockedEventCount} · {blockedEvent.domain} ·{" "}
                {blockedEvent.category ?? "UNKNOWN"} · {blockedEvent.reasonCode} ·{" "}
                {blockedEvent.appRef ?? "UNKNOWN_APP"}
              </Text>
            ) : null}
            {appBlockedMessage ? <Text>APP_BLOCKED: {appBlockedMessage}</Text> : null}
            {timeMessage ? <Text>TIME: {timeMessage}</Text> : null}
            {protectionMessage === "Web protection permission is required." ? (
              <PrimaryButton
                label="Enable web protection"
                onPress={() => Alert.alert(
                  "VPN web protection",
                  "Guardian uses an Android VPN to inspect DNS destinations for policy enforcement. It does not provide full-device traffic visibility. Unrouted traffic, some QUIC/DoH flows, and IP-only traffic may bypass domain attribution.",
                  [
                    { text: "Not now", style: "cancel" },
                    { text: "Allow VPN", onPress: () => void GuardianProtection.requestVpnPermission() },
                  ],
                )}
              />
            ) : null}
            {protectionMessage === "Communication safety permission is required." ? (
              <PrimaryButton
                label="Restore communication safety permission"
                onPress={() => Alert.alert(
                  "Notification access",
                  "With Communication Safety enabled, Guardian checks only supported communication-app notifications. Raw notification text is processed briefly on this device and discarded; only category, severity, source app, time, confidence, and reason metadata leave the device.",
                  [
                    { text: "Not now", style: "cancel" },
                    { text: "Open notification settings", onPress: () => void GuardianProtection.openNotificationAccessSettings() },
                  ],
                )}
              />
            ) : null}
            <PrimaryButton label="My time" onPress={() => router.push("/child/time")} />
            <PrimaryButton label="My simple rules" onPress={() => router.push("/child/rules-summary")} />
            {timeMessage?.includes("expired") ? <PrimaryButton label="Open time-up" onPress={() => router.push("/child/time-up")} /> : null}
            <PrimaryButton label="Ask for help" onPress={() => router.push("/child/requests")} />
          </SectionSurface>
        </DataState>
      )}
    </ScreenScaffold>
  );
}
