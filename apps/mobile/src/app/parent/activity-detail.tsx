import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { CardSurface, DataState, ListRow, ScreenScaffold, SectionSurface } from "@/design-system";

export default function ActivityDetailRoute() {
  const { familyId, childId, appId, category } = useLocalSearchParams<{ familyId: string; childId?: string; appId?: string; category?: string }>();
  const activity = useQuery({ queryKey: ["activity-usage", familyId, childId], queryFn: () => api.activityUsage(familyId, childId), enabled: Boolean(familyId && childId) });
  const rows = (activity.data ?? []).filter((item) => (appId ? item.app_ref === appId : category ? item.category === category : true));
  return <ScreenScaffold title={appId ? "App activity detail" : "Category activity detail"}><DataState state={activity.isLoading ? "loading" : activity.isError ? "error" : rows.length ? "loaded" : "empty"} onRetry={() => void activity.refetch()}><SectionSurface><Text>{appId ?? category ?? "All activity"}</Text>{rows.map((item) => <CardSurface key={`${item.occurred_at}-${item.app_ref ?? "unknown"}`}><ListRow label={item.app_ref ?? "Unknown app"} value={`${Math.round(item.duration_seconds / 60)} min`} /><Text>{item.category ?? "Unknown category"} · {new Date(item.occurred_at).toLocaleString()}</Text></CardSurface>)}</SectionSurface></DataState></ScreenScaffold>;
}
