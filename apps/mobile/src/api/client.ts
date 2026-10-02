import * as SecureStore from "expo-secure-store";
import { signDeviceRequest } from "@/api/device-signing";
import {
  GeneratedGuardianClient,
  type GuardianApiPath,
} from "@guardian/api-client";
import type {
  CapabilityLevel,
  ContentAction,
  ContentApproval,
  ContentReviewEvidence,
  ContentRiskSeverity,
  SignalSource,
} from "@guardian/contracts";

export type ApiErrorBody = { error?: { code?: string; message?: string } };
export type Tokens = { access_token: string; refresh_token: string; token_type?: string };
export type Parent = { id: string; email: string; email_verified_at?: string | null };
export type Family = { id: string; name: string };
export type Guardian = { id: string; family_id: string; parent_id: string; role: string };
export type Child = { id: string; family_id: string; name: string; date_of_birth: string; age_band: string; timezone: string; policy_document?: unknown };
export type Pairing = { session_id: string; code: string; qr_payload: string; expires_at: string };
export type DeviceCredentials = { device_id: string; device_token: string; family_id: string };
export type Health = { child_profile_id: string; device_id: string; state: "PROTECTED" | "DEGRADED" | "UNKNOWN"; last_seen_at: string | null; policy_version_applied: number | null };
export type PolicyMutationInput = {
  operation:
    | "APP_ALLOW"
    | "APP_BLOCK"
    | "APP_UNLIMITED"
    | "APP_DAILY_MINUTES"
    | "APP_SCHEDULE"
    | "DOMAIN_ALLOW"
    | "DOMAIN_BLOCK"
    | "CATEGORY_DAILY_MINUTES"
    | "WEB_CATEGORY_ALLOW"
    | "WEB_CATEGORY_BLOCK"
    | "UNKNOWN_DOMAIN_POLICY"
    | "UNKNOWN_APP_POLICY"
    | "ROUTINE_CREATE"
    | "ROUTINE_UPDATE"
    | "ROUTINE_DELETE"
    | "ROUTINE_ACTIVATE"
    | "ROUTINE_DEACTIVATE"
    | "COMMUNICATION_SENSITIVITY"
    | "COMMUNICATION_ENABLED"
    | "CONTENT_BLOCK_THRESHOLD"
    | "TEMPORARY_SCREEN_TIME"
    | "PAUSE_INTERNET"
    | "RESUME_INTERNET";
  target: string;
  value?: unknown;
  expires_at?: string;
};
export type PolicyMutation = {
  bundle: unknown;
  policy_version: number;
  effective_at: string;
  expires_at: string | null;
};
export type AccessRequest = {
  id: string;
  child_profile_id: string;
  device_id: string;
  request_type: "MORE_TIME" | "UNBLOCK_APP" | "UNBLOCK_SITE" | "CONTENT_REVIEW";
  subject: string | null;
  state: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "CANCELLED";
  reason: string | null;
  decision_reason: string | null;
  expires_at: string | null;
  content_review?: ContentReviewEvidence | null;
};
export type ContentReviewRequestInput = {
  request_type: "CONTENT_REVIEW";
  content_review: ContentReviewEvidence;
  subject?: never;
  reason?: never;
};
export type StandardRequestInput = {
  request_type: "MORE_TIME" | "UNBLOCK_APP" | "UNBLOCK_SITE";
  subject?: string | null;
  reason?: string | null;
};
export type DeviceRequestInput = StandardRequestInput | ContentReviewRequestInput;
export type RequestPushPayload = {
  type: string;
  request_id: string;
  title: string;
  body: string;
  actions: Array<{
    id: string;
    label: string;
    method: string;
    path: string;
  }>;
};
export type ActivityEvent = {
  id: string;
  kind: "WEB" | "SAFETY";
  event_type: string;
  occurred_at: string;
  domain: string | null;
  app_ref: string | null;
  category: string | null;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  confidence: number | null;
  reason_code: string | null;
};
export type ActivityUsagePoint = {
  app_ref: string | null;
  category: string | null;
  duration_seconds: number;
  event_type: string;
  occurred_at: string;
};
export type UsageReport = {
  child_profile_id: string;
  period_start: string;
  period_end: string;
  timezone: string;
  duration_seconds: number;
  event_count: number;
  by_app: Record<string, number>;
  by_category: Record<string, number>;
  unattributed_seconds: number;
  coverage: "COMPLETE" | "PARTIAL";
};
export type DeviceEvent = {
  event_type: string;
  occurred_at: string;
  app_ref?: string | null;
  domain?: string | null;
  category?: string | null;
  severity?: ContentRiskSeverity | null;
  confidence?: number | null;
  reason_code?: string | null;
  signal_source?: SignalSource | null;
  action?: ContentAction | null;
  classifier_version?: string | null;
  capability_level?: CapabilityLevel | null;
  content_fingerprint?: string | null;
  public_content_ref?: { provider: "YOUTUBE" | "INSTAGRAM" | "X" | "WEB"; content_id: string } | null;
  timezone?: string;
  duration_seconds?: number;
};
export type ObservedApp = {
  platform_app_id: string;
  display_name: string;
  category: string | null;
  observed_at: string;
  reviewed: boolean;
  version_name: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  installation_state: "INSTALLED" | "UNINSTALLED_OR_NOT_VISIBLE" | null;
  capability_sources: Array<
    "LAUNCHER" | "USAGE_STATS" | "NOTIFICATION" | "VPN_ATTRIBUTION" | "ACCESSIBILITY_FOREGROUND"
  >;
  inventory_completeness: "PARTIAL" | null;
};
export type ReputationEntry = {
  target_kind: "DOMAIN" | "APP";
  identifier: string;
  verdict: "KNOWN_SAFE" | "KNOWN_RISK" | "UNKNOWN";
  source: string;
  rationale: string;
  expires_at: string;
  bundle_version: number;
};

