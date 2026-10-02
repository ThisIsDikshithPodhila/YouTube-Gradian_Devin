import { useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { api, sessionStorage } from "@/api/client";

const POLL_INTERVAL_MS = 2_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const WATCHDOG_TIMEOUT_MS = 45_000;

export function useFamilySync(
  familyId: string | undefined,
  role: "parent" | "child",
  childId?: string,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!familyId) return;
    let socket: WebSocket | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    let generation = 0;
    let cancelled = false;

    const invalidateFamilyQueries = () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["children", familyId] }),
      queryClient.invalidateQueries({ queryKey: ["health", familyId] }),
      queryClient.invalidateQueries({ queryKey: ["requests", familyId] }),
      queryClient.invalidateQueries({ queryKey: ["activity", familyId] }),
      queryClient.invalidateQueries({ queryKey: ["activity-usage", familyId] }),
      queryClient.invalidateQueries({ queryKey: ["device-policy"] }),
    ]).catch(() => undefined);

    const stopPolling = () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    };

    const startPolling = () => {
      if (pollTimer !== null || cancelled) return;
      void invalidateFamilyQueries();
      pollTimer = setInterval(() => void invalidateFamilyQueries(), POLL_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      startPolling();
      if (reconnectTimer !== null) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      const currentGeneration = generation;
      try {
        const token = role === "parent"
          ? await api.realtimeToken()
          : await sessionStorage.getDeviceToken();
        if (cancelled || currentGeneration !== generation) return;
        if (!token) {
          scheduleReconnect();
          return;
        }
        const WebSocketWithHeaders = WebSocket as unknown as new (
          url: string,
          protocols?: string | string[],
          options?: { headers?: Record<string, string> },
        ) => WebSocket;
        const connection = new WebSocketWithHeaders(
          api.websocketUrl(`/v1/ws/${role}`, {
            family_id: familyId,
            ...(role === "parent" && childId ? { child_profile_id: childId } : {}),
          }),
          undefined,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        socket = connection;
        const resetWatchdog = () => {
          if (watchdog !== null) clearTimeout(watchdog);
          watchdog = setTimeout(() => connection.close(), WATCHDOG_TIMEOUT_MS);
        };
        resetWatchdog();
        connection.onopen = () => {
          if (socket !== connection) return;
          reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          stopPolling();
        };
        connection.onmessage = ({ data }) => {
          if (socket !== connection) return;
          resetWatchdog();
          let event: { type?: string };
          try {
            event = JSON.parse(String(data)) as { type?: string };
          } catch {
            return;
          }
          if (event.type === "ping") {
            connection.send("pong");
            return;
          }
          void invalidateFamilyQueries();
        };
        connection.onerror = () => connection.close();
        connection.onclose = (event) => {
          if (socket !== connection) return;
          if (watchdog !== null) clearTimeout(watchdog);
          watchdog = null;
          socket = null;
          if (event.code === 1008) startPolling();
          else scheduleReconnect();
        };
      } catch {
        if (currentGeneration === generation) scheduleReconnect();
      }
    };

    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      generation++;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
      const previous = socket;
      socket = null;
      previous?.close();
      void invalidateFamilyQueries();
      void connect();
    });
    void connect();
    return () => {
      cancelled = true;
      generation++;
      subscription.remove();
      stopPolling();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (watchdog !== null) clearTimeout(watchdog);
      socket?.close();
    };
  }, [childId, familyId, role, queryClient]);
}
