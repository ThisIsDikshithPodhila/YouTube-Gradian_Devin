import { Alert, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useNetworkStatus } from "@/state/network";
import { GuardianProtection } from "../../../modules/guardian-protection/src";
import { CardSurface, DataState, ListRow, PrimaryButton, ScreenScaffold, SectionSurface, ProtectionStatePill, SecondaryButton } from "@/design-system";

export default function ParentHealthRoute() {
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId?: string }>();
  const router = useRouter();
  const { isOffline } = useNetworkStatus();
  const health = useQuery({ queryKey: ["health", familyId, childId], queryFn: () => api.health(familyId, childId), enabled: Boolean(familyId && childId), refetchInterval: 5000 });
  const capabilities = useQuery({ queryKey: ["guardian-capabilities"], queryFn: () => GuardianProtection.getCapabilities(), refetchInterval: 5000 });
  const status = useQuery({ queryKey: ["guardian-status"], queryFn: () => GuardianProtection.getProtectionStatus(), refetchInterval: 5000 });
  const explain = (title: string, message: string, onConfirm: () => void) => Alert.alert(
    title,
    `${message}\n\nGuardian never reads editable input or password fields. When an enabled safety capability exposes notification or active-window text, Guardian processes it briefly on-device and immediately discards the raw text.`,
    [
      { text: "Not now", style: "cancel" },
      { text: "Open settings", onPress: onConfirm },
    ],
  );
  return (
    <ScreenScaffold title="Protection health">
      <DataState state={health.isLoading || capabilities.isLoading || status.isLoading ? "loading" : health.isError || capabilities.isError || status.isError ? "error" : isOffline ? "offline" : health.isStale || capabilities.isStale || status.isStale ? "stale" : "loaded"} onRetry={() => { void health.refetch(); void capabilities.refetch(); void status.refetch(); }}>
        <SectionSurface>
          <SecondaryButton label="Guardian and device settings" onPress={() => router.push({ pathname: "/parent/guardian-device-settings", params: { familyId, childId } })} />
          <SecondaryButton label="Help and troubleshooting" onPress={() => router.push({ pathname: "/parent/help", params: { familyId, childId } })} />
          <SecondaryButton label="Notification settings" onPress={() => router.push({ pathname: "/parent/notification-settings", params: { familyId, childId } })} />
          <Text>Device health</Text>
          {health.data?.length ? health.data.map((item) => <CardSurface key={item.device_id}><ProtectionStatePill state={item.state} /><ListRow label="Last seen" value={item.last_seen_at ? new Date(item.last_seen_at).toLocaleString() : "Unknown"} /><ListRow label="Policy acknowledged" value={item.policy_version_applied === null ? "Unknown" : `Version ${item.policy_version_applied}`} /></CardSurface>) : <Text>Unknown · no paired device health is available.</Text>}
        </SectionSurface>
        <SectionSurface>
          <Text>On-device capabilities</Text>
          {Object.entries(capabilities.data ?? {}).map(([key, value]) => <CardSurface key={key}><ListRow label={key} value={value.level} /><Text>{value.detail ?? "No degraded reason reported."}</Text></CardSurface>)}
          <Text>Usage Access lets Guardian measure foreground time. Accessibility lets Guardian identify the foreground app and enforce limits. Installed-app inventory is partial: Android only exposes launcher apps and apps Guardian actually observes through granted sources. Communication safety is Android-only best effort with notification-listener consent; raw notification content is processed in memory and discarded. On iPhone/iPad: Not available on iPhone/iPad. Guardian never reads editable input or password fields. Optional content-safety inspection runs only after separate consent on the paired child device and only briefly inspects exposed titles and headings.</Text>
          <PrimaryButton label="Open Usage Access" onPress={() => explain("Usage Access", "Guardian uses Usage Access to measure foreground app time and build reports.", () => void GuardianProtection.openUsageAccessSettings())} />
          <PrimaryButton label="Open Accessibility for app limits" onPress={() => explain("Accessibility", "Guardian uses Accessibility to identify the foreground app and enforce app limits where Android allows.", () => void GuardianProtection.openAccessibilitySettings())} />
          <Text>Content-safety inspection is separate and optional. The paired child device must show and accept its own disclosure before it is enabled.</Text>
          <PrimaryButton label="Restore Communication Safety permission" onPress={() => explain("Notification access", "Guardian checks supported communication-app notifications only when Communication Safety is enabled. Raw notification text is discarded.", () => void GuardianProtection.openNotificationAccessSettings())} />
          <PrimaryButton label="Open VPN settings" onPress={() => explain("VPN web protection", "Guardian uses an Android VPN to route DNS messages to a configured encrypted resolver for policy enforcement. It does not decrypt HTTPS or provide full traffic visibility.", () => void GuardianProtection.requestVpnPermission())} />
        </SectionSurface>
        <SectionSurface>
          <Text>Protection status</Text>
          <ListRow label="Active" value={status.data?.active === undefined ? "Unknown" : status.data.active ? "Yes" : "No"} />
          <ListRow label="Health" value={status.data?.health ?? "Unknown"} />
          <Text>{status.data?.details ?? "No degraded reason reported."}</Text>
        </SectionSurface>
      </DataState>
    </ScreenScaffold>
  );
}
