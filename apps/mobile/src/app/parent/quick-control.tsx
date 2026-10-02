import { useMemo, useState } from "react";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import {
  CardSurface,
  ListRow,
  PrimaryButton,
  ScreenScaffold,
  SectionSurface,
  SecondaryButton,
  TextField,
} from "@/design-system";

export default function ParentQuickControlRoute() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId: string }>();
  const [search, setSearch] = useState("");
  const [domain, setDomain] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const children = useQuery({ queryKey: ["children", familyId], queryFn: () => api.children(familyId), enabled: Boolean(familyId) });
  const inventory = useQuery({
    queryKey: ["child-inventory", familyId, childId],
    queryFn: () => api.childInventory(familyId, childId),
    enabled: Boolean(familyId && childId),
  });
  const mutate = useMutation({
    mutationFn: (input: Parameters<typeof api.mutatePolicy>[2]) => api.mutatePolicy(familyId, childId, input),
    onSuccess: (result) => {
      setMessage(`Saved policy version ${result.policy_version}. Waiting for device acknowledgement.`);
      void queryClient.invalidateQueries({ queryKey: ["children", familyId] });
      void queryClient.invalidateQueries({ queryKey: ["child-inventory", familyId, childId] });
    },
    onError: () => setMessage("This control could not be saved."),
  });
  const quickPolicy = useMutation({
    mutationFn: (operation: "TEMPORARY_SCREEN_TIME" | "PAUSE_INTERNET" | "RESUME_INTERNET") => api.mutatePolicy(familyId, childId, {
      operation,
      target: operation === "PAUSE_INTERNET" || operation === "RESUME_INTERNET" ? "pause-internet" : "device",
      ...(operation === "TEMPORARY_SCREEN_TIME" ? { value: 15, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() } : {}),
    }),
    onSuccess: () => setMessage("Signed policy mutation delivered to the child device."),
  });
  const child = children.data?.find((item) => item.id === childId);
  const actions = useMemo(() => [
    ["Rules", () => router.push({ pathname: "/parent/rules", params: { familyId, childId } })],
    ["Requests", () => router.push({ pathname: "/parent/requests", params: { familyId, childId } })],
    ["Activity", () => router.push({ pathname: "/parent/activity", params: { familyId, childId } })],
    ["Protection health", () => router.push({ pathname: "/parent/health", params: { familyId, childId } })],
  ] as const, [childId, familyId, router]);
  const filtered = actions.filter(([label]) => label.toLowerCase().includes(search.toLowerCase()));
  return (
    <ScreenScaffold title="Quick control">
      <SectionSurface>
        <Text>Immediate actions</Text>
        <PrimaryButton label="Add 15 minutes" onPress={() => quickPolicy.mutate("TEMPORARY_SCREEN_TIME")} />
        <PrimaryButton label="Pause child internet" onPress={() => quickPolicy.mutate("PAUSE_INTERNET")} />
        <SecondaryButton label="Resume child internet" onPress={() => quickPolicy.mutate("RESUME_INTERNET")} />
      </SectionSurface>
      <SectionSurface>
        <Text>{child?.name ?? "Child"} · Search a control</Text>
        <TextField label="Search" value={search} onChangeText={setSearch} />
        {filtered.length ? filtered.map(([label, onPress]) => <CardSurface key={label}><ListRow label={label} onPress={onPress} /></CardSurface>) : <Text>No matching control.</Text>}
      </SectionSurface>
      <SectionSurface>
        <Text>Apps</Text>
        {inventory.data?.length ? inventory.data.slice(0, 8).map((app) => (
          <CardSurface key={app.platform_app_id}>
            <ListRow label={app.display_name} value={app.category ?? "Unknown"} />
            <PrimaryButton
              label={`Block ${app.display_name}`}
              onPress={() => mutate.mutate({ operation: "APP_BLOCK", target: app.platform_app_id })}
              disabled={mutate.isPending}
            />
          </CardSurface>
        )) : <Text>No installed apps are available yet.</Text>}
      </SectionSurface>
      <SectionSurface>
        <Text>Website</Text>
        <TextField label="Website or domain" value={domain} onChangeText={setDomain} />
        <PrimaryButton
          label="Block website"
          disabled={!domain.trim() || mutate.isPending}
          onPress={() => mutate.mutate({ operation: "DOMAIN_BLOCK", target: domain.trim() })}
        />
      </SectionSurface>
      <SectionSurface>
        <Text>Bedtime</Text>
        <Text>Use the bedtime routine in Rules to edit its schedule.</Text>
        <SecondaryButton
          label="Edit bedtime in Rules"
          onPress={() => router.push({ pathname: "/parent/rules", params: { familyId, childId } })}
        />
      </SectionSurface>
      {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
    </ScreenScaffold>
  );
}
