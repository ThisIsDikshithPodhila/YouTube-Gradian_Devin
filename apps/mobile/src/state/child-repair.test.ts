import { activateChildRePair } from "@/state/child-repair";

test("re-pairing B removes A policy, inventory, outbox, and credentials before B starts at policy v1", async () => {
  const state = {
    protectionRunning: true,
    policyVersion: 7 as number | null,
    inventory: ["com.family-a.app"],
    outbox: ["request-for-family-a"],
    nativeDeviceId: "device-a" as string | null,
    credentials: { privateKey: "private-a", familyId: "family-a", deviceToken: "token-a" } as {
      privateKey: string | null;
      familyId: string | null;
      deviceToken: string | null;
    },
  };
  const calls: string[] = [];

  await activateChildRePair(
    { device_id: "device-b", device_token: "token-b", family_id: "family-b" },
    "private-b",
    {
      stopProtection: () => {
        calls.push("stopProtection");
        state.protectionRunning = false;
        return Promise.resolve();
      },
      clearDeviceCredentials: () => {
        calls.push("clearDeviceCredentials");
        state.credentials = { privateKey: null, familyId: null, deviceToken: null };
        return Promise.resolve();
      },
      clearNativeIdentity: () => {
        calls.push("clearNativeIdentity");
        state.policyVersion = null;
        state.inventory = [];
        state.nativeDeviceId = null;
        return Promise.resolve();
      },
      clearRequestOutbox: () => {
        calls.push("clearRequestOutbox");
        state.outbox = [];
        return Promise.resolve();
      },
      configureNativeDevice: (deviceId) => {
        calls.push("configureNativeDevice");
        state.nativeDeviceId = deviceId;
        return Promise.resolve();
      },
      saveDeviceCredentials: (next) => {
        calls.push("saveDeviceCredentials");
        expect(state.credentials).toEqual({ privateKey: null, familyId: null, deviceToken: null });
        state.credentials = next;
        return Promise.resolve();
      },
    },
  );

  expect(calls).toEqual([
    "stopProtection",
    "clearDeviceCredentials",
    "clearNativeIdentity",
    "clearRequestOutbox",
    "configureNativeDevice",
    "saveDeviceCredentials",
  ]);
  expect(state).toEqual({
    protectionRunning: false,
    policyVersion: null,
    inventory: [],
    outbox: [],
    nativeDeviceId: "device-b",
    credentials: { privateKey: "private-b", familyId: "family-b", deviceToken: "token-b" },
  });
  state.policyVersion = 1;
  expect(state.policyVersion).toBe(1);
});

test("a failed B credential commit removes partial device and native identity", async () => {
  const calls: string[] = [];
  await expect(activateChildRePair(
    { device_id: "device-b", device_token: "token-b", family_id: "family-b" },
    "private-b",
    {
      stopProtection: () => Promise.resolve(),
      clearNativeIdentity: () => {
        calls.push("clearNativeIdentity");
        return Promise.resolve();
      },
      clearRequestOutbox: () => Promise.resolve(),
      configureNativeDevice: () => Promise.resolve(),
      clearDeviceCredentials: () => {
        calls.push("clearDeviceCredentials");
        return Promise.resolve();
      },
      saveDeviceCredentials: () => Promise.reject(new Error("Secure storage failed")),
    },
  )).rejects.toThrow("Secure storage failed");

  expect(calls).toEqual([
    "clearDeviceCredentials",
    "clearNativeIdentity",
    "clearDeviceCredentials",
    "clearNativeIdentity",
  ]);
});
