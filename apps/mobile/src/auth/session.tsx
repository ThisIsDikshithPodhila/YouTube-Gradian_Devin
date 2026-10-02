import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, Parent, sessionStorage, subscribeToParentSessionExpiry, Tokens } from "@/api/client";

type SessionContextValue = {
  parent: Parent | null;
  loading: boolean;
  familyId: string | null;
  childId: string | null;
  sessionError: "SESSION_EXPIRED" | null;
  signIn: (tokens: Tokens) => Promise<void>;
  setFamilyId: (familyId: string) => Promise<void>;
  setChildId: (childId: string) => Promise<void>;
  signOut: () => Promise<void>;
};
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const [parent, setParent] = useState<Parent | null>(null);
  const [loading, setLoading] = useState(true);
  const [familyId, setFamilyIdState] = useState<string | null>(null);
  const [childId, setChildIdState] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<"SESSION_EXPIRED" | null>(null);

  const discoverFamily = async () => {
    const [families, storedFamilyId, storedChildId] = await Promise.all([
      api.families(),
      sessionStorage.getFamilyId(),
      sessionStorage.getSelectedChildId(),
    ]);
    const family = families.find((item) => item.id === storedFamilyId) ?? families.at(0);
    if (family === undefined) return { familyId: null, childId: null };
    const children = await api.children(family.id);
    const child = children.find((item) => item.id === storedChildId) ?? children.at(0);
    await sessionStorage.setFamilyId(family.id);
    if (child !== undefined) await sessionStorage.setSelectedChildId(child.id);
    return { familyId: family.id, childId: child?.id ?? null };
  };
  useEffect(
    () => subscribeToParentSessionExpiry(() => {
      // The API client has already removed parent credentials.  Do not touch
      // the paired child device credentials: child protection continues.
      setParent(null);
      setSessionError("SESSION_EXPIRED");
    }),
    [],
  );
  useEffect(() => {
    sessionStorage.getAccessToken()
      .then(async (token) => {
        if (!token) return null;
        const [currentParent, selection] = await Promise.all([api.me(), discoverFamily()]);
        setFamilyIdState(selection.familyId);
        setChildIdState(selection.childId);
        return currentParent;
      })
      .then(setParent)
      .catch(async (error: unknown) => {
        await sessionStorage.clearParentSession();
        setParent(null);
        setSessionError(error instanceof ApiError && error.code === "SESSION_EXPIRED" ? "SESSION_EXPIRED" : null);
      })
      .finally(() => setLoading(false));
  }, []);
  const value = useMemo(() => ({
    childId,
    parent,
    loading,
    familyId,
    sessionError,
    signIn: async (tokens: Tokens) => {
      await sessionStorage.setTokens(tokens);
      const [currentParent, selection] = await Promise.all([api.me(), discoverFamily()]);
      setParent(currentParent);
      setFamilyIdState(selection.familyId);
      setChildIdState(selection.childId);
      setSessionError(null);
    },
    setFamilyId: async (nextFamilyId: string) => { await sessionStorage.setFamilyId(nextFamilyId); setFamilyIdState(nextFamilyId); },
    setChildId: async (nextChildId: string) => { await sessionStorage.setSelectedChildId(nextChildId); setChildIdState(nextChildId); },
    signOut: async () => {
      try {
        await api.logout();
      } finally {
        await sessionStorage.clearParentSession();
        setParent(null);
        setFamilyIdState(null);
        setChildIdState(null);
        setSessionError(null);
      }
    },
  }), [childId, familyId, loading, parent, sessionError]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used within SessionProvider");
  return value;
}
