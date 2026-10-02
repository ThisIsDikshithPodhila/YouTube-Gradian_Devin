import { Platform, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/api/client";
import { useNetworkStatus } from "@/state/network";
import { CardSurface, DataState, ListRow, ResponsiveColumns, ScreenScaffold, SectionSurface, SecondaryButton } from "@/design-system";
import type { ActivityUsagePoint } from "@/api/client";

function reportRange() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 6);
  return {
    start: start.toISOString().slice(0, 10),
    end: new Date(now.getTime() + 86400000).toISOString().slice(0, 10),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function formatUsageMinutes(seconds: number): string {
  if (seconds > 0 && seconds < 60) return "<1 min";
  return `${Math.floor(seconds / 60)} min`;
}

export function aggregateTodayUsage(
  points: ActivityUsagePoint[],
  now = new Date(),
): Record<string, number> {
  return points.reduce<Record<string, number>>((totals, point) => {
    const occurredAt = new Date(point.occurred_at);
    if (
      occurredAt.getFullYear() !== now.getFullYear() ||
      occurredAt.getMonth() !== now.getMonth() ||
      occurredAt.getDate() !== now.getDate()
    ) {
      return totals;
    }
    const target = point.app_ref
      ? `APP:${point.app_ref}`
      : point.category
        ? `CATEGORY:${point.category}`
        : "DEVICE";
    totals[target] = Math.max(totals[target] ?? 0, point.duration_seconds);
    return totals;
  }, {});
}

export default function ParentActivityRoute() {
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId?: string }>();
  const router = useRouter();
  const { isOffline } = useNetworkStatus();
  const activity = useQuery({ queryKey: ["activity", familyId, childId], queryFn: () => api.activity(familyId, childId), enabled: Boolean(familyId && childId) });
  const activityUsage = useQuery({ queryKey: ["activity-usage", familyId, childId], queryFn: () => api.activityUsage(familyId, childId), enabled: Boolean(familyId && childId) });
  const report = useQuery({
    queryKey: ["usage-report", familyId, childId],
    queryFn: () => api.usageReport(familyId, { ...reportRange(), childId, granularity: "DAILY" }),
    enabled: Boolean(familyId && childId),
  });
  const activityEvents = activity.data ?? [];
  const activityUsagePoints = activityUsage.data ?? [];
  const reportBuckets = report.data ?? [];
  const now = new Date();
  const usageTargets = aggregateTodayUsage(activityUsagePoints, now);
  const hasData = activityEvents.length > 0 || activityUsagePoints.length > 0 || Object.keys(usageTargets).length > 0 || reportBuckets.length > 0;
  const permissionDenied =
    [activity.error, activityUsage.error, report.error].some(
      (error) => error instanceof ApiError && error.status === 401,
    );
  const state = activity.isLoading || activityUsage.isLoading || report.isLoading
    ? "loading"
    : permissionDenied
      ? "permission-denied"
    : activity.isError || activityUsage.isError || report.isError
      ? "error"
      : isOffline
        ? "offline"
        : activity.isStale || activityUsage.isStale
          ? "stale"
          : !activity.data || !activityUsage.data || !report.data
        ? "loading"
            : hasData ? "loaded" : "empty";
  return (
    <ScreenScaffold title="Activity">
      <DataState state={state} onRetry={() => { void activity.refetch(); void activityUsage.refetch(); void report.refetch(); }}>
        <ResponsiveColumns>
          <SectionSurface>
            <Text>Today’s usage</Text>
            {Object.keys(usageTargets).length > 0
              ? Object.entries(usageTargets).map(([target, seconds]) => <ListRow key={target} label={target} value={formatUsageMinutes(seconds)} />)
              : <Text>Unknown · no child usage was reported today.</Text>}
          </SectionSurface>
          <SectionSurface>
            <Text>Daily usage report</Text>
            {reportBuckets.length
              ? reportBuckets.map((bucket) => (
                <CardSurface key={`${bucket.child_profile_id}-${bucket.period_start}`}>
                  <ListRow label={bucket.period_start} value={formatUsageMinutes(bucket.duration_seconds)} />
                  <Text>{Object.entries(bucket.by_category).map(([category, seconds]) => `${category}: ${formatUsageMinutes(seconds)}`).join(" · ")}</Text>
                  {bucket.coverage === "PARTIAL" ? (
                    <Text>Partial coverage · {formatUsageMinutes(bucket.unattributed_seconds)} could not be attributed to an app or category.</Text>
                  ) : null}
                </CardSurface>
              ))
              : <Text>Unknown · no persisted usage is available for this report.</Text>}
          </SectionSurface>
          <SectionSurface>
            <Text>Usage over time</Text>
            {activityUsagePoints.length ? activityUsagePoints.map((point) => (
              <CardSurface key={`${point.occurred_at}-${point.app_ref ?? "unknown"}-${point.event_type}`}>
                <ListRow label={point.app_ref ?? "Unknown app"} value={formatUsageMinutes(point.duration_seconds)} />
                <Text>{point.category ?? "Unknown category"} · {new Date(point.occurred_at).toLocaleString()}</Text>
                <SecondaryButton label="Open activity detail" onPress={() => router.push({ pathname: "/parent/activity-detail", params: { familyId, childId, ...(point.app_ref ? { appId: point.app_ref } : { category: point.category ?? "UNKNOWN" }) } })} />
              </CardSurface>
            )) : <Text>Unknown · no usage aggregates are available for this family.</Text>}
          </SectionSurface>
          <SectionSurface>
            <Text>Web and safety events</Text>
            <Text>
              Communication Safety: {Platform.OS === "ios" ? "Not available on iPhone/iPad." : "Android notification signals only."}
            </Text>
            {activityEvents.length ? activityEvents.map((event) => (
              <CardSurface key={event.id}>
                <ListRow label={event.kind === "WEB" ? "Web event" : "Safety event"} value={event.event_type} />
                <Text>{event.domain ?? event.app_ref ?? "Unknown target"}</Text>
                <Text>{event.category ?? "Unknown category"}</Text>
                {event.kind === "SAFETY" ? <Text>{event.severity ?? "Unknown severity"}</Text> : null}
                <Text>{new Date(event.occurred_at).toLocaleString()}</Text>
              </CardSurface>
            )) : <Text>Unknown · no backend events are available for this family.</Text>}
          </SectionSurface>
        </ResponsiveColumns>
      </DataState>
      {state === "empty" ? (
        <SectionSurface>
          <Text>Unknown · this family has not reported activity yet.</Text>
          <Text>Unknown · no backend events are available for this family.</Text>
          <Text>Unknown · no usage aggregates are available for this family.</Text>
        </SectionSurface>
      ) : null}
    </ScreenScaffold>
  );
}
