import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert, AppState, Text, type AppStateStatus } from "react-native";

const mockQueryState = new Map<string, Record<string, unknown>>();
const mockMutatePolicy = jest.fn();
const mockDecideRequest = jest.fn();
const mockReviewApp = jest.fn();
const mockFlushRequest = jest.fn();
const mockUsageRefetch = jest.fn();
const mockDefaultRefetch = jest.fn(() => Promise.resolve());
const mockGuardianSubscriptionRemove = jest.fn();
const mockGetCapabilities = jest.fn();
const mockGetProtectionStatus = jest.fn();
const mockSetAccessibilityContentConsent = jest.fn((granted: boolean) => {
  void granted;
  return Promise.resolve({ granted: true });
});
const mockOpenAccessibilitySettings = jest.fn(() => Promise.resolve());
const mockApplyPolicyBundle = jest.fn<Promise<{ applied: boolean }>, [unknown]>();
const mockStartProtection = jest.fn<Promise<void>, []>();
const mockGetReputationStatus = jest.fn(() => Promise.resolve({ version: 0 }));
const mockAcknowledgePolicy = jest.fn<Promise<void>, [number]>();
const mockHeartbeat = jest.fn<Promise<void>, [unknown]>();
const mockIngestEvents = jest.fn<Promise<void>, [unknown[], string?]>();
const mockIngestInventory = jest.fn<Promise<void>, [unknown[]]>();
const mockReputation = jest.fn<
  Promise<{ bundle: null; deltas: never[] }>,
  [number?]
>();
let mockGuardianEventListener: ((event: unknown) => void) | undefined;
let mockGuardianCapabilities: Record<string, { level: string; detail?: string }> = {};
let mockGuardianProtectionStatus = { active: false, health: "UNKNOWN" };
let mockObservedApps: Array<Record<string, unknown>> = [];
let mockOffline = false;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ familyId: "family-1", childId: "child-1" }),
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (effect: () => void) => {
    const react = jest.requireActual<typeof import("react")>("react");
    react.useEffect(effect, [effect]);
  },
}));

jest.mock("@/api/client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  sessionStorage: {
    getFamilyId: () => Promise.resolve(undefined),
  },
  api: {
    mutatePolicy: (...args: unknown[]) => {
      mockMutatePolicy(...args);
      return Promise.resolve({});
    },
    decideRequest: (...args: unknown[]) => {
      mockDecideRequest(...args);
      return Promise.resolve({});
    },
    children: () => Promise.resolve([]),
    health: () => Promise.resolve([]),
    requests: () => Promise.resolve([]),
    activity: () => Promise.resolve([]),
    activityUsage: () => Promise.resolve([]),
    usageReport: () => Promise.resolve([]),
    childInventory: () => Promise.resolve([]),
    reviewChildApp: (...args: unknown[]) => {
      mockReviewApp(...args);
      return Promise.resolve();
    },
    policy: () => Promise.resolve({}),
    acknowledgePolicy: (policyVersion: number) => mockAcknowledgePolicy(policyVersion),
    heartbeat: (body: unknown) => mockHeartbeat(body),
    ingestEvents: (events: unknown[], correlationId?: string) => mockIngestEvents(events, correlationId),
    ingestInventory: (apps: unknown[]) => mockIngestInventory(apps),
    reputation: (version?: number) => mockReputation(version),
    contentApprovals: () => Promise.resolve([]),
  },
}));

