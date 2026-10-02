export type PairingUri = {
  sessionId: string;
  childId: string;
  code: string;
};

/** Parses the backend's guardian://pair/{session_id}?child_id={child_id}&code={code} contract. */
export function parsePairingUri(value: string): PairingUri | null {
  try {
    const uri = new URL(value);
    const sessionId = uri.protocol === "guardian:" && uri.hostname === "pair"
      ? uri.pathname.replace(/^\/+/, "")
      : "";
    const childId = uri.searchParams.get("child_id") ?? "";
    const code = uri.searchParams.get("code") ?? "";
    if (!sessionId || !childId || !/^\d{6}$/.test(code)) return null;
    return { sessionId, childId, code };
  } catch {
    return null;
  }
}
