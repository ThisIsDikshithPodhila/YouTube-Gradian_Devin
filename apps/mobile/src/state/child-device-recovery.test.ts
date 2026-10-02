jest.mock("@/api/client", () => ({
  sessionStorage: { clearDeviceIdentity: jest.fn() },
}));
jest.mock("@/state/role", () => ({
  roleStorage: { clear: jest.fn() },
}));
jest.mock("../../modules/guardian-protection/src", () => ({
  GuardianProtection: {
    stopProtection: jest.fn(),
    clearChildIdentity: jest.fn(),
  },
}));

import { sessionStorage } from "@/api/client";
import { clearRevokedChildDevice } from "@/state/child-device-recovery";
import { roleStorage } from "@/state/role";
import { GuardianProtection } from "../../modules/guardian-protection/src";

test("revoked-device recovery clears native and SecureStore child identity before removing the child role", async () => {
  (GuardianProtection.stopProtection as jest.Mock).mockRejectedValue(new Error("already stopped"));
  (GuardianProtection.clearChildIdentity as jest.Mock).mockResolvedValue(undefined);
  (sessionStorage.clearDeviceIdentity as jest.Mock).mockResolvedValue(undefined);
  (roleStorage.clear as jest.Mock).mockResolvedValue(undefined);

  await clearRevokedChildDevice();

  expect((GuardianProtection.stopProtection as jest.Mock).mock.calls).toHaveLength(1);
  expect((GuardianProtection.clearChildIdentity as jest.Mock).mock.calls).toHaveLength(1);
  expect(sessionStorage.clearDeviceIdentity).toHaveBeenCalledTimes(1);
  expect(roleStorage.clear).toHaveBeenCalledTimes(1);
  expect((roleStorage.clear as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
    (sessionStorage.clearDeviceIdentity as jest.Mock).mock.invocationCallOrder[0],
  );
});