jest.mock("@/hooks/use-family-sync", () => ({ useFamilySync: jest.fn() }));
jest.mock("@/state/request-outbox", () => ({
  enqueueRequest: jest.fn(),
  flushRequestOutbox: (...args: unknown[]): Promise<unknown> => mockFlushRequest(...args) as Promise<unknown>,
  readRequestOutbox: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../modules/guardian-protection/src", () => ({
  GuardianProtection: {
    subscribe: (listener: (event: unknown) => void) => {
      mockGuardianEventListener = listener;
      return { remove: mockGuardianSubscriptionRemove };
    },
    getObservedApps: () => Promise.resolve(mockObservedApps),
    markObservedAppReviewed: (...args: unknown[]) => {
      mockReviewApp(...args);
      return Promise.resolve();
    },
    getCapabilities: () => {
      mockGetCapabilities();
      return Promise.resolve(mockGuardianCapabilities);
    },
    getProtectionStatus: () => {
      mockGetProtectionStatus();
      return Promise.resolve(mockGuardianProtectionStatus);
    },
    applyPolicyBundle: (bundle: unknown) => mockApplyPolicyBundle(bundle),
    startProtection: () => mockStartProtection(),
    getReputationStatus: () => mockGetReputationStatus(),
    applyReputationBundle: jest.fn(() => Promise.resolve({ applied: true })),
    getUsageSummary: () => Promise.resolve({ byTarget: {} }),
    openUsageAccessSettings: jest.fn(),
    openAccessibilitySettings: () => mockOpenAccessibilitySettings(),
    setAccessibilityContentConsent: (granted: boolean) => mockSetAccessibilityContentConsent(granted),
    getPendingContentRiskEvents: () => Promise.resolve([]),
    acknowledgeContentRiskEvent: () => Promise.resolve(),
    getPendingContentReviewRequests: () => Promise.resolve([]),
    applyContentApprovals: () => Promise.resolve(),
    acknowledgeContentReviewRequest: () => Promise.resolve(),
    setContentDeviceId: () => Promise.resolve(),
  },
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const state = mockQueryState.get(JSON.stringify(queryKey));
    return {
      data: state?.data,
      error: state?.error,
      isLoading: state?.isLoading ?? false,
      isError: state?.isError ?? false,
      isStale: state?.isStale ?? false,
      refetch: state?.refetch ?? mockDefaultRefetch,
    };
  },
  useMutation: () => ({
    mutate: (input: unknown) => {
      mockMutatePolicy(input);
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock("@/state/network", () => ({ useNetworkStatus: () => ({ isOffline: mockOffline }) }));

import RulesScreen, { stableObservedApps } from "@/app/parent/rules";
import RequestsScreen from "@/app/parent/requests";
import HealthScreen from "@/app/parent/health";
import ActivityScreen, { aggregateTodayUsage } from "@/app/parent/activity";
import ChildHomeScreen from "@/app/child/home";
import ChildRequestsScreen from "@/app/child/requests";
import ChildTimeScreen from "@/app/child/time";
import { appUsageEvents, flushPendingContentRiskEvents } from "@/app/child/home";

function setQuery(key: unknown[], state: Record<string, unknown>) {
  mockQueryState.set(JSON.stringify(key), state);
}

beforeEach(() => {
  mockQueryState.clear();
  mockMutatePolicy.mockReset();
  mockDecideRequest.mockReset();
  mockReviewApp.mockReset();
  mockFlushRequest.mockReset();
  mockUsageRefetch.mockReset();
  mockUsageRefetch.mockResolvedValue(undefined);
  mockDefaultRefetch.mockReset();
  mockDefaultRefetch.mockResolvedValue(undefined);
  mockGuardianSubscriptionRemove.mockReset();
  mockGetCapabilities.mockReset();
  mockGetProtectionStatus.mockReset();
  mockApplyPolicyBundle.mockReset();
  mockApplyPolicyBundle.mockResolvedValue({ applied: true });
  mockStartProtection.mockReset();
  mockStartProtection.mockResolvedValue(undefined);
  mockGetReputationStatus.mockReset();
  mockGetReputationStatus.mockResolvedValue({ version: 0 });
  mockAcknowledgePolicy.mockReset();
  mockAcknowledgePolicy.mockResolvedValue(undefined);
  mockHeartbeat.mockReset();
  mockHeartbeat.mockResolvedValue(undefined);
  mockIngestEvents.mockReset();
  mockIngestEvents.mockResolvedValue(undefined);
  mockIngestInventory.mockReset();
  mockIngestInventory.mockResolvedValue(undefined);
  mockReputation.mockReset();
  mockReputation.mockResolvedValue({ bundle: null, deltas: [] });
  mockGuardianEventListener = undefined;
  mockGuardianCapabilities = {};
  mockGuardianProtectionStatus = { active: false, health: "UNKNOWN" };
  mockObservedApps = [];
  mockFlushRequest.mockResolvedValue([]);
  mockOffline = false;
});

test("Rules renders loading and pending-sync states and submits an app limit", async () => {
  setQuery(["children", "family-1"], { isLoading: true });
  setQuery(["child-inventory", "family-1", "child-1"], { isLoading: true });
  const loading = render(<RulesScreen />);
  expect(loading.getByLabelText("Loading")).toBeTruthy();
  loading.unmount();

  setQuery(["children", "family-1"], {
    data: [{
      id: "child-1",
      name: "Alex",
      policy_document: { app_rules: [], domain_rules: [], base_policy: {} },
    }],
  });
  setQuery(["child-inventory", "family-1", "child-1"], {
    data: [{ platform_app_id: "com.example.app", display_name: "Example", category: null, reviewed: true }],
  });
  setQuery(["health", "family-1", "child-1"], { data: [] });
  const screen = render(<RulesScreen />);
  expect(screen.getByText(/Rules active on device\./)).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Limit to 30 minutes"));
  await waitFor(() => expect(mockMutatePolicy).toHaveBeenCalledWith({
    operation: "APP_DAILY_MINUTES",
    target: "com.example.app",
    value: 30,
  }));
});

test("Rules keeps content blocking separate from notification alert sensitivity", async () => {
  setQuery(["children", "family-1"], {
    data: [{
      id: "child-1",
      name: "Alex",
      policy_document: {
        app_rules: [],
        domain_rules: [],
        base_policy: {},
        communication_safety: { severity_threshold: "HIGH" },
        content_safety: { content_block_threshold: "MEDIUM" },
      },
    }],
  });
  setQuery(["child-inventory", "family-1", "child-1"], { data: [] });
  setQuery(["health", "family-1", "child-1"], { data: [] });
  const screen = render(<RulesScreen />);
  expect(screen.getByText("Content Safety")).toBeTruthy();
  expect(screen.getByText("Block content at: MEDIUM")).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Use CRITICAL content block threshold"));
  await waitFor(() => expect(mockMutatePolicy).toHaveBeenCalledWith({
    operation: "CONTENT_BLOCK_THRESHOLD",
    target: "content_safety",
    value: "CRITICAL",
  }));
});

test("Rules keeps a newly observed app in review until the parent marks it reviewed", async () => {
  setQuery(["children", "family-1"], {
    data: [{
      id: "child-1",
      name: "Alex",
      policy_document: { app_rules: [], domain_rules: [], base_policy: {} },
    }],
  });
  const refetch = jest.fn();
  setQuery(["child-inventory", "family-1", "child-1"], {
    data: [{ platform_app_id: "com.example.new", display_name: "New app", category: null, reviewed: false }],
    refetch,
  });
  setQuery(["health", "family-1", "child-1"], { data: [] });
  const screen = render(<RulesScreen />);
  expect(screen.getByText("This app was newly observed on the child device. Review it before treating it as trusted.")).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Mark app reviewed"));
  await waitFor(() => expect(mockReviewApp).toHaveBeenCalledWith("family-1", "child-1", "com.example.new"));
  expect(refetch).toHaveBeenCalled();
});

test("Rules keep app-specific drafts on the selected package when inventory reorders and reputation is unavailable", async () => {
  setQuery(["children", "family-1"], {
    data: [{
      id: "child-1",
      name: "Alex",
      policy_document: { app_rules: [], domain_rules: [], base_policy: {} },
    }],
  });
  setQuery(["child-inventory", "family-1", "child-1"], {
    data: [
      { platform_app_id: "com.example.beta", display_name: "Beta", category: null, reviewed: true },
      { platform_app_id: "com.example.alpha", display_name: "Alpha", category: null, reviewed: true },
    ],
  });
  setQuery(["reputation", "family-1", "child-1"], { isError: true });
  setQuery(["health", "family-1", "child-1"], { data: [] });
  const screen = render(<RulesScreen />);
  expect(stableObservedApps([
    { platform_app_id: "z", display_name: "Beta", category: null, reviewed: true },
    { platform_app_id: "a", display_name: "Alpha", category: null, reviewed: true },
  ]).map((app) => app.platform_app_id)).toEqual(["a", "z"]);
  expect(screen.getByText("Reputation updates are unavailable. Existing parent rules remain usable and active.")).toBeTruthy();

  fireEvent.changeText(screen.getByLabelText("Daily limit for Alpha (minutes)"), "45");
  fireEvent.press(screen.getAllByLabelText("Edit controls")[0]);
  expect(screen.getByLabelText("Daily limit for Beta (minutes)").props.value).toBe("30");
  fireEvent.press(screen.getByLabelText("Edit controls"));
  expect(screen.getByLabelText("Daily limit for Alpha (minutes)").props.value).toBe("45");
  fireEvent.press(screen.getByLabelText("Limit to 45 minutes"));
  await waitFor(() => expect(mockMutatePolicy).toHaveBeenCalledWith({
    operation: "APP_DAILY_MINUTES",
    target: "com.example.alpha",
    value: 45,
  }));
});

test("Requests renders retry and terminal approval states", async () => {
  const refetch = jest.fn();
  setQuery(["requests", "family-1", "child-1"], { isError: true, refetch });
  const errorScreen = render(<RequestsScreen />);
  fireEvent.press(errorScreen.getByLabelText("Retry"));
  expect(refetch).toHaveBeenCalled();
  errorScreen.unmount();

  setQuery(["requests", "family-1", "child-1"], {
    data: [{
      id: "request-1",
      request_type: "MORE_TIME",
      subject: "Example",
      reason: "Please help",
      state: "PENDING",
    }],
  });
  const screen = render(<RequestsScreen />);
  expect(screen.getByText("Waiting for a parent")).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Approve"));
  await waitFor(() => expect(mockMutatePolicy).toHaveBeenCalled());
});

test("Rules and Requests render stale and offline states", () => {
  setQuery(["children", "family-1"], { data: [], isStale: true });
  setQuery(["child-inventory", "family-1", "child-1"], { data: [] });
  const staleRules = render(<RulesScreen />);
  expect(staleRules.getByText("This data may be out of date.")).toBeTruthy();
  staleRules.unmount();

  mockOffline = true;
  setQuery(["requests", "family-1", "child-1"], { data: [] });
  const offlineRequests = render(<RequestsScreen />);
  expect(offlineRequests.getByText("You're offline. Last-known data may be shown.")).toBeTruthy();
});

test("Protection Health renders permission-denied and platform-unavailable capability details", () => {
  setQuery(["health", "family-1", "child-1"], { data: [] });
  setQuery(["guardian-capabilities"], {
    data: {
      app_usage: { level: "UNAVAILABLE", detail: "Permission denied" },
      web_filtering: { level: "PLATFORM_UNAVAILABLE", detail: "Platform unavailable" },
    },
  });
  setQuery(["guardian-status"], { data: { active: false, health: "DEGRADED", details: "Permission denied" } });
  const screen = render(<HealthScreen />);
  expect(screen.getAllByText("Permission denied").length).toBeGreaterThan(0);
  expect(screen.getByText("Platform unavailable")).toBeTruthy();
  expect(screen.getByText("DEGRADED")).toBeTruthy();
});

test("Child device requires explicit content-inspection consent before opening Accessibility settings", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
    const continueButton = buttons?.find((button) => button.text === "Continue to Accessibility settings");
    continueButton?.onPress?.();
  });
  const screen = render(<ChildHomeScreen />);

  expect(screen.getByText("Content-safety inspection is separate and optional. Guardian never claims coverage for text an app does not expose to Accessibility.")).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Enable content-safety inspection"));

  await waitFor(() => expect(mockSetAccessibilityContentConsent).toHaveBeenCalledWith(true));
  await waitFor(() => expect(mockOpenAccessibilitySettings).toHaveBeenCalled());
  alert.mockRestore();
});

test("Child device explains when signed parent policy disables Accessibility content inspection", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
    accessibility_signals: {
      level: "UNAVAILABLE",
      detail: "Disabled by the current signed parent policy. Ask a parent to enable Android content-safety signals.",
    },
  };
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };

  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("Disabled by parent policy. Ask a parent to enable Android content-safety signals.")).toBeTruthy();
  });
  expect(screen.queryByLabelText("Enable content-safety inspection")).toBeNull();
  screen.unmount();
});

