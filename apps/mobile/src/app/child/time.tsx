import { useQuery } from "@tanstack/react-query";
import { AppState, Text } from "react-native";
import { useCallback, useEffect } from "react";
import { api } from "@/api/client";
import { GuardianProtection } from "../../../modules/guardian-protection/src";
import { PrimaryButton, ScreenScaffold, SectionSurface } from "@/design-system";
import { useFocusEffect, useRouter } from "expo-router";

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: new Date().toISOString() };
}

type ActiveGrantDescriptor = {
  action: "LIMIT" | "ALLOW";
  minutes: number | null;
  ruleId: string;
  targetKind: "APP" | "DOMAIN" | "DEVICE";
  targetRef: string;
  target: string;
};

export default function ChildTimeRoute() {
  const limitedChildBuild = process.env.EXPO_PUBLIC_GUARDIAN_LIMITED_CHILD === "true";
  const router = useRouter();
  const usage = useQuery({
    queryKey: ["child-usage"],
    queryFn: () => GuardianProtection.getUsageSummary(todayRange()),
    refetchInterval: 5_000,
  });
  const refreshUsage = useCallback(() => {
    void usage.refetch().catch(() => undefined);
  }, [usage.refetch]);
  useEffect(() => {
    const subscription = GuardianProtection.subscribe((event) => {
      if (
        event.type === "TIME_WARNING" ||
        event.type === "TIME_EXPIRED" ||
        event.type === "APP_BLOCKED" ||
        event.type === "POLICY_APPLIED"
      ) {
        refreshUsage();
      }
    });
    return () => subscription.remove();
  }, [refreshUsage]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshUsage();
    });
    return () => subscription.remove();
  }, [refreshUsage]);
  useFocusEffect(useCallback(() => {
    refreshUsage();
  }, [refreshUsage]));
  const policy = useQuery({ queryKey: ["device-policy"], queryFn: () => api.policy() });
  const bundle = policy.data?.bundle as {
    app_rules?: unknown;
    base_policy?: unknown;
    temporary_overrides?: unknown;
  } | undefined;
  const appBudgets = (() => {
    if (!bundle || !Array.isArray(bundle.app_rules)) return [];
    const rules = bundle.app_rules as unknown[];
    return rules.filter((rule): rule is { app_ref: string; daily_minutes: number } => {
      if (typeof rule !== "object" || rule === null) return false;
      const candidate = rule as Record<string, unknown>;
      return typeof candidate.app_ref === "string" && typeof candidate.daily_minutes === "number";
    });
  })();
  const activeGrantDescriptors: ActiveGrantDescriptor[] = (() => {
    if (!Array.isArray(bundle?.temporary_overrides)) return [];
    const now = Date.now();
    return bundle.temporary_overrides.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const override = item as Record<string, unknown>;
      if (override.action !== "LIMIT" && override.action !== "ALLOW") return [];
      if (typeof override.starts_at !== "string" || typeof override.expires_at !== "string") return [];
      const startsAt = Date.parse(override.starts_at);
      const expiresAt = Date.parse(override.expires_at);
      if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || now < startsAt || now >= expiresAt) return [];
      const targetKind = override.target_kind;
      const targetRef = override.target_ref;
      const ruleId = override.rule_id;
      if (
        (targetKind !== "APP" && targetKind !== "DOMAIN" && targetKind !== "DEVICE") ||
        typeof targetRef !== "string" ||
        typeof ruleId !== "string"
      ) {
        return [];
      }
      return [{
        action: override.action,
        minutes: typeof override.daily_minutes === "number" ? Number(override.daily_minutes) : null,
        ruleId,
        targetKind,
        targetRef,
        target: targetKind === "DEVICE"
          ? "this device"
          : targetKind === "APP"
            ? `app ${targetRef}`
            : `website ${targetRef}`,
      }] satisfies ActiveGrantDescriptor[];
    });
  })();
  const baseDeviceMinutes = (() => {
    if (typeof bundle?.base_policy !== "object" || bundle.base_policy === null) return undefined;
    const value = (bundle.base_policy as Record<string, unknown>).daily_device_budget_minutes;
    return typeof value === "number" ? value : undefined;
  })();
  const activeDeviceMinutes = activeGrantDescriptors
    .filter((grant) => grant.targetKind === "DEVICE" && grant.action === "LIMIT" && grant.minutes !== null)
    .map((grant) => grant.minutes as number);
  const deviceLimits = [baseDeviceMinutes, ...activeDeviceMinutes].filter(
    (minutes): minutes is number => minutes !== undefined,
  );
  const deviceLimit = deviceLimits.length > 0 ? Math.max(...deviceLimits) : undefined;
  const deviceUsedSeconds = usage.data?.byTarget.DEVICE ?? usage.data?.totalSeconds ?? 0;
  return (
    <ScreenScaffold title="My time">
      <SectionSurface>
        {limitedChildBuild ? (
          <Text>App time and limits are informational in this web-only test build; app blocking is unavailable.</Text>
        ) : null}
        <Text>Time used today</Text>
        {usage.data ? <Text>{Math.round(deviceUsedSeconds / 60)} minutes recorded on this device.</Text> : <Text>Unknown · Usage Access is unavailable or has not reported yet.</Text>}
        {usage.data && appBudgets.length > 0
          ? appBudgets.map((budget) => {
              const usedSeconds = usage.data.byTarget[`APP:${budget.app_ref}`] ?? 0;
              const appGrant = activeGrantDescriptors.find(
                (grant) => grant.targetKind === "APP" && grant.targetRef === budget.app_ref,
              );
              if (appGrant?.action === "ALLOW") {
                return <Text key={budget.app_ref}>{budget.app_ref}: Unlimited time today.</Text>;
              }
              const appLimit = appGrant?.action === "LIMIT" && appGrant.minutes !== null
                ? appGrant.minutes
                : budget.daily_minutes;
              const appRemainingSeconds = appLimit * 60 - usedSeconds;
              const deviceRemainingSeconds = !appGrant && deviceLimit !== undefined
                ? deviceLimit * 60 - deviceUsedSeconds
                : Number.POSITIVE_INFINITY;
              const remainingSeconds = Math.max(0, Math.min(appRemainingSeconds, deviceRemainingSeconds));
              const remainingLabel = remainingSeconds <= 0
                ? "No time left today."
                : remainingSeconds < 60
                  ? "Less than 1 minute remaining."
                  : `${Math.floor(remainingSeconds / 60)} minutes remaining.`;
              return <Text key={budget.app_ref}>{budget.app_ref}: {remainingLabel}{limitedChildBuild ? " (not enforced)" : ""}</Text>;
            })
          : null}
        {activeGrantDescriptors.map((grant) => (
          <Text key={grant.ruleId}>Parent-approved extra time for {grant.target}{grant.minutes === null ? "." : `: ${grant.minutes} minutes.`}</Text>
        ))}
        <Text>{limitedChildBuild ? "Need a website unblocked? Ask a parent." : "Need a change? Ask a parent for more time or to unblock an app or website."}</Text>
        <PrimaryButton label="Ask for help" onPress={() => router.push("/child/requests")} />
        {!limitedChildBuild ? <PrimaryButton label="Open time-up help" onPress={() => router.push("/child/time-up")} /> : null}
      </SectionSurface>
    </ScreenScaffold>
  );
}
