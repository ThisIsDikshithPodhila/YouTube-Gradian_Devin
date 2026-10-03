import { act, render, waitFor } from "@testing-library/react-native";
import { Alert, AppState, Linking, type AppStateStatus } from "react-native";
import ChildHomeRoute from "@/app/child/home";

const mockSetParams = jest.fn();
const mockAcknowledgePolicy = jest.fn<Promise<void>, [number]>();
const mockGetCapabilities = jest.fn<Promise<unknown>, []>();
const mockGetProtectionStatus = jest.fn<Promise<unknown>, []>();
const mockApplyPolicyBundle = jest.fn<Promise<unknown>, [unknown]>();
const mockPolicy = { policy_version: 11, version_mismatch: true, bundle: {} };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), setParams: mockSetParams }),
  useLocalSearchParams: () => ({ openYouTube: "true" }),
}));

jest.mock("@/state/network", () => ({ useNetworkStatus: () => ({ isOffline: false }) }));
jest.mock("@/hooks/use-family-sync", () => ({ useFamilySync: jest.fn() }));

jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockPolicy,
    isLoading: false,
    isError: false,
  }),
}));

jest.mock("@/api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    acknowledgePolicy: (version: number) => mockAcknowledgePolicy(version),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    contentApprovals: jest.fn().mockResolvedValue([]),
    reputation: jest.fn().mockResolvedValue({ bundle: null, deltas: [] }),
    ingestInventory: jest.fn().mockResolvedValue(undefined),
  },
  sessionStorage: { getFamilyId: jest.fn().mockResolvedValue("family-1") },
}));

jest.mock("../../../modules/guardian-protection/src", () => ({
  GuardianProtection: {
    getProtectionStatus: () => mockGetProtectionStatus(),
    getCapabilities: () => mockGetCapabilities(),
    getPerformanceMetrics: jest.fn().mockResolvedValue({}),
    getReputationStatus: jest.fn().mockResolvedValue({ version: 0 }),
    getPendingContentReviewRequests: jest.fn().mockResolvedValue([]),
    getPendingContentRiskEvents: jest.fn().mockResolvedValue([]),
    getUsageSummary: jest.fn().mockResolvedValue({ byTarget: {} }),
    getObservedApps: jest.fn().mockResolvedValue([]),
    applyPolicyBundle: (bundle: unknown) => mockApplyPolicyBundle(bundle),
    startProtection: jest.fn().mockResolvedValue(undefined),
    applyContentApprovals: jest.fn().mockResolvedValue(undefined),
    subscribe: () => ({ remove: jest.fn() }),
  },
}));

test.each([false, true])("paired Child opens YouTube once after protection (unavailable: %s)", async (unavailable) => {
  let vpnReady = false;
  const listeners: Array<(state: AppStateStatus) => void> = [];
  const appState = jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    listeners.push(listener);
    return { remove: jest.fn() };
  });
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  if (unavailable) openURL.mockRejectedValue(new Error("No handler"));
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  mockSetParams.mockClear();
  mockAcknowledgePolicy.mockReset().mockResolvedValue(undefined);
  mockApplyPolicyBundle.mockReset().mockResolvedValue({ applied: true });
  mockGetCapabilities.mockImplementation(() => Promise.resolve({
    vpn_filtering: { level: vpnReady ? "FULL" : "UNAVAILABLE", detail: "VPN consent is required." },
    web_filtering: { level: vpnReady ? "FULL" : "UNAVAILABLE" },
    app_blocking: { level: "UNAVAILABLE" },
    accessibility_signals: { level: "UNAVAILABLE" },
  }));
  mockGetProtectionStatus.mockImplementation(() => Promise.resolve({ active: vpnReady, health: "PROTECTED" }));

  const screen = render(<ChildHomeRoute />);
  await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(screen.getByText("Policy version: 11")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("YouTube will open after web protection is active.")).toBeTruthy());
  expect(openURL).not.toHaveBeenCalled();
  expect(mockAcknowledgePolicy).not.toHaveBeenCalled();
  expect(mockApplyPolicyBundle).toHaveBeenCalledTimes(1);
  expect(listeners).toHaveLength(2);

  vpnReady = true;
  await act(async () => {
    listeners.forEach((listener) => listener("active"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  expect(mockApplyPolicyBundle).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(mockAcknowledgePolicy).toHaveBeenCalledWith(11));
  await waitFor(() => expect(openURL).toHaveBeenCalledWith("https://www.youtube.com/"));
  expect(openURL).toHaveBeenCalledTimes(1);
  expect(mockSetParams).toHaveBeenCalledWith({ openYouTube: undefined });
  if (unavailable) {
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      "YouTube unavailable", "Open YouTube from your home screen or try again later.",
    ));
  } else {
    expect(alert).not.toHaveBeenCalled();
  }

  await act(async () => {
    listeners.forEach((listener) => listener("active"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await waitFor(() => expect(mockAcknowledgePolicy).toHaveBeenCalledTimes(2));
  expect(openURL).toHaveBeenCalledTimes(1);
  screen.unmount();
  appState.mockRestore();
  openURL.mockRestore();
  alert.mockRestore();
});