test("Activity renders empty data distinctly from endpoint errors", () => {
  const refetch = jest.fn();
  setQuery(["activity", "family-1", "child-1"], { data: [], isError: true, refetch });
  setQuery(["activity-usage", "family-1", "child-1"], { data: [], isError: true });
  const screen = render(<ActivityScreen />);
  fireEvent.press(screen.getByLabelText("Retry"));
  expect(refetch).toHaveBeenCalled();
  expect(screen.getByText("We couldn't load this data.")).toBeTruthy();
  screen.unmount();

  setQuery(["activity", "family-1", "child-1"], { data: [] });
  setQuery(["activity-usage", "family-1", "child-1"], { data: [] });
  setQuery(["usage-report", "family-1", "child-1"], { data: [] });
  const loaded = render(<ActivityScreen />);
  expect(loaded.getByText("Nothing to show yet.")).toBeTruthy();
  expect(loaded.getByText("Unknown · this family has not reported activity yet.")).toBeTruthy();
  expect(loaded.getByText("Unknown · no backend events are available for this family.")).toBeTruthy();
  expect(loaded.getByText("Unknown · no usage aggregates are available for this family.")).toBeTruthy();
});

test("Activity renders permission-denied for an expired session", () => {
  const mockedClient: { ApiError: new (message: string, status: number) => Error & { status: number } } = jest.requireMock("@/api/client");
  const ApiError = mockedClient.ApiError;
  setQuery(["activity", "family-1", "child-1"], { error: new ApiError("Unauthorized", 401), isError: true });
  setQuery(["activity-usage", "family-1", "child-1"], { data: [] });
  setQuery(["usage-report", "family-1", "child-1"], { data: [] });
  const screen = render(<ActivityScreen />);
  expect(screen.getByText("Permission is required to continue.")).toBeTruthy();
  expect(screen.queryByText("We couldn't load this data.")).toBeNull();
});

