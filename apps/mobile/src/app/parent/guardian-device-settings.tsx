import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { CardSurface, DataState, ListRow, ScreenScaffold, SectionSurface } from "@/design-system";

export default function GuardianDeviceSettingsRoute() {
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId?: string }>();
  const health = useQuery({ queryKey: ["health", familyId, childId], queryFn: () => api.health(familyId, childId), enabled: Boolean(familyId && childId) });
  const guardians = useQuery({ queryKey: ["guardians", familyId], queryFn: () => api.guardians(familyId), enabled: Boolean(familyId) });
  return <ScreenScaffold title="Guardian and device settings"><DataState state={health.isLoading || guardians.isLoading ? "loading" : health.isError || guardians.isError ? "error" : "loaded"} onRetry={() => { void health.refetch(); void guardians.refetch(); }}><SectionSurface><Text>Guardians</Text>{(guardians.data ?? []).map((item) => <ListRow key={item.id} label={item.role} value={item.parent_id} />)}</SectionSurface><SectionSurface><Text>Devices</Text>{(health.data ?? []).map((item) => <CardSurface key={item.device_id}><ListRow label={item.device_id} value={item.state} /><Text>{item.last_seen_at ?? "No heartbeat recorded"}</Text></CardSurface>)}</SectionSurface></DataState></ScreenScaffold>;
}
