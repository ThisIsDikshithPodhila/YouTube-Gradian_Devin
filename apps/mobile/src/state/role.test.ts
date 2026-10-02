import { roleStorage } from "@/state/role";
import * as SecureStore from "expo-secure-store";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

test("role storage rejects values outside the supported role model", async () => {
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue("admin");
  await expect(roleStorage.get()).resolves.toBeNull();
});

test.each(["parent", "child"] as const)("%s APK ignores a stored role from the other client", async (role) => {
  process.env.EXPO_PUBLIC_GUARDIAN_ROLE = role;
  try {
    jest.resetModules();
    const clientRoleStorage = jest.requireActual<typeof import("@/state/role")>("@/state/role").roleStorage;
    const secureStore = jest.requireMock<typeof import("expo-secure-store")>("expo-secure-store");
    (secureStore.getItemAsync as jest.Mock).mockResolvedValue(role === "parent" ? "child" : "parent");
    await expect(clientRoleStorage.get()).resolves.toBe(role);
    await clientRoleStorage.set(role === "parent" ? "child" : "parent");
    expect(secureStore.setItemAsync).toHaveBeenLastCalledWith("guardian.role", role);
  } finally {
    delete process.env.EXPO_PUBLIC_GUARDIAN_ROLE;
    jest.resetModules();
  }
});