test("Activity renders sub-minute usage without rounding it to zero", () => {
  setQuery(["activity", "family-1", "child-1"], { data: [] });
  setQuery(["activity-usage", "family-1", "child-1"], {
    data: [{
      app_ref: "com.example.short",
      category: "EDUCATION",
      duration_seconds: 30,
      event_type: "APP_USAGE",
      occurred_at: new Date().toISOString(),
    }],
  });
  setQuery(["usage-report", "family-1", "child-1"], { data: [] });
  const screen = render(<ActivityScreen />);
  expect(screen.getByText("APP:com.example.short")).toBeTruthy();
  expect(screen.getAllByText("<1 min")).toHaveLength(2);
  expect(screen.queryByText("0 min")).toBeNull();
});

test("Activity aggregates only today's backend child usage by target", () => {
  const now = new Date("2026-08-15T12:00:00Z");
  expect(aggregateTodayUsage([
    {
      app_ref: "com.example.app",
      category: "EDUCATION",
      duration_seconds: 30,
      event_type: "APP_USAGE",
      occurred_at: "2026-08-15T09:00:00Z",
    },
    {
      app_ref: "com.example.app",
      category: "EDUCATION",
      duration_seconds: 90,
      event_type: "APP_USAGE",
      occurred_at: "2026-08-15T10:00:00Z",
    },
    {
      app_ref: null,
      category: "EDUCATION",
      duration_seconds: 120,
      event_type: "CATEGORY_USAGE",
      occurred_at: "2026-08-14T10:00:00Z",
    },
  ], now)).toEqual({ "APP:com.example.app": 90 });
});

