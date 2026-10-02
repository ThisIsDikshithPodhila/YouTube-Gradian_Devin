import hardCategories from "../hard-categories.json" with { type: "json" };
import contentRiskContract from "../content-risk-contract.json" with { type: "json" };

export const AGE_BANDS = ["YOUNG_CHILD", "PRETEEN", "TEEN", "OLDER_TEEN"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const CATEGORIES = [
  "ADULT_PORNOGRAPHY",
  "SEXUAL_CONTENT",
  "GAMBLING",
  "DRUGS_CONTROLLED_SUBSTANCES",
  "ALCOHOL_TOBACCO",
  "GRAPHIC_VIOLENCE_GORE",
  "SELF_HARM_SUICIDE",
  "HATE_EXTREMISM",
  "WEAPONS",
  "MALWARE",
  "PHISHING_SCAMS",
  "ANONYMOUS_CHAT",
  "DATING",
  "PROXY_VPN_TOR",
  "PIRACY",
  "SOCIAL_MEDIA",
  "STREAMING_VIDEO",
  "GAMES",
  "SHOPPING",
  "AI_ASSISTANTS",
  "EDUCATION",
  "SEARCH_ENGINES",
  "NEWS",
  "MESSAGING",
  "PRODUCTIVITY",
  "UNKNOWN"
] as const;
export type Category = (typeof CATEGORIES)[number];

export const HARD_CATEGORIES = hardCategories as unknown as readonly [
  Category,
  ...Category[]
];

export const CAPABILITY_LEVELS = contentRiskContract.capability_levels as unknown as readonly [
  "FULL",
  "LIMITED",
  "BEST_EFFORT",
  "UNAVAILABLE",
  "REGION_LIMITED"
];
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

export const CONTENT_RISK_SIGNAL_SOURCES = contentRiskContract.signal_sources as unknown as readonly [
  "NOTIFICATION",
  "ACCESSIBILITY_TEXT",
  "NETWORK_DESTINATION",
  "USAGE",
  "MEDIA_METADATA"
];
export type SignalSource = (typeof CONTENT_RISK_SIGNAL_SOURCES)[number];

// Content actions are deliberately distinct from policy engine actions: a
// classifier can warn or ask a parent without granting a policy exception.
export const CONTENT_RISK_ACTIONS = contentRiskContract.actions as unknown as readonly [
  "ALLOW",
  "WARN",
  "BLOCK_AND_REQUEST"
];
export type ContentAction = (typeof CONTENT_RISK_ACTIONS)[number];

export const CONTENT_RISK_SEVERITIES = contentRiskContract.severities as unknown as readonly [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL"
];
export type ContentRiskSeverity = (typeof CONTENT_RISK_SEVERITIES)[number];

export const CONTENT_RISK_CATEGORIES = contentRiskContract.categories as unknown as readonly [
  "ADULT_NUDITY",
  "SEXUAL_CONTENT",
  "GROOMING_RISK",
  "BULLYING_HARASSMENT",
  "HATE_EXTREMISM",
  "SELF_HARM_SUICIDE",
  "GRAPHIC_VIOLENCE",
  "VIOLENCE",
  "DRUGS",
  "ALCOHOL_TOBACCO",
  "GAMBLING",
  "WEAPONS",
  "DANGEROUS_CHALLENGE",
  "ANONYMOUS_CHAT",
  "SCAM_FRAUD",
  "MALWARE_PHISHING",
  "STRONG_LANGUAGE",
  "AGE_INAPPROPRIATE",
  "PARENT_CUSTOM_RULE",
  "UNKNOWN"
];
export type ContentRiskCategory = (typeof CONTENT_RISK_CATEGORIES)[number];

export const CONTENT_RISK_REASON_CODES = contentRiskContract.reason_codes as unknown as readonly [
  "ADULT_NUDITY",
  "AGE_INAPPROPRIATE",
  "ALCOHOL_TOBACCO_PROMOTION",
  "ANONYMOUS_CHAT",
  "BULLYING_TARGETED",
  "CONTEXT_NEGATED",
  "DANGEROUS_CHALLENGE",
  "DRUG_REFERENCE",
  "GAMBLING_PROMOTION",
  "GRAPHIC_VIOLENCE",
  "GROOMING_PATTERN",
  "HATE_EXTREMISM",
  "MALWARE_PHISHING",
  "PARENT_CUSTOM_RULE",
  "SCAM_FRAUD",
  "SELF_HARM_DIRECT",
  "SELF_HARM_INTENT",
  "SEXUAL_CONTENT_EXPLICIT",
  "STRONG_LANGUAGE",
  "VIOLENCE",
  "WEAPONS_INSTRUCTION"
];
export type ContentRiskReasonCode = (typeof CONTENT_RISK_REASON_CODES)[number];

export const CONTENT_RISK_CATEGORY_ALIASES = contentRiskContract.category_aliases as Readonly<
  Record<string, ContentRiskCategory>
>;
export const CONTENT_BLOCK_THRESHOLDS = contentRiskContract.content_block_thresholds as Readonly<
  Record<AgeBand, ContentRiskSeverity>
>;

export type PublicContentReference = {
  provider: "YOUTUBE" | "INSTAGRAM" | "X" | "WEB";
  content_id: string;
};

/** A local-only verdict: it contains no extracted title, message, or URL query. */
export type ContentRiskVerdict = {
  signalSource: SignalSource;
  category: ContentRiskCategory;
  severity: ContentRiskSeverity;
  confidence: number;
  reasonCodes: readonly ContentRiskReasonCode[];
  classifierVersion: string;
  capabilityLevel: CapabilityLevel;
  action: ContentAction;
};

export type CompositeContentRiskReasonCode =
  | ContentRiskReasonCode
  | `${ContentRiskReasonCode}+${ContentRiskReasonCode}`;

/** The only evidence allowed over the device-to-backend review boundary. */
export type ContentReviewEvidence = {
  app_ref: string;
  fingerprint: string;
  category: ContentRiskCategory;
  severity: ContentRiskSeverity;
  confidence: number;
  reason_code: CompositeContentRiskReasonCode;
  public_content_ref?: PublicContentReference;
};

export type ContentReviewRequest = {
  request_type: "CONTENT_REVIEW";
  content_review: ContentReviewEvidence;
};

/** Bounded native outbox item; it deliberately has no raw observed content. */
export type PendingContentRiskEvent = {
  signal_source: SignalSource;
  app_ref: string;
  fingerprint: string;
  category: ContentRiskCategory;
  severity: ContentRiskSeverity;
  confidence: number;
  reason_code: CompositeContentRiskReasonCode;
  classifier_version: string;
  capability_level: CapabilityLevel;
  action: ContentAction;
  occurred_at_millis: number;
};

export type ContentApproval = {
  device_id: string;
  app_ref: string;
  fingerprint: string;
  expires_at: string;
};

export interface CapabilityStatus {
  level: CapabilityLevel;
  detail: string | null;
  updatedAt: string;
}

export type CapabilityRecord = Record<string, CapabilityStatus>;

export interface Parent {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface Family {
  id: string;
  name: string;
  ownerParentId: string;
  createdAt: string;
}

export interface ChildProfile {
  id: string;
  familyId: string;
  displayName: string;
  age: number;
  ageBand: AgeBand;
  timezone: string;
  createdAt: string;
}

export type DevicePlatform = "ANDROID" | "IOS";

export interface Device {
  id: string;
  childProfileId: string;
  platform: DevicePlatform;
  platformDeviceId: string;
  capabilities: CapabilityRecord;
  lastSeenAt: string | null;
}

export type ProtectionHealth = "HEALTHY" | "DEGRADED" | "DISABLED" | "UNKNOWN";
export type ProtectionStatus = {
  active: boolean;
  health: ProtectionHealth;
  policyVersion: number | null;
  observedAt: string;
  details: string | null;
};

export type RequestState =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "EXPIRED"
  | "CANCELLED";

export interface AccessRequest {
  id: string;
  childProfileId: string;
  targetRef: string;
  requestedMinutes: number | null;
  state: RequestState;
  createdAt: string;
  resolvedAt: string | null;
}

export type PolicyDecisionAction =
  | "ALLOW"
  | "BLOCK"
  | "LIMIT_REACHED"
  | "ALLOW_WITH_BUDGET";

export type PolicyReasonCode =
  | "SAFETY_ALLOWLIST"
  | "TEMPORARY_PARENT_OVERRIDE"
  | "MANUAL_ROUTINE"
  | "SCHEDULED_ROUTINE"
  | "EXPLICIT_TARGET_RULE"
  | "AGE_BAND_HARD_CATEGORY"
  | "DEFAULT_CATEGORY_RULE"
  | "UNKNOWN_APP_POLICY"
  | "UNKNOWN_APP_BUDGET_AVAILABLE"
  | "UNKNOWN_APP_BUDGET_EXHAUSTED"
  | "UNKNOWN_DOMAIN_POLICY"
  | "BUDGET_AVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "DEVICE_BUDGET_EXHAUSTED"
  | "REQUIRES_PARENT_APPROVAL"
  | "SCHEDULE_OUTSIDE_WINDOW"
  | "TEMPORARY_OVERRIDE_EXPIRED"
  | "SOFT_EXPIRED_BUNDLE"
  | "TAMPERED_SIGNATURE";

export interface PolicyDecision {
  action: PolicyDecisionAction;
  reason_code: PolicyReasonCode;
  policy_rule_id: string | null;
  bundle_stale: boolean;
}

export interface UsageView {
  device_seconds_today: number;
  app_seconds_today: Record<string, number>;
  category_seconds_today: Partial<Record<Category, number>>;
}

export interface TimeRange {
  start: string;
  end: string;
}

export interface UsageSummary {
  range: TimeRange;
  totalSeconds: number;
  byTarget: Record<string, number>;
}

export interface ObservedApp {
  platformAppId: string;
  displayName: string;
  category: string;
  iconUri?: string | null;
  newlyObserved?: boolean;
  observedAt: string;
  /** Lifecycle metadata is source-tagged and explicitly partial, never a full package inventory. */
  versionName?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  installationState?: "INSTALLED" | "UNINSTALLED_OR_NOT_VISIBLE";
  capabilitySources?: Array<
    "LAUNCHER" | "USAGE_STATS" | "NOTIFICATION" | "VPN_ATTRIBUTION" | "ACCESSIBILITY_FOREGROUND"
  >;
  inventoryCompleteness?: "PARTIAL";
}

export type PermissionResult =
  | { granted: true }
  | { granted: false; reason: string };

export type ApplyResult =
  | { applied: true; policyVersion: number }
  | { applied: false; policyVersion: number | null; reason: string };
export type ReputationApplyResult = {
  applied: boolean;
  version: number | null;
  reason: string;
  entryCount: number;
  encodedBytes: number;
  applyMillis: number;
  estimatedMemoryBytes: number;
};
export type ReputationStatus = {
  version: number | null;
  entryCount: number;
  pending: number;
};
export type GuardianPerformanceMetrics = {
  vpnDecisionCount: number;
  vpnDecisionAverageMicros: number;
  policyApplyCount: number;
  policyApplyAverageMillis: number;
  usageRefreshCount: number;
  usageRefreshAverageMillis: number;
  bridgeEventCount: number;
  moduleStartupMillis: number | null;
  batteryMeasurement: string;
};

export interface GuardianProtectionNative {
  getCapabilities(): Promise<CapabilityRecord>;
  getProtectionStatus(): Promise<ProtectionStatus>;
  requestVpnPermission(): Promise<PermissionResult>;
  openUsageAccessSettings(): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  setAccessibilityContentConsent(granted: boolean): Promise<PermissionResult>;
  setContentDeviceId(deviceId: string): Promise<void>;
  clearChildIdentity(): Promise<void>;
  applyContentApprovals(approvals: ContentApproval[]): Promise<void>;
  getPendingContentRiskEvents(): Promise<PendingContentRiskEvent[]>;
  acknowledgeContentRiskEvent(signalSource: SignalSource, appRef: string, fingerprint: string): Promise<void>;
  getPendingContentReviewRequests(): Promise<ContentReviewRequest[]>;
  acknowledgeContentReviewRequest(appRef: string, fingerprint: string): Promise<void>;
  openNotificationAccessSettings(): Promise<void>;
  startProtection(): Promise<void>;
  stopProtection(): Promise<void>;
  applyPolicyBundle(bundle: unknown): Promise<ApplyResult>;
  applyReputationBundle(bundle: unknown): Promise<ReputationApplyResult>;
  getReputationStatus(): Promise<ReputationStatus>;
  getUsageSummary(range: TimeRange): Promise<UsageSummary>;
  getPerformanceMetrics(): Promise<GuardianPerformanceMetrics>;
  getObservedApps(): Promise<ObservedApp[]>;
  markObservedAppReviewed(platformAppId: string): Promise<void>;
  subscribe(listener: (event: GuardianNativeEvent) => void): { remove: () => void };
}

export type GuardianNativeEvent =
  | { type: "PROTECTION_STATUS_CHANGED"; status: ProtectionStatus; correlationId?: string }
  | { type: "APP_BLOCKED"; appRef: string; reasonCode: PolicyReasonCode; correlationId?: string }
  | {
      type: "WEB_BLOCKED";
      domain?: string;
      category?: string;
      appRef?: string;
      reasonCode: PolicyReasonCode;
      correlationId?: string;
    }
  | { type: "TIME_WARNING"; targetRef: string; remainingSeconds: number; correlationId?: string }
  | { type: "TIME_EXPIRED"; targetRef: string; correlationId?: string }
  | {
      type: "SAFETY_EVENT";
      category: string;
      severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      confidence: number;
      reasonCode?: string;
      appRef?: string;
      occurredAt: string;
      correlationId?: string;
    }
  | { type: "POLICY_APPLIED"; version: number; correlationId?: string }
  | { type: "PERMISSION_STATE_CHANGED"; capability: string; state: string; correlationId?: string }
  | { type: "REPUTATION_STATUS_CHANGED"; version?: number; reason: string; correlationId?: string };

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "POLICY_VERSION_CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export function isAgeBand(value: unknown): value is AgeBand {
  return typeof value === "string" && (AGE_BANDS as readonly string[]).includes(value);
}

export function isCapabilityLevel(value: unknown): value is CapabilityLevel {
  return (
    typeof value === "string" &&
    (CAPABILITY_LEVELS as readonly string[]).includes(value)
  );
}

export function isPolicyDecisionAction(value: unknown): value is PolicyDecisionAction {
  return (
    value === "ALLOW" ||
    value === "BLOCK" ||
    value === "LIMIT_REACHED" ||
    value === "ALLOW_WITH_BUDGET"
  );
}
