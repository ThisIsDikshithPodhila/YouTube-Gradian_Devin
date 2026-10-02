import * as SecureStore from "expo-secure-store";
export type Role = "parent" | "child";
const ROLE_KEY = "guardian.role";
export const roleStorage = {
  get: async (): Promise<Role | null> => {
    const role = await SecureStore.getItemAsync(ROLE_KEY);
    return role === "parent" || role === "child" ? role : null;
  },
  set: (role: Role) => SecureStore.setItemAsync(ROLE_KEY, role),
  clear: () => SecureStore.deleteItemAsync(ROLE_KEY),
};