test("Activity keeps the latest cumulative point instead of summing uploads", () => {
  const now = new Date("2026-08-15T12:00:00Z");
  expect(aggregateTodayUsage([
    {
      app_ref: "com.example.chrome",
      category: "BROWSER",
      duration_seconds: 1015,
      event_type: "APP_USAGE",
      occurred_at: "2026-08-15T09:00:00Z",
    },
    {
      app_ref: "com.example.chrome",
      category: "BROWSER",
      duration_seconds: 1018,
      event_type: "APP_USAGE",
      occurred_at: "2026-08-15T09:01:00Z",
    },
  ], now)).toEqual({ "APP:com.example.chrome": 1018 });
});

test("Child usage uploads only app-prefixed usage buckets", () => {
  expect(appUsageEvents({
    "APP:com.example.app": 61,
    "CATEGORY:EDUCATION": 120,
    DEVICE: 181,
  }, "2026-08-15T12:00:00Z")).toEqual([{
    event_type: "APP_USAGE",
    occurred_at: "2026-08-15T12:00:00Z",
    app_ref: "com.example.app",
    duration_seconds: 61,
  }]);
});

test("Child My Time reports exhausted app budgets and scoped parent grants", () => {
  setQuery(["child-usage"], {
    data: {
      totalSeconds: 1860,
      byTarget: { "APP:com.example.app": 1800, DEVICE: 1860 },
    },
  });
  setQuery(["device-policy"], {
    data: {
      bundle: {
        app_rules: [{ app_ref: "com.example.app", action: "LIMIT", daily_minutes: 30 }],
        temporary_overrides: [{
          rule_id: "app-grant",
          target_kind: "APP",
          target_ref: "com.example.app",
          action: "LIMIT",
          daily_minutes: 45,
          starts_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }, {
          rule_id: "device-grant-one",
          target_kind: "DEVICE",
          target_ref: "device",
          action: "LIMIT",
          daily_minutes: 45,
          starts_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }, {
          rule_id: "device-grant-two",
          target_kind: "DEVICE",
          target_ref: "device",
          action: "LIMIT",
          daily_minutes: 45,
          starts_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }],
      },
    },
  });
  const screen = render(<ChildTimeScreen />);
  expect(screen.getByText("31 minutes recorded on this device.")).toBeTruthy();
  expect(screen.getByText("com.example.app: 15 minutes remaining.")).toBeTruthy();
  expect(screen.getByText("Parent-approved extra time for app com.example.app: 45 minutes.")).toBeTruthy();
  expect(screen.getAllByText("Parent-approved extra time for this device: 45 minutes.")).toHaveLength(2);
});

test("Child My Time applies a device grant when it is the effective app limit", () => {
  setQuery(["child-usage"], {
    data: {
      totalSeconds: 2400,
      byTarget: { "APP:com.example.app": 1200, DEVICE: 2400 },
    },
  });
  setQuery(["device-policy"], {
    data: {
      bundle: {
        base_policy: { daily_device_budget_minutes: 30 },
        app_rules: [{ app_ref: "com.example.app", action: "LIMIT", daily_minutes: 60 }],
        temporary_overrides: [{
          rule_id: "device-grant",
          target_kind: "DEVICE",
          target_ref: "device",
          action: "LIMIT",
          daily_minutes: 45,
          starts_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }],
      },
    },
  });
  const screen = render(<ChildTimeScreen />);
  expect(screen.getByText("com.example.app: 5 minutes remaining.")).toBeTruthy();
});

test("Child My Time floors fractional minutes instead of rounding them up", () => {
  setQuery(["child-usage"], {
    data: {
      totalSeconds: 1790,
      byTarget: { "APP:com.example.app": 1790, DEVICE: 1790 },
    },
  });
  setQuery(["device-policy"], {
    data: {
      bundle: {
        app_rules: [{ app_ref: "com.example.app", action: "LIMIT", daily_minutes: 30 }],
        temporary_overrides: [],
      },
    },
  });
  const screen = render(<ChildTimeScreen />);
  expect(screen.getByText("com.example.app: Less than 1 minute remaining.")).toBeTruthy();
  expect(screen.queryByText("com.example.app: 1 minutes remaining.")).toBeNull();
});

test("Child My Time renders honest sub-minute remaining time", () => {
  setQuery(["child-usage"], {
    data: {
      totalSeconds: 1799,
      byTarget: { "APP:com.example.app": 1799, DEVICE: 1799 },
    },
    refetch: mockUsageRefetch,
  });
  setQuery(["device-policy"], {
    data: {
      bundle: {
        app_rules: [{ app_ref: "com.example.app", action: "LIMIT", daily_minutes: 30 }],
        temporary_overrides: [],
      },
    },
  });
  const screen = render(<ChildTimeScreen />);
  expect(screen.getByText("com.example.app: Less than 1 minute remaining.")).toBeTruthy();
});