const configuredApiUrl = typeof process.env.EXPO_PUBLIC_API_URL === "string"
  ? process.env.EXPO_PUBLIC_API_URL.replace(/\/+$/, "")
  : undefined;
const API_URL = configuredApiUrl ?? (__DEV__ ? "http://10.0.2.2:8000" : "");
if (!API_URL && !__DEV__) {
  throw new Error("Release builds require an explicitly configured HTTPS API URL.");
}
if (!__DEV__ && !API_URL.startsWith("https://")) {
  throw new Error("Release builds require an HTTPS API URL.");
}
const ACCESS_TOKEN_KEY = "guardian.access-token";
const REFRESH_TOKEN_KEY = "guardian.refresh-token";
const DEVICE_TOKEN_KEY = "guardian.device-token";
const DEVICE_PRIVATE_KEY_KEY = "guardian.device-private-key";
const FAMILY_ID_KEY = "guardian.family-id";
const SELECTED_CHILD_ID_KEY = "guardian.selected-child-id";
const DEVICE_IDENTITY_KEYS = [
  DEVICE_TOKEN_KEY,
  DEVICE_PRIVATE_KEY_KEY,
  FAMILY_ID_KEY,
  SELECTED_CHILD_ID_KEY,
] as const;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

type ParentSessionExpiryListener = () => void;
let parentSessionExpiryListener: ParentSessionExpiryListener | null = null;

export function subscribeToParentSessionExpiry(listener: ParentSessionExpiryListener) {
  parentSessionExpiryListener = listener;
  return () => {
    if (parentSessionExpiryListener === listener) parentSessionExpiryListener = null;
  };
}

