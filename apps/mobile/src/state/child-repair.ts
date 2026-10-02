import type { DeviceCredentials } from "@/api/client";

export type ChildRePairDependencies = {
  stopProtection: () => Promise<void>;
  clearNativeIdentity: () => Promise<void>;
  clearRequestOutbox: () => Promise<void>;
  configureNativeDevice: (deviceId: string) => Promise<void>;
  clearDeviceCredentials: () => Promise<void>;
  saveDeviceCredentials: (credentials: {
    privateKey: string;
    deviceToken: string;
    familyId: string;
  }) => Promise<void>;
};

/** Establishes a new child only after every prior child-specific state is gone. */
export async function activateChildRePair(
  credentials: DeviceCredentials,
  privateKey: string,
  dependencies: ChildRePairDependencies,
): Promise<void> {
  await dependencies.stopProtection();
  await dependencies.clearDeviceCredentials();
  try {
    await dependencies.clearNativeIdentity();
    await dependencies.clearRequestOutbox();
    await dependencies.configureNativeDevice(credentials.device_id);
    await dependencies.saveDeviceCredentials({
      privateKey,
      deviceToken: credentials.device_token,
      familyId: credentials.family_id,
    });
  } catch (error) {
    await dependencies.clearDeviceCredentials().catch(() => undefined);
    await dependencies.clearNativeIdentity().catch(() => undefined);
    throw error;
  }
}