test("Child My Time refreshes usage on native budget events", () => {
  setQuery(["child-usage"], {
    data: {
      totalSeconds: 600,
      byTarget: { "APP:com.example.app": 600, DEVICE: 600 },
    },
    refetch: mockUsageRefetch,
  });
  setQuery(["device-policy"], {
    data: {
      bundle: {
        app_rules: [{ app_ref: "com.example.app", action: "LIMIT", daily_minutes: 30 }],
        temporary_overrides: [],
      },
    },
  });
  const screen = render(<ChildTimeScreen />);
  expect(mockGuardianEventListener).toBeDefined();
  mockUsageRefetch.mockClear();
  mockGuardianEventListener?.({ type: "TIME_EXPIRED", targetRef: "com.example.app" });
  expect(mockUsageRefetch).toHaveBeenCalledTimes(1);
  screen.unmount();
  expect(mockGuardianSubscriptionRemove).toHaveBeenCalledTimes(1);
});

test("Child My Time renders no time left when app usage reaches its limit", () => {
  setQuery(["child-usage"], {
    data: {
      totalSeconds: 1800,
      byTarget: { "APP:com.example.app": 1800, DEVICE: 1800 },
    },
  });
  setQuery(["device-policy"], {
    data: {
      bundle: {
        app_rules: [{ app_ref: "com.example.app", action: "LIMIT", daily_minutes: 30 }],
        temporary_overrides: [],
      },
    },
  });
  const screen = render(<ChildTimeScreen />);
  expect(screen.getByText("com.example.app: No time left today.")).toBeTruthy();
  expect(screen.queryByText("com.example.app: 0 minutes remaining.")).toBeNull();
});

test("Child My Time remaining time decreases as app usage grows", () => {
  setQuery(["child-usage"], {
    data: {
      totalSeconds: 600,
      byTarget: { "APP:com.example.app": 600, DEVICE: 600 },
    },
  });
  setQuery(["device-policy"], {
    data: {
      bundle: {
        app_rules: [{ app_ref: "com.example.app", action: "LIMIT", daily_minutes: 30 }],
        temporary_overrides: [],
      },
    },
  });
  const first = render(<ChildTimeScreen />);
  expect(first.getByText("com.example.app: 20 minutes remaining.")).toBeTruthy();
  first.unmount();

  setQuery(["child-usage"], {
    data: {
      totalSeconds: 1200,
      byTarget: { "APP:com.example.app": 1200, DEVICE: 1200 },
    },
  });
  const second = render(<ChildTimeScreen />);
  expect(second.getByText("com.example.app: 10 minutes remaining.")).toBeTruthy();
});

test("Child home surfaces unavailable app blocking with a recovery action", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "UNAVAILABLE" },
  };
  mockGuardianProtectionStatus = { active: true, health: "DEGRADED" };
  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("App limits are not being enforced right now. Re-enable Accessibility to restore app blocking.")).toBeTruthy();
  });
  expect(screen.getByLabelText("Enable app limits")).toBeTruthy();
  screen.unmount();

  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
  };
  const full = render(<ChildHomeScreen />);
  await waitFor(() => expect(full.getByText("Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian.")).toBeTruthy());
  expect(full.queryByText("App limits are not being enforced right now. Re-enable Accessibility to restore app blocking.")).toBeNull();
  full.unmount();

  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "REGION_LIMITED" },
    app_blocking: { level: "FULL" },
  };
  const reduced = render(<ChildHomeScreen />);
  await waitFor(() => expect(reduced.getByText("Web protection is active, but coverage may be limited. Some traffic may bypass Guardian.")).toBeTruthy());
  reduced.unmount();
});

test("Child home applies app-blocking capability events without polling native state", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };
  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian.")).toBeTruthy();
  });

  const capabilityCalls = mockGetCapabilities.mock.calls.length;
  const protectionCalls = mockGetProtectionStatus.mock.calls.length;
  act(() => {
    mockGuardianEventListener?.({
      type: "PERMISSION_STATE_CHANGED",
      capability: "app_blocking",
      state: "UNAVAILABLE",
    });
  });
  await waitFor(() => {
    expect(screen.getByText("App limits are not being enforced right now. Re-enable Accessibility to restore app blocking.")).toBeTruthy();
  });
  expect(mockGetCapabilities).toHaveBeenCalledTimes(capabilityCalls);
  expect(mockGetProtectionStatus).toHaveBeenCalledTimes(protectionCalls);

  act(() => {
    mockGuardianEventListener?.({
      type: "PERMISSION_STATE_CHANGED",
      capability: "app_blocking",
      state: "FULL",
    });
  });
  await waitFor(() => {
    expect(screen.queryByText("App limits are not being enforced right now. Re-enable Accessibility to restore app blocking.")).toBeNull();
  });
  expect(mockGetCapabilities).toHaveBeenCalledTimes(capabilityCalls);
  expect(mockGetProtectionStatus).toHaveBeenCalledTimes(protectionCalls);
  screen.unmount();
});