export const sessionStorage = {
  getAccessToken: () => SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
  getRefreshToken: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
  setTokens: async (tokens: Tokens) => {
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.access_token);
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refresh_token);
  },
  // Parent auth and the child device credential are independent.  A parent
  // session expiry must never silently unpair the child or stop protection.
  clearParentSession: async () => {
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  },
  clearDeviceIdentity: async () => {
    const results = await Promise.allSettled(
      DEVICE_IDENTITY_KEYS.map((key) => SecureStore.deleteItemAsync(key)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  },
  // Retained for explicit account deletion/unpair flows only.
  clear: async () => {
    await sessionStorage.clearParentSession();
    await sessionStorage.clearDeviceIdentity();
  },
  getDeviceToken: () => SecureStore.getItemAsync(DEVICE_TOKEN_KEY),
  setDeviceToken: (token: string) => SecureStore.setItemAsync(DEVICE_TOKEN_KEY, token),
  setDevicePrivateKey: (key: string) => SecureStore.setItemAsync(DEVICE_PRIVATE_KEY_KEY, key),
  getFamilyId: () => SecureStore.getItemAsync(FAMILY_ID_KEY),
  setFamilyId: (familyId: string) => SecureStore.setItemAsync(FAMILY_ID_KEY, familyId),
  getSelectedChildId: () => SecureStore.getItemAsync(SELECTED_CHILD_ID_KEY),
  setSelectedChildId: (childId: string) => SecureStore.setItemAsync(SELECTED_CHILD_ID_KEY, childId),
  saveDeviceCredentials: async ({
    privateKey,
    familyId,
    deviceToken,
  }: {
    privateKey: string;
    familyId: string;
    deviceToken: string;
  }) => {
    try {
      await SecureStore.setItemAsync(DEVICE_PRIVATE_KEY_KEY, privateKey);
      await SecureStore.setItemAsync(FAMILY_ID_KEY, familyId);
      // The bearer token is committed last so it can never outlive its proof material.
      await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, deviceToken);
    } catch (error) {
      await sessionStorage.clearDeviceIdentity().catch(() => undefined);
      throw error;
    }
  },
};

export class GuardianApiClient {
  private readonly generated: GeneratedGuardianClient;
  private refreshInFlight: Promise<Tokens> | null = null;
  private readonly baseUrl: string;

  constructor(baseUrl = API_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.generated = new GeneratedGuardianClient(this.baseUrl);
  }

