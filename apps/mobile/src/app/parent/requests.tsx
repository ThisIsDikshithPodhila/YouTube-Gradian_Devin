import { useState } from "react";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AccessRequest } from "@/api/client";
import { useFamilySync } from "@/hooks/use-family-sync";
import { useNetworkStatus } from "@/state/network";
import { CardSurface, DataState, ListRow, PrimaryButton, ScreenScaffold, SectionSurface, TextField } from "@/design-system";

function stateLabel(request: AccessRequest) {
  return request.state === "PENDING" ? "Waiting for a parent" : request.state;
}

export default function ParentRequestsRoute() {
  const { familyId } = useLocalSearchParams<{ familyId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("Reviewed with the family.");
  const { isOffline } = useNetworkStatus();
  const requests = useQuery({
    queryKey: ["requests", familyId],
    queryFn: () => api.requests(familyId),
    enabled: Boolean(familyId),
  });
  useFamilySync(familyId, "parent");
  const decide = useMutation({
    mutationFn: ({ requestId, decision }: { requestId: string; decision: "approve" | "deny" }) => api.decideRequest(familyId, requestId, decision, reason.trim()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["requests", familyId] }),
  });
  return (
    <ScreenScaffold title="Requests">
      <DataState state={requests.isLoading ? "loading" : requests.isError ? "error" : isOffline ? "offline" : requests.isStale ? "stale" : requests.data?.length ? "loaded" : "empty"} onRetry={() => void requests.refetch()}>
        <SectionSurface>
          <TextField label="Decision reason" value={reason} onChangeText={setReason} />
          {requests.data?.map((request) => (
            <CardSurface key={request.id}>
              <ListRow label={request.request_type} value={stateLabel(request)} />
              <Text>{request.subject ?? "No target"} · {request.reason ?? "No child note"}</Text>
              <PrimaryButton label="Open request detail" onPress={() => router.push({ pathname: "/parent/request-detail", params: { familyId, requestId: request.id } })} />
              {request.state === "PENDING" ? (
                <>
                  <PrimaryButton label="Approve" disabled={!reason.trim() || decide.isPending} onPress={() => decide.mutate({ requestId: request.id, decision: "approve" })} />
                  <PrimaryButton label="Deny" disabled={!reason.trim() || decide.isPending} onPress={() => decide.mutate({ requestId: request.id, decision: "deny" })} />
                </>
              ) : <Text>This request is closed. No further action is available.</Text>}
            </CardSurface>
          ))}
        </SectionSurface>
      </DataState>
    </ScreenScaffold>
  );
}
