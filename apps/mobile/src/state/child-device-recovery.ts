import { sessionStorage } from "@/api/client";
import { roleStorage } from "@/state/role";
import { GuardianProtection } from "../../modules/guardian-protection/src";

/** Explicit re-pairing reset for a child device rejected by the family service. */
export async function clearRevokedChildDevice(): Promise<void> {
  await Promise.allSettled([
    GuardianProtection.stopProtection(),
    GuardianProtection.clearChildIdentity(),
  ]);
  await sessionStorage.clearDeviceIdentity();
  await roleStorage.clear();
}
