import { Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { CardSurface, DataState, ListRow, ScreenScaffold, SectionSurface } from "@/design-system";

function displayValue(value: unknown, fallback = "Unknown") {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export default function ChildRulesSummaryRoute() {
  const policy = useQuery({ queryKey: ["device-policy"], queryFn: () => api.policy() });
  const bundle = policy.data?.bundle as { base_policy?: Record<string, unknown>; app_rules?: Array<Record<string, unknown>>; category_rules?: Array<Record<string, unknown>> } | undefined;
  const limitedChildBuild = process.env.EXPO_PUBLIC_GUARDIAN_LIMITED_CHILD === "true";
  return <ScreenScaffold title="My simple rules"><DataState state={policy.isLoading ? "loading" : policy.isError ? "error" : bundle ? "loaded" : "empty"} onRetry={() => void policy.refetch()}><SectionSurface><Text>{limitedChildBuild ? "Parent rules · app rules are not enforced in this build" : "What Guardian is enforcing"}</Text><CardSurface><ListRow label={limitedChildBuild ? "Unknown apps (not enforced)" : "Unknown apps"} value={displayValue(bundle?.base_policy?.unknown_app_policy)} /><ListRow label="Unknown websites" value={displayValue(bundle?.base_policy?.unknown_domain_policy)} /></CardSurface>{(bundle?.app_rules ?? []).map((rule) => <ListRow key={displayValue(rule.rule_id)} label={displayValue(rule.app_ref)} value={limitedChildBuild ? `${displayValue(rule.action)} (not enforced)` : displayValue(rule.action)} />)}{(bundle?.category_rules ?? []).map((rule) => <ListRow key={displayValue(rule.rule_id)} label={displayValue(rule.category)} value={displayValue(rule.action)} />)}</SectionSurface></DataState></ScreenScaffold>;
}
