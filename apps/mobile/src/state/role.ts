import * as SecureStore from "expo-secure-store";
export type Role = "parent" | "child";
const ROLE_KEY = "guardian.role";
const buildRole = process.env.EXPO_PUBLIC_GUARDIAN_ROLE;
export const configuredRole: Role | null = buildRole === "parent" || buildRole === "child" ? buildRole : null;
export const roleStorage = {
  get: async (): Promise<Role | null> => {
    if (configuredRole) return configuredRole;
    const role = await SecureStore.getItemAsync(ROLE_KEY);
    return role === "parent" || role === "child" ? role : null;
  },
  set: (role: Role) => SecureStore.setItemAsync(ROLE_KEY, configuredRole ?? role),
  clear: () => SecureStore.deleteItemAsync(ROLE_KEY),
};
