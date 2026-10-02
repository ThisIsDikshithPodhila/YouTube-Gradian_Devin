import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, Text } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useSession } from "@/auth/session";
import { useNetworkStatus } from "@/state/network";
import { resolveActiveChildId, selectParentHomeChild } from "./home-selection";
import {
  CardSurface,
  DataState,
  ListRow,
  PrimaryButton,
  ProtectionStatePill,
  ResponsiveColumns,
  ScreenScaffold,
  SectionSurface,
  SecondaryButton,
} from "@/design-system";

export default function ParentHomeRoute() {
  const { childId: routeChildId, familyId: routeFamilyId } = useLocalSearchParams<{
    familyId?: string;
    childId?: string;
  }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    childId: storedChildId,
    familyId: storedFamilyId,
    setChildId,
    sessionError,
    signOut,
  } = useSession();
  const activeFamilyId = routeFamilyId ?? storedFamilyId ?? undefined;
  const { isOffline } = useNetworkStatus();
  const children = useQuery({
    queryKey: ["children", activeFamilyId],
    queryFn: () => api.children(activeFamilyId!),
    enabled: Boolean(activeFamilyId),
  });
  const activeChildId = resolveActiveChildId(storedChildId, routeChildId, children.data?.[0]?.id);
  const health = useQuery({
    queryKey: ["health", activeFamilyId, activeChildId],
    queryFn: () => api.health(activeFamilyId!, activeChildId),
    enabled: Boolean(activeFamilyId && activeChildId),
  });
  const inventory = useQuery({
    queryKey: ["child-inventory", activeFamilyId, activeChildId],
    queryFn: () => api.childInventory(activeFamilyId!, activeChildId!),
    enabled: Boolean(activeFamilyId && activeChildId),
  });
  const selectedChild = children.data?.find((child) => child.id === activeChildId) ?? null;
  const policyMutation = useMutation({
    mutationFn: (operation: "TEMPORARY_SCREEN_TIME" | "PAUSE_INTERNET") =>
      api.mutatePolicy(activeFamilyId!, activeChildId!, {
        operation,
        target: operation === "PAUSE_INTERNET" ? "pause-internet" : "device",
        ...(operation === "TEMPORARY_SCREEN_TIME"
          ? { value: 15, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }
          : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["children", activeFamilyId] });
      void queryClient.invalidateQueries({ queryKey: ["health", activeFamilyId, activeChildId] });
    },
  });
  const deleteAccount = () => {
    Alert.alert(
      "Delete account and family data?",
      "This permanently deletes your account, family, child profiles, devices, policies, events, reports, requests, and notification records. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete permanently",
          style: "destructive",
          onPress: () => {
            void api.deleteAccount()
              .then(() => signOut())
              .then(() => router.replace("/role-selection"));
          },
        },
      ],
    );
  };
  const state = !activeFamilyId
    ? "empty"
    : children.isLoading || health.isLoading || inventory.isLoading
      ? "loading"
      : isOffline
        ? "offline"
        : children.isError || health.isError || inventory.isError
          ? "error"
          : selectedChild ? "loaded" : "empty";

  return (
    <ScreenScaffold title="Parent home">
      {sessionError === "SESSION_EXPIRED" ? (
        <SectionSurface>
          <Text accessibilityRole="alert">Your parent session expired. Sign in again to change Guardian rules.</Text>
          <PrimaryButton label="Sign in again" onPress={() => router.replace("/parent/login")} />
        </SectionSurface>
      ) : null}
      {!activeFamilyId ? (
        <SectionSurface>
          <PrimaryButton label="Set up your family" onPress={() => router.push("/parent/setup")} />
        </SectionSurface>
      ) : null}
      <DataState state={state} onRetry={() => { void children.refetch(); void health.refetch(); void inventory.refetch(); }}>
        <SectionSurface>
          <Text>Children</Text>
          {(children.data ?? []).map((child) => (
            <SecondaryButton
              key={child.id}
              label={child.id === activeChildId ? `${child.name} selected` : `Switch to ${child.name}`}
              disabled={child.id === activeChildId}
              onPress={() => {
                if (!activeFamilyId) return;
                void selectParentHomeChild(activeFamilyId, child.id, setChildId, router.replace);
              }}
            />
          ))}
          <PrimaryButton
            label="Add a child"
            onPress={() => router.push({ pathname: "/parent/setup", params: { familyId: activeFamilyId } })}
          />
        </SectionSurface>
        {selectedChild ? (
          <ResponsiveColumns>
            <CardSurface>
              <Text>{selectedChild.name}</Text>
              <ListRow label="Age band" value={selectedChild.age_band} />
              <PrimaryButton label="Add 15 minutes" onPress={() => policyMutation.mutate("TEMPORARY_SCREEN_TIME")} />
              <PrimaryButton label="Pause child internet" onPress={() => policyMutation.mutate("PAUSE_INTERNET")} />
              <SecondaryButton label="Child detail" onPress={() => router.push({ pathname: "/parent/child-detail", params: { familyId: activeFamilyId, childId: activeChildId } })} />
              <PrimaryButton label="Generate pairing code" onPress={() => router.push({ pathname: "/parent/pairing", params: { familyId: activeFamilyId, childId: activeChildId } })} />
              <SecondaryButton label="Rules" onPress={() => router.push({ pathname: "/parent/rules", params: { familyId: activeFamilyId, childId: activeChildId } })} />
              <SecondaryButton label="Requests" onPress={() => router.push({ pathname: "/parent/requests", params: { familyId: activeFamilyId, childId: activeChildId } })} />
              <SecondaryButton label="Activity" onPress={() => router.push({ pathname: "/parent/activity", params: { familyId: activeFamilyId, childId: activeChildId } })} />
              <SecondaryButton label="Protection health" onPress={() => router.push({ pathname: "/parent/health", params: { familyId: activeFamilyId, childId: activeChildId } })} />
              <SecondaryButton label="Quick control" onPress={() => router.push({ pathname: "/parent/quick-control", params: { familyId: activeFamilyId, childId: activeChildId } })} />
            </CardSurface>
            {health.data?.map((item) => <CardSurface key={item.device_id}><ListRow label="Protection" value={item.last_seen_at ?? "Unknown"} /><ProtectionStatePill state={item.state} /></CardSurface>)}
            <CardSurface>
              <Text>Installed apps on {selectedChild.name}'s device</Text>
              {inventory.data?.length ? inventory.data.map((app) => (
                <ListRow key={app.platform_app_id} label={app.display_name} value={`${app.category ?? "Unknown"}${app.reviewed ? "" : " · Review"}`} />
              )) : <Text>No child-device inventory is available yet.</Text>}
            </CardSurface>
          </ResponsiveColumns>
        ) : null}
      </DataState>
      <SectionSurface>
        <SecondaryButton label="Family settings" onPress={() => router.push({ pathname: "/parent/family-settings", params: { familyId: activeFamilyId, childId: activeChildId } })} />
        <SecondaryButton label="Guardian and device settings" onPress={() => router.push({ pathname: "/parent/guardian-device-settings", params: { familyId: activeFamilyId, childId: activeChildId } })} />
        <Text>Account and data</Text>
        <Text>You can permanently delete your Guardian account and all family and child data from this device. Deletion is irreversible.</Text>
        <SecondaryButton label="Delete account and family data" onPress={deleteAccount} />
      </SectionSurface>
      <PrimaryButton label="Sign out" onPress={() => { void signOut().then(() => router.replace("/role-selection")); }} />
    </ScreenScaffold>
  );
}