  private async refreshParentSession(): Promise<Tokens> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        const refreshToken = await sessionStorage.getRefreshToken();
        if (!refreshToken) throw new Error("No refresh token is available.");
        const refreshed = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!refreshed.ok) throw new Error("Refresh token is invalid.");
        const tokens = (await refreshed.json()) as Tokens;
        await sessionStorage.setTokens(tokens);
        return tokens;
      })().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const accessToken = await sessionStorage.getAccessToken();
    const deviceToken = await sessionStorage.getDeviceToken();
    const deviceAuthenticated = Boolean(deviceToken && path.startsWith("/v1/devices"));
    const headers = new Headers(init.headers);
    const requestId = headers.get("X-Request-ID") ?? `guardian-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    headers.set("X-Request-ID", requestId);
    headers.set("Content-Type", "application/json");
    if (deviceAuthenticated) headers.set("Authorization", `Bearer ${deviceToken}`);
    else if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    if (deviceAuthenticated && init.method && init.method !== "GET") {
      const privateKey = await SecureStore.getItemAsync(DEVICE_PRIVATE_KEY_KEY);
      if (!privateKey) throw new ApiError("Device proof is unavailable.", 401, "DEVICE_PROOF_MISSING");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const body = typeof init.body === "string" ? init.body : "";
      headers.set("X-Guardian-Device-Timestamp", timestamp);
      headers.set("X-Guardian-Device-Nonce", nonce);
      headers.set(
        "X-Guardian-Device-Signature",
        await signDeviceRequest(privateKey, init.method, path, timestamp, nonce, body),
      );
    }
    try {
      return await this.generated.request<T>(path as GuardianApiPath, {
        ...init,
        headers,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401 && retry && accessToken && !deviceAuthenticated) {
        try {
          // A different request may already have refreshed the session while
          // this request was in flight. Reuse that token before attempting a
          // second refresh; the retry remains bounded to one attempt.
          const currentAccessToken = await sessionStorage.getAccessToken();
          if (currentAccessToken && currentAccessToken !== accessToken) {
            return await this.request<T>(path, init, false);
          }
          await this.refreshParentSession();
          return await this.request<T>(path, init, false);
        } catch {
          await sessionStorage.clearParentSession();
          parentSessionExpiryListener?.();
          throw new ApiError(
            "Your parent session has expired. Sign in again.",
            401,
            "SESSION_EXPIRED",
            requestId,
          );
        }
      }
      if (error instanceof Error) {
        throw new ApiError(
          error.message,
          status ?? 0,
          (error as { code?: string }).code,
          requestId,
        );
      }
      throw error;
    }
  }

  signup(email: string, password: string) { return this.request<Tokens>("/v1/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }); }
  login(email: string, password: string) { return this.request<Tokens>("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); }
  async logout(): Promise<void> {
    const refreshToken = await sessionStorage.getRefreshToken();
    try {
      if (refreshToken) {
        await fetch(`${this.baseUrl}/v1/auth/logout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      }
    } catch {
      // Local parent credentials must be cleared even when the device is offline.
    } finally {
      await sessionStorage.clearParentSession();
    }
  }
  me() { return this.request<Parent>("/v1/auth/me"); }
  deleteAccount() { return this.request<undefined>("/v1/auth/account", { method: "DELETE" }); }
  createFamily(name: string) { return this.request<Family>("/v1/families", { method: "POST", body: JSON.stringify({ name }) }); }
  families() { return this.request<Family[]>("/v1/families"); }
  family(familyId: string) { return this.request<Family>(`/v1/families/${familyId}`); }
  guardians(familyId: string) { return this.request<Guardian[]>(`/v1/families/${familyId}/guardians`); }
  createChild(familyId: string, input: { name: string; date_of_birth: string; timezone: string }) { return this.request<Child>(`/v1/families/${familyId}/children`, { method: "POST", body: JSON.stringify(input) }); }
  children(familyId: string) { return this.request<Child[]>(`/v1/families/${familyId}/children`); }
  child(familyId: string, childId: string) { return this.request<Child>(`/v1/families/${familyId}/children/${childId}`); }
  health(familyId: string, childId?: string) {
    return this.request<Health[]>(`/v1/families/${familyId}/health${childId ? `?child_id=${encodeURIComponent(childId)}` : ""}`);
  }
  activity(familyId: string, childId?: string) {
    return this.request<ActivityEvent[]>(`/v1/families/${familyId}/activity${childId ? `?child_id=${encodeURIComponent(childId)}` : ""}`);
  }
  activityUsage(familyId: string, childId?: string) {
    return this.request<ActivityUsagePoint[]>(`/v1/families/${familyId}/activity/usage${childId ? `?child_id=${encodeURIComponent(childId)}` : ""}`);
  }
  usageReport(familyId: string, input: { childId?: string; start: string; end: string; timezone: string; granularity?: "DAILY" | "WEEKLY" }) {
    const params = new URLSearchParams({
      start: input.start,
      end: input.end,
      timezone: input.timezone,
      ...(input.granularity ? { granularity: input.granularity } : {}),
      ...(input.childId ? { child_id: input.childId } : {}),
    });
    return this.request<UsageReport[]>(`/v1/families/${familyId}/usage/reports?${params.toString()}`);
  }
  childInventory(familyId: string, childId: string) {
    return this.request<ObservedApp[]>(`/v1/families/${familyId}/children/${childId}/inventory`);
  }
  reviewChildApp(familyId: string, childId: string, platformAppId: string) {
    return this.request<undefined>(
      `/v1/families/${familyId}/children/${childId}/inventory/${encodeURIComponent(platformAppId)}/review`,
      { method: "POST" },
    );
  }
  createPairing(familyId: string, childId: string) { return this.request<Pairing>(`/v1/families/${familyId}/children/${childId}/pairing`, { method: "POST" }); }
  redeemPairing(input: { session_id: string; code: string; child_profile_id: string; platform: "ANDROID" | "IOS"; public_key: string }) { return this.request<DeviceCredentials>("/v1/devices/pair", { method: "POST", body: JSON.stringify(input) }); }
  policy() { return this.request<{ bundle: unknown; policy_version: number; version_mismatch: boolean }>("/v1/devices/me/policy"); }
  acknowledgePolicy(policyVersion: number) {
    return this.request<undefined>("/v1/devices/me/policy/ack", {
      method: "POST",
      body: JSON.stringify({ policy_version: policyVersion }),
    });
  }
  reputation(version = 0) {
    return this.request<{ current_version: number; bundle: Record<string, unknown> | null; deltas: unknown[] }>(
      `/v1/devices/me/reputation?version=${version}`,
    );
  }
  classifyDomain(identifier: string) {
    return this.request<{ identifier: string; verdict: ReputationEntry["verdict"]; state: "RESOLVED" | "PENDING"; reason: string }>(
      "/v1/devices/me/reputation/classify",
      { method: "POST", body: JSON.stringify({ identifier }) },
    );
  }
  reputationStatus(familyId: string, childId: string) {
    return this.request<{ current_version: number; entries: ReputationEntry[] }>(
      `/v1/families/${familyId}/children/${childId}/reputation`,
    );
  }
  heartbeat(body: { protection_state: "HEALTHY" | "DEGRADED" | "DISABLED" | "UNKNOWN"; capabilities: unknown }) {
    return this.request<undefined>("/v1/devices/me/heartbeat", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  ingestEvents(events: DeviceEvent[], correlationId?: string, idempotencyKey?: string) {
    return this.request<undefined>("/v1/devices/me/events", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey ?? `event-batch:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        ...(correlationId ? { "X-Request-ID": correlationId } : {}),
      },
      body: JSON.stringify({ events }),
    });
  }
  ingestInventory(apps: Array<{
    platform_app_id: string;
    display_name: string;
    category?: string | null;
    observed_at: string;
    version_name?: string | null;
    first_seen_at?: string;
    last_seen_at?: string;
    installation_state?: "INSTALLED" | "UNINSTALLED_OR_NOT_VISIBLE";
    capability_sources?: Array<
      "LAUNCHER" | "USAGE_STATS" | "NOTIFICATION" | "VPN_ATTRIBUTION" | "ACCESSIBILITY_FOREGROUND"
    >;
    inventory_completeness?: "PARTIAL";
  }>) {
    return this.request<undefined>("/v1/devices/me/inventory", {
      method: "POST",
      body: JSON.stringify({ apps }),
    });
  }
  mutatePolicy(familyId: string, childId: string, input: PolicyMutationInput) {
    return this.request<PolicyMutation>(`/v1/families/${familyId}/children/${childId}/policy/mutations`, {
      method: "POST",
      headers: { "Idempotency-Key": `${input.operation}:${input.target}:${Date.now()}` },
      body: JSON.stringify(input),
    });
  }
  createRequest(input: DeviceRequestInput, idempotencyKey?: string) {
    return this.request<AccessRequest>("/v1/devices/me/requests", {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      body: JSON.stringify(input),
    });
  }
  requests(familyId: string, childId?: string) {
    return this.request<AccessRequest[]>(`/v1/families/${familyId}/requests${childId ? `?child_id=${encodeURIComponent(childId)}` : ""}`);
  }
  contentApprovals() {
    return this.request<ContentApproval[]>("/v1/devices/me/content-approvals");
  }
  decideRequest(familyId: string, requestId: string, decision: "approve" | "deny", reason: string) {
    return this.request<AccessRequest>(`/v1/families/${familyId}/requests/${requestId}/${decision}`, {
      method: "POST",
      headers: { "Idempotency-Key": `request-decision:${requestId}:${decision}` },
      body: JSON.stringify({ reason }),
    });
  }
  pushAction(path: string, reason?: string) {
    return this.request<AccessRequest>(path, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    });
  }
  websocketUrl(path: string, params: Record<string, string>) {
    const url = new URL(`${this.baseUrl}${path}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.toString();
  }

  /**
   * Refresh a parent access token before reconnecting realtime transport.
   * Device credentials do not expire through the parent refresh flow, so they
   * are returned directly when no parent session is present.
   */
  async realtimeToken(): Promise<string | null> {
    const accessToken = await sessionStorage.getAccessToken();
    if (!accessToken) return sessionStorage.getDeviceToken();
    try {
      await this.me();
    } catch (error) {
      if (error instanceof ApiError && error.code === "SESSION_EXPIRED") return null;
      // Keep the existing token for transient network failures; the socket
      // fallback remains honest and can retry when connectivity returns.
    }
    return sessionStorage.getAccessToken();
  }
}

export const api = new GuardianApiClient();