test("Child home refreshes protection when the native tunnel status changes", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: false, health: "DEGRADED" };
  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("Web protection is unavailable.")).toBeTruthy();
  });

  const capabilityCalls = mockGetCapabilities.mock.calls.length;
  const protectionCalls = mockGetProtectionStatus.mock.calls.length;
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };
  act(() => {
    mockGuardianEventListener?.({
      type: "PROTECTION_STATUS_CHANGED",
      status: {
        active: true,
        health: "HEALTHY",
        policyVersion: null,
        observedAt: new Date().toISOString(),
        details: null,
      },
    });
  });
  await waitFor(() => {
    expect(screen.getByText("Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian.")).toBeTruthy();
  });
  expect(mockGetCapabilities).toHaveBeenCalledTimes(capabilityCalls + 1);
  expect(mockGetProtectionStatus).toHaveBeenCalledTimes(protectionCalls + 1);
  screen.unmount();
});

test("Child home explains an inactive authorized VPN and offers a retry", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: {
      level: "LIMITED",
      detail: "Protection was requested but the VPN is not running after a service stop.",
    },
    web_filtering: { level: "UNAVAILABLE" },
    app_blocking: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: false, health: "DEGRADED" };

  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("Protection was requested but the VPN is not running after a service stop.")).toBeTruthy();
  });
  fireEvent.press(screen.getByLabelText("Retry web protection"));
  await waitFor(() => expect(mockStartProtection).toHaveBeenCalled());
  screen.unmount();
});

test("Child protection acknowledgement, heartbeat, usage, and inventory continue when reputation sync fails", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
    communication_risk_signals: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };
  setQuery(["device-policy"], { data: { policy_version: 9, bundle: {} } });
  mockReputation.mockRejectedValueOnce(new Error("reputation offline"));

  const screen = render(<ChildHomeScreen />);
  await waitFor(() => expect(mockApplyPolicyBundle).toHaveBeenCalled());
  await waitFor(() => expect(mockGetCapabilities).toHaveBeenCalled());
  await waitFor(() => expect(mockStartProtection).toHaveBeenCalled());
  await waitFor(() => expect(mockAcknowledgePolicy).toHaveBeenCalledWith(9));
  await waitFor(() => expect(mockHeartbeat).toHaveBeenCalled());
  await waitFor(() => expect(mockIngestInventory).toHaveBeenCalled());
  await waitFor(() => {
    expect(screen.getByText("Reputation updates are temporarily unavailable. Protection and parent rules remain active.")).toBeTruthy();
  });
  expect(mockStartProtection).toHaveBeenCalled();
  screen.unmount();
});

test("Child inventory uploads source-tagged lifecycle metadata without an icon", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
    communication_risk_signals: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };
  mockObservedApps = [{
    platformAppId: "com.example.observed",
    displayName: "Observed",
    category: "GAMES",
    observedAt: "2026-08-16T10:00:00Z",
    versionName: "2.0.0",
    firstSeenAt: "2026-08-01T10:00:00Z",
    lastSeenAt: "2026-08-16T10:00:00Z",
    installationState: "INSTALLED",
    capabilitySources: ["LAUNCHER", "ACCESSIBILITY_FOREGROUND"],
    inventoryCompleteness: "PARTIAL",
    iconUri: "android.resource://com.example.observed/42",
  }];
  setQuery(["device-policy"], { data: { policy_version: 12, bundle: {} } });

  const screen = render(<ChildHomeScreen />);
  await waitFor(() => expect(mockIngestInventory).toHaveBeenCalledWith([{
    platform_app_id: "com.example.observed",
    display_name: "Observed",
    category: "GAMES",
    observed_at: "2026-08-16T10:00:00Z",
    version_name: "2.0.0",
    first_seen_at: "2026-08-01T10:00:00Z",
    last_seen_at: "2026-08-16T10:00:00Z",
    installation_state: "INSTALLED",
    capability_sources: ["LAUNCHER", "ACCESSIBILITY_FOREGROUND"],
    inventory_completeness: "PARTIAL",
  }]));
  screen.unmount();
});

test("Child home shows active protection when the tunnel is already up on mount", async () => {
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };
  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian.")).toBeTruthy();
  });
  expect(screen.queryByText("Web protection is unavailable.")).toBeNull();
  screen.unmount();
});

test("Child home reports cached protection as active while the policy server is unavailable", async () => {
  mockOffline = true;
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };
  setQuery(["device-policy"], { data: { policy_version: 7, bundle: {} }, isError: true });
  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian.")).toBeTruthy();
  });
  expect(screen.getByText("This data may be out of date.")).toBeTruthy();
  expect(screen.getByText("Policy acknowledged by this device.")).toBeTruthy();
  expect(screen.getByLabelText("Retry")).toBeTruthy();
  expect(screen.queryByText("Web protection is unavailable.")).toBeNull();
});

