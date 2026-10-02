import { requireNativeModule } from "expo-modules-core";
import type {
  ApplyResult,
  CapabilityRecord,
  ContentApproval,
  PendingContentRiskEvent,
  ContentReviewRequest,
  GuardianNativeEvent,
  GuardianProtectionNative,
  ReputationApplyResult,
  ReputationStatus,
  ObservedApp,
  PermissionResult,
  ProtectionStatus,
  TimeRange,
  UsageSummary,
} from "@guardian/contracts";

type NativeModule = Omit<GuardianProtectionNative, "subscribe"> & {
  addListener(
    eventName: "onGuardianEvent",
    listener: (event: GuardianNativeEvent) => void,
  ): { remove: () => void };
};

const native = requireNativeModule<NativeModule>("GuardianProtection");

export const GuardianProtection: GuardianProtectionNative = {
  getCapabilities: () => native.getCapabilities(),
  getProtectionStatus: () => native.getProtectionStatus(),
  requestVpnPermission: () => native.requestVpnPermission(),
  openUsageAccessSettings: () => native.openUsageAccessSettings(),
  openAccessibilitySettings: () => native.openAccessibilitySettings(),
  setAccessibilityContentConsent: (granted: boolean): Promise<PermissionResult> =>
    native.setAccessibilityContentConsent(granted),
  setContentDeviceId: (deviceId: string): Promise<void> => native.setContentDeviceId(deviceId),
  clearChildIdentity: (): Promise<void> => native.clearChildIdentity(),
  applyContentApprovals: (approvals: ContentApproval[]) => native.applyContentApprovals(approvals),
  getPendingContentRiskEvents: (): Promise<PendingContentRiskEvent[]> => native.getPendingContentRiskEvents(),
  acknowledgeContentRiskEvent: (signalSource, appRef, fingerprint): Promise<void> =>
    native.acknowledgeContentRiskEvent(signalSource, appRef, fingerprint),
  getPendingContentReviewRequests: (): Promise<ContentReviewRequest[]> => native.getPendingContentReviewRequests(),
  acknowledgeContentReviewRequest: (appRef: string, fingerprint: string): Promise<void> =>
    native.acknowledgeContentReviewRequest(appRef, fingerprint),
  openNotificationAccessSettings: () => native.openNotificationAccessSettings(),
  startProtection: () => native.startProtection(),
  stopProtection: () => native.stopProtection(),
  applyPolicyBundle: (bundle: unknown): Promise<ApplyResult> => native.applyPolicyBundle(bundle),
  applyReputationBundle: (bundle: unknown): Promise<ReputationApplyResult> =>
    native.applyReputationBundle(bundle),
  getReputationStatus: (): Promise<ReputationStatus> => native.getReputationStatus(),
  getUsageSummary: (range: TimeRange): Promise<UsageSummary> => native.getUsageSummary(range),
  getPerformanceMetrics: () => native.getPerformanceMetrics(),
  getObservedApps: (): Promise<ObservedApp[]> => native.getObservedApps(),
  markObservedAppReviewed: (platformAppId: string): Promise<void> =>
    native.markObservedAppReviewed(platformAppId),
  subscribe: (listener: (event: GuardianNativeEvent) => void) => {
    let lastProtectionActive: boolean | undefined;
    const deliver = (event: GuardianNativeEvent) => {
      if (event.type === "PROTECTION_STATUS_CHANGED") {
        if (lastProtectionActive === event.status.active) return;
        lastProtectionActive = event.status.active;
      }
      listener(event);
    };
    const subscription = native.addListener("onGuardianEvent", deliver);
    void native.getProtectionStatus()
      .then((status) => deliver({ type: "PROTECTION_STATUS_CHANGED", status }))
      .catch(() => undefined);
    return subscription;
  },
};

export { type ApplyResult, type CapabilityRecord, type GuardianNativeEvent, type ObservedApp, type PermissionResult, type ProtectionStatus, type ReputationApplyResult, type ReputationStatus, type TimeRange, type UsageSummary };
