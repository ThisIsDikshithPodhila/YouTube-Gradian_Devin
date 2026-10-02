import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { DataState, ScreenScaffold, SectionSurface } from "@/design-system";

export default function HelpRoute() {
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId?: string }>();
  const health = useQuery({ queryKey: ["health", familyId, childId], queryFn: () => api.health(familyId, childId), enabled: Boolean(familyId && childId) });
  return <ScreenScaffold title="Help and troubleshooting"><DataState state={health.isLoading ? "loading" : health.isError ? "error" : "loaded"} onRetry={() => void health.refetch()}><SectionSurface><Text>Start with the device status below. If a device is degraded, restore the named Android permission and wait for policy acknowledgement.</Text>{(health.data ?? []).map((item) => <Text key={item.device_id}>{item.device_id}: {item.state} · last seen {item.last_seen_at ?? "unknown"}</Text>)}</SectionSurface></DataState></ScreenScaffold>;
}