test("Child home shows an error and retry when no policy data is available", async () => {
  mockOffline = true;
  mockGuardianCapabilities = {
    vpn_filtering: { level: "FULL" },
    web_filtering: { level: "LIMITED" },
    app_blocking: { level: "FULL" },
  };
  mockGuardianProtectionStatus = { active: true, health: "HEALTHY" };
  setQuery(["device-policy"], { isError: true });
  const screen = render(<ChildHomeScreen />);
  await waitFor(() => {
    expect(screen.getByText("You're offline. Last-known data may be shown.")).toBeTruthy();
    expect(screen.getByText("Web protection is active for encrypted DNS and known blocked destinations. Other traffic may bypass Guardian.")).toBeTruthy();
  });
  expect(screen.getByLabelText("Retry")).toBeTruthy();
  expect(screen.getByText("Policy status is not available yet.")).toBeTruthy();
  expect(screen.queryByText("Policy acknowledged by this device.")).toBeNull();
  screen.unmount();
});

test("Child request sync turns offline delivery failures into queued messaging", async () => {
  mockFlushRequest.mockRejectedValueOnce(new Error("fetch failed"));
  const screen = render(<ChildRequestsScreen />);
  await waitFor(() => expect(screen.getByText("The request is still queued and will retry when online.")).toBeTruthy());
});

test("Child requests flush again when the app returns to the foreground", async () => {
  const foregroundListeners: Array<(state: AppStateStatus) => void> = [];
  const addEventListener = jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
    if (event === "change") foregroundListeners.push(listener);
    return { remove: jest.fn() };
  });
  const screen = render(<ChildRequestsScreen />);
  await waitFor(() => expect(mockFlushRequest).toHaveBeenCalledTimes(1));
  mockFlushRequest.mockClear();

  await act(async () => {
    foregroundListeners[0]?.("active");
    await Promise.resolve();
  });
  await waitFor(() => expect(mockFlushRequest).toHaveBeenCalledTimes(1));

  screen.unmount();
  addEventListener.mockRestore();
});

test("Child requests flush when connectivity returns", async () => {
  mockOffline = true;
  const addEventListener = jest.spyOn(AppState, "addEventListener").mockImplementation(() => ({
    remove: jest.fn(),
  }));
  const screen = render(<ChildRequestsScreen />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockFlushRequest).not.toHaveBeenCalled();

  mockOffline = false;
  await act(async () => {
    screen.rerender(<ChildRequestsScreen />);
    await Promise.resolve();
  });
  await waitFor(() => expect(mockFlushRequest).toHaveBeenCalledTimes(1));
  screen.unmount();
  addEventListener.mockRestore();
});

test("content-risk outbox uploads minimized evidence once and acknowledges only after success", async () => {
  const queued = {
    signal_source: "ACCESSIBILITY_TEXT",
    app_ref: "com.example.video",
    fingerprint: "a".repeat(64),
    category: "SELF_HARM_SUICIDE",
    severity: "HIGH",
    confidence: 0.81,
    reason_code: "SELF_HARM_DIRECT",
    classifier_version: "deterministic-rules-v1",
    capability_level: "BEST_EFFORT",
    action: "BLOCK_AND_REQUEST",
    occurred_at_millis: 1_700_000_000_000,
  } as const;
  const uploaded = jest.fn(() => Promise.resolve());
  const acknowledged = jest.fn(() => Promise.resolve());

  await flushPendingContentRiskEvents([queued], uploaded, acknowledged);

  expect(uploaded).toHaveBeenCalledWith({
    event_type: "SAFETY_CONTENT_RISK",
    occurred_at: "2023-11-14T22:13:20.000Z",
    app_ref: "com.example.video",
    category: "SELF_HARM_SUICIDE",
    severity: "HIGH",
    confidence: 0.81,
    reason_code: "SELF_HARM_DIRECT",
    signal_source: "ACCESSIBILITY_TEXT",
    action: "BLOCK_AND_REQUEST",
    classifier_version: "deterministic-rules-v1",
    capability_level: "BEST_EFFORT",
    content_fingerprint: "a".repeat(64),
  }, "content-risk:ACCESSIBILITY_TEXT:com.example.video:" + "a".repeat(64));
  expect(acknowledged).toHaveBeenCalledWith("ACCESSIBILITY_TEXT", "com.example.video", "a".repeat(64));
  expect(JSON.stringify(uploaded.mock.calls)).not.toContain("raw title");
});

test("content-risk upload failure retains its native outbox item for a later retry", async () => {
  const queued = {
    signal_source: "NOTIFICATION",
    app_ref: "com.example.chat",
    fingerprint: "b".repeat(64),
    category: "GROOMING_RISK",
    severity: "HIGH",
    confidence: 0.8,
    reason_code: "GROOMING_PATTERN",
    classifier_version: "deterministic-rules-v1",
    capability_level: "BEST_EFFORT",
    action: "BLOCK_AND_REQUEST",
    occurred_at_millis: 1_700_000_000_000,
  } as const;
  const acknowledged = jest.fn(() => Promise.resolve());

  await expect(flushPendingContentRiskEvents([queued], () => Promise.reject(new Error("offline")), acknowledged))
    .rejects.toThrow("offline");

  expect(acknowledged).not.toHaveBeenCalled();
});

test("screen test harness can render a state marker", () => {
  expect(render(<Text>pending-sync</Text>).getByText("pending-sync")).toBeTruthy();
});
