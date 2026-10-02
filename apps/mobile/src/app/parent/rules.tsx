import { useMemo, useState } from "react";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PolicyMutationInput } from "@/api/client";
import { useNetworkStatus } from "@/state/network";
import {
  CardSurface,
  DataState,
  ListRow,
  PrimaryButton,
  ScreenScaffold,
  SecondaryButton,
  SectionSurface,
  TextField,
} from "@/design-system";

type PolicyRecord = Record<string, unknown>;
type AppRule = { app_ref?: string; action?: string; daily_minutes?: number; schedule?: { days?: number[]; start?: string; end?: string } };
type DomainRule = { domain?: string; action?: string };
type Routine = { routine_id: string; name: string; kind: "MANUAL" | "SCHEDULED"; blocked_categories?: string[]; blocked_apps?: string[]; window?: { days?: number[]; start?: string; end?: string } };
type InventoryApp = { platform_app_id: string; display_name: string; category: string | null; reviewed: boolean };

function record(value: unknown): PolicyRecord {
  return value && typeof value === "object" ? value as PolicyRecord : {};
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

// Inventory arrives from independent package/usage/notification sources. Keep
// controls keyed by package ID and sort only a copied view so refreshes cannot
// move an in-progress edit to a neighbouring app.
export function stableObservedApps(apps: InventoryApp[]): InventoryApp[] {
  return [...apps].sort((left, right) => (
    left.display_name.localeCompare(right.display_name, undefined, { sensitivity: "base" })
    || left.platform_app_id.localeCompare(right.platform_app_id)
  ));
}

export default function ParentRulesRoute() {
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [categoryMinutes, setCategoryMinutes] = useState("30");
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appLimitDrafts, setAppLimitDrafts] = useState<Record<string, string>>({});
  const [appScheduleDrafts, setAppScheduleDrafts] = useState<Record<string, { start: string; end: string }>>({});
  const [message, setMessage] = useState<string | null>(null);
  const { isOffline } = useNetworkStatus();
  const children = useQuery({
    queryKey: ["children", familyId],
    queryFn: () => api.children(familyId),
    enabled: Boolean(familyId),
  });
  const inventory = useQuery({
    queryKey: ["child-inventory", familyId, childId],
    queryFn: () => api.childInventory(familyId, childId),
    enabled: Boolean(familyId && childId),
  });
  const reputation = useQuery({
    queryKey: ["reputation", familyId, childId],
    queryFn: () => api.reputationStatus(familyId, childId),
    enabled: Boolean(familyId && childId),
  });
  const health = useQuery({
    queryKey: ["health", familyId, childId],
    queryFn: () => api.health(familyId, childId),
    enabled: Boolean(familyId && childId),
    refetchInterval: 2000,
  });
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const mutate = useMutation({
    mutationFn: (input: PolicyMutationInput) => api.mutatePolicy(familyId, childId, input),
    onSuccess: (result) => {
      setPendingVersion(result.policy_version);
      setMessage(`Saved policy version ${result.policy_version}. Waiting for device acknowledgement.`);
      void queryClient.invalidateQueries({ queryKey: ["children", familyId] });
      void queryClient.invalidateQueries({ queryKey: ["health", familyId] });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "This rule could not be saved."),
  });
  const child = children.data?.find((item) => item.id === childId);
  const policy = record(child?.policy_document);
  const appRules = list<AppRule>(policy.app_rules);
  const domainRules = list<DomainRule>(policy.domain_rules);
  const basePolicy = record(policy.base_policy);
  const communicationPolicy = record(policy.communication_safety);
  const contentSafetyPolicy = record(policy.content_safety);
  const routines = list<Routine>(policy.routines);
  const acknowledged = health.data?.some((item) => item.child_profile_id === childId && item.policy_version_applied === pendingVersion);
  const syncState = pendingVersion === null || acknowledged ? "Rules active on device." : `Pending sync · device has not acknowledged version ${pendingVersion}.`;
  const apps = useMemo(() => stableObservedApps((inventory.data ?? []) as InventoryApp[]), [inventory.data]);
  const selectedApp: InventoryApp | undefined = apps.find(
    (app) => app.platform_app_id === selectedAppId,
  ) ?? apps.at(0);
  const selectedRule = appRules.find((candidate) => candidate.app_ref === selectedApp?.platform_app_id);
  const selectedAppLimit = selectedApp
    ? appLimitDrafts[selectedApp.platform_app_id] ?? String(selectedRule?.daily_minutes ?? 30)
    : "30";
  const selectedSchedule = selectedApp
    ? appScheduleDrafts[selectedApp.platform_app_id]
      ?? { start: selectedRule?.schedule?.start ?? "09:00", end: selectedRule?.schedule?.end ?? "17:00" }
    : { start: "09:00", end: "17:00" };

  const save = (input: PolicyMutationInput) => {
    if (mutate.isPending) return;
    setMessage(null);
    mutate.mutate(input);
  };

  const reviewApp = async (platformAppId: string) => {
    await api.reviewChildApp(familyId, childId, platformAppId);
    setMessage("App reviewed. Its inventory status is now up to date.");
    await inventory.refetch();
  };

  return (
    <ScreenScaffold title="Rules">
      <DataState state={children.isLoading || inventory.isLoading ? "loading" : children.isError || inventory.isError ? "error" : isOffline ? "offline" : children.isStale || inventory.isStale ? "stale" : "loaded"} onRetry={() => { void children.refetch(); void inventory.refetch(); void reputation.refetch(); }}>
        <SectionSurface>
          <Text>{child?.name ?? "Child"} · {syncState}</Text>
          <Text>Changes are not active until this device acknowledges the new policy version.</Text>
          {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
        </SectionSurface>
        <SectionSurface>
          <Text>Communication Safety</Text>
          <Text>
            Optional Android notification signals. Message text is analyzed in memory and discarded;
            parents receive only category, severity, source app, time, confidence, and reason.
          </Text>
          <SecondaryButton
            label={communicationPolicy.enabled === true ? "Disable Communication Safety" : "Enable Communication Safety"}
            onPress={() => save({
              operation: "COMMUNICATION_ENABLED",
              target: "communication_safety",
              value: communicationPolicy.enabled !== true,
            })}
          />
          <Text>
            Alert sensitivity: {typeof communicationPolicy.severity_threshold === "string" ? communicationPolicy.severity_threshold : "HIGH"}
          </Text>
          {(["HIGH", "MEDIUM", "LOW"] as const).map((threshold) => (
            <SecondaryButton
              key={threshold}
              label={`Use ${threshold} alert threshold`}
              onPress={() => save({
                operation: "COMMUNICATION_SENSITIVITY",
                target: "communication_safety",
                value: threshold,
              })}
            />
          ))}
          <Text>
            iPhone/iPad: Not available on iPhone/iPad. Android requires notification-listener consent;
            if permission is revoked, signals stop and access can be restored in Settings.
          </Text>
        </SectionSurface>
        <SectionSurface>
          <Text>Content Safety</Text>
          <Text>
            Block content at: {typeof contentSafetyPolicy.content_block_threshold === "string"
              ? contentSafetyPolicy.content_block_threshold
              : "age-based default"}
          </Text>
          <Text>
            This controls local content blocking and Ask Parent. It does not change notification alert sensitivity.
          </Text>
          {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).map((threshold) => (
            <SecondaryButton
              key={threshold}
              label={`Use ${threshold} content block threshold`}
              onPress={() => save({
                operation: "CONTENT_BLOCK_THRESHOLD",
                target: "content_safety",
                value: threshold,
              })}
            />
          ))}
        </SectionSurface>
        <SectionSurface>
          <Text>App controls</Text>
          <Text>Apps are alphabetized for a stable list. Select one app to edit its own limit and schedule.</Text>
          {apps.map((app) => {
            const rule = appRules.find((candidate) => candidate.app_ref === app.platform_app_id);
            const isSelected = selectedApp?.platform_app_id === app.platform_app_id;
            return (
              <CardSurface key={app.platform_app_id}>
                <ListRow label={app.display_name} value={`${rule?.action ?? "No rule"}${!app.reviewed ? " · New app" : ""}`} onPress={() => setSelectedAppId(app.platform_app_id)} />
                {!app.reviewed ? (
                  <>
                    <Text>This app was newly observed on the child device. Review it before treating it as trusted.</Text>
                    <SecondaryButton label="Mark app reviewed" onPress={() => { void reviewApp(app.platform_app_id); }} />
                  </>
                ) : null}
                <SecondaryButton label={isSelected ? "Editing controls" : "Edit controls"} onPress={() => setSelectedAppId(app.platform_app_id)} />
              </CardSurface>
            );
          })}
          {selectedApp ? (
            <CardSurface>
              <Text>Controls for {selectedApp.display_name}</Text>
              <TextField
                label={`Daily limit for ${selectedApp.display_name} (minutes)`}
                value={selectedAppLimit}
                onChangeText={(value) => setAppLimitDrafts((drafts) => ({ ...drafts, [selectedApp.platform_app_id]: value }))}
                keyboardType="numeric"
              />
              <PrimaryButton label="Allow" disabled={mutate.isPending} onPress={() => save({ operation: "APP_ALLOW", target: selectedApp.platform_app_id })} />
              <PrimaryButton label="Block" disabled={mutate.isPending} onPress={() => save({ operation: "APP_BLOCK", target: selectedApp.platform_app_id })} />
              <SecondaryButton label={`Limit to ${selectedAppLimit || "30"} minutes`} disabled={mutate.isPending} onPress={() => save({ operation: "APP_DAILY_MINUTES", target: selectedApp.platform_app_id, value: Number(selectedAppLimit) || 30 })} />
              <TextField
                label={`Schedule start for ${selectedApp.display_name} (HH:MM)`}
                value={selectedSchedule.start}
                onChangeText={(start) => setAppScheduleDrafts((drafts) => ({ ...drafts, [selectedApp.platform_app_id]: { ...selectedSchedule, start } }))}
              />
              <TextField
                label={`Schedule end for ${selectedApp.display_name} (HH:MM)`}
                value={selectedSchedule.end}
                onChangeText={(end) => setAppScheduleDrafts((drafts) => ({ ...drafts, [selectedApp.platform_app_id]: { ...selectedSchedule, end } }))}
              />
              <SecondaryButton label="Save weekday schedule" disabled={mutate.isPending} onPress={() => save({ operation: "APP_SCHEDULE", target: selectedApp.platform_app_id, value: { days: [1, 2, 3, 4, 5], start: selectedSchedule.start, end: selectedSchedule.end } })} />
              <SecondaryButton label="Unlimited" disabled={mutate.isPending} onPress={() => save({ operation: "APP_UNLIMITED", target: selectedApp.platform_app_id })} />
            </CardSurface>
          ) : <Text>No observed apps yet. Guardian will add apps when Android exposes them.</Text>}
        </SectionSurface>
        <SectionSurface>
          <Text>Website controls</Text>
          {domainRules.map((rule) => <ListRow key={`${rule.domain}-${rule.action}`} label={rule.domain ?? "Unknown domain"} value={rule.action ?? "Unknown"} />)}
          <TextField label="Website or domain" value={domain} onChangeText={setDomain} keyboardType="default" />
          <PrimaryButton label="Block website" disabled={!domain.trim()} onPress={() => save({ operation: "DOMAIN_BLOCK", target: domain.trim() })} />
          <SecondaryButton label="Allow website" disabled={!domain.trim()} onPress={() => save({ operation: "DOMAIN_ALLOW", target: domain.trim() })} />
          <Text>Unknown websites: {typeof basePolicy.unknown_domain_policy === "string" ? basePolicy.unknown_domain_policy : "Unknown"}</Text>
          <SecondaryButton label="Block unknown websites" onPress={() => save({ operation: "UNKNOWN_DOMAIN_POLICY", target: "unknown", value: "BLOCK" })} />
          <SecondaryButton label="Allow unknown websites with notice" onPress={() => save({ operation: "UNKNOWN_DOMAIN_POLICY", target: "unknown", value: "ALLOW_AND_NOTIFY" })} />
          <Text>Reputation bundle: {reputation.data ? `version ${reputation.data.current_version}` : "Still classifying"}</Text>
          {reputation.isError ? <Text accessibilityRole="alert">Reputation updates are unavailable. Existing parent rules remain usable and active.</Text> : null}
          {(reputation.data?.entries ?? []).map((entry) => (
            <ListRow
              key={`${entry.target_kind}:${entry.identifier}`}
              label={entry.identifier}
              value={`${entry.verdict} · ${entry.source}`}
            />
          ))}
          {reputation.isFetching ? <Text>Still classifying reputation entries…</Text> : null}
          <Text>Unknown apps: {typeof basePolicy.unknown_app_policy === "string" ? basePolicy.unknown_app_policy : "Unknown"}</Text>
          <SecondaryButton label="Block unknown apps" onPress={() => save({ operation: "UNKNOWN_APP_POLICY", target: "unknown", value: "BLOCK" })} />
          <SecondaryButton label="Allow unknown apps with notice" onPress={() => save({ operation: "UNKNOWN_APP_POLICY", target: "unknown", value: "ALLOW_AND_NOTIFY" })} />
        </SectionSurface>
        <SectionSurface>
          <Text>Category budgets</Text>
          <TextField label="Category daily limit minutes" value={categoryMinutes} onChangeText={setCategoryMinutes} keyboardType="numeric" />
          {["SOCIAL_MEDIA", "STREAMING_VIDEO", "GAMES", "MESSAGING"].map((category) => (
            <CardSurface key={category}>
              <ListRow label={category} value="Set this category's daily budget." />
              <SecondaryButton label={`Limit ${category}`} onPress={() => save({ operation: "CATEGORY_DAILY_MINUTES", target: category, value: Number(categoryMinutes) || 30 })} />
            </CardSurface>
          ))}
          <Text>Web strictness is applied through category rules and unknown-content policy.</Text>
          <SecondaryButton label="Block social media" onPress={() => save({ operation: "WEB_CATEGORY_BLOCK", target: "SOCIAL_MEDIA" })} />
        </SectionSurface>
        <SectionSurface>
          <Text>Routines</Text>
          {routines.map((routine) => (
            <CardSurface key={routine.routine_id}>
              <ListRow label={routine.name} value={routine.kind} />
              <SecondaryButton label="Open routine editor" onPress={() => router.push({ pathname: "/parent/routine-editor", params: { familyId, childId, routineId: routine.routine_id } })} />
              {routine.kind === "MANUAL" ? (
                <>
                  <SecondaryButton label="Activate on child's device" onPress={() => save({ operation: "ROUTINE_ACTIVATE", target: routine.routine_id })} />
                  <SecondaryButton label="Deactivate on child's device" onPress={() => save({ operation: "ROUTINE_DEACTIVATE", target: routine.routine_id })} />
                </>
              ) : null}
              <SecondaryButton label="Delete routine" onPress={() => save({ operation: "ROUTINE_DELETE", target: routine.routine_id })} />
            </CardSurface>
          ))}
          <PrimaryButton
            label="Add manual routine"
            onPress={() => save({
              operation: "ROUTINE_CREATE",
              target: "new",
              value: { routine_id: `manual-${Date.now()}`, name: "Focus time", kind: "MANUAL", blocked_categories: ["SOCIAL_MEDIA", "GAMES"] },
            })}
          />
          <Text>Manual activation is delivered in the signed policy and becomes active only after the child device acknowledges it.</Text>
        </SectionSurface>
      </DataState>
    </ScreenScaffold>
  );
}
