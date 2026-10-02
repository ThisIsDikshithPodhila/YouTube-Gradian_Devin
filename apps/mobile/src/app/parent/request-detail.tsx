import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { CardSurface, DataState, ListRow, PrimaryButton, ScreenScaffold, SectionSurface } from "@/design-system";

export default function RequestDetailRoute() {
  const { familyId, childId, requestId } = useLocalSearchParams<{ familyId: string; childId?: string; requestId: string }>();
  const queryClient = useQueryClient();
  const requests = useQuery({ queryKey: ["requests", familyId, childId], queryFn: () => api.requests(familyId, childId), enabled: Boolean(familyId && childId) });
  const request = requests.data?.find((item) => item.id === requestId);
  const decide = useMutation({ mutationFn: (decision: "approve" | "deny") => api.decideRequest(familyId, requestId, decision, "Reviewed in request detail"), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["requests", familyId, childId] }) });
  return <ScreenScaffold title="Request detail"><DataState state={requests.isLoading ? "loading" : requests.isError ? "error" : request ? "loaded" : "empty"} onRetry={() => void requests.refetch()}><SectionSurface>{request ? <CardSurface><ListRow label="Type" value={request.request_type} /><ListRow label="State" value={request.state} /><Text>{request.subject ?? "No target"} · {request.reason ?? "No child note"}</Text>{request.state === "PENDING" ? <><PrimaryButton label="Approve request" onPress={() => decide.mutate("approve")} /><PrimaryButton label="Deny request" onPress={() => decide.mutate("deny")} /></> : <Text>This request is closed.</Text>}</CardSurface> : <Text>No request is available.</Text>}</SectionSurface></DataState></ScreenScaffold>;
}
