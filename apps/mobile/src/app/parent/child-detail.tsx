import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { CardSurface, DataState, ListRow, ScreenScaffold, SectionSurface, SecondaryButton } from "@/design-system";

export default function ChildDetailRoute() {
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId: string }>();
  const router = useRouter();
  const child = useQuery({ queryKey: ["child", familyId, childId], queryFn: () => api.child(familyId, childId), enabled: Boolean(familyId && childId) });
  const health = useQuery({ queryKey: ["health", familyId, childId], queryFn: () => api.health(familyId, childId), enabled: Boolean(familyId && childId) });
  return <ScreenScaffold title="Child detail"><DataState state={child.isLoading || health.isLoading ? "loading" : child.isError || health.isError ? "error" : !child.data ? "empty" : "loaded"} onRetry={() => { void child.refetch(); void health.refetch(); }}><SectionSurface>{child.data ? <CardSurface><ListRow label="Name" value={child.data.name} /><ListRow label="Age band" value={child.data.age_band} /><ListRow label="Timezone" value={child.data.timezone} /><Text>Child profile and paired-device state are loaded from the family service.</Text></CardSurface> : <Text>No child profile is available.</Text>}</SectionSurface><SectionSurface><Text>Device status</Text>{(health.data ?? []).map((item) => <CardSurface key={item.device_id}><ListRow label="Protection" value={item.state} /><ListRow label="Policy" value={item.policy_version_applied ? `Version ${item.policy_version_applied}` : "Pending"} /></CardSurface>)}<SecondaryButton label="Open protection health" onPress={() => router.push({ pathname: "/parent/health", params: { familyId, childId } })} /></SectionSurface></DataState></ScreenScaffold>;
}
