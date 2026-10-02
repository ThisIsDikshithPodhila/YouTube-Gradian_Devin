import { useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { api, sessionStorage } from "@/api/client";

export function useFamilySync(familyId: string | undefined, role: "parent" | "child") {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!familyId) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let retry = 0;
    let generation = 0;

    const refresh = () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["children", familyId] }),
        queryClient.invalidateQueries({ queryKey: ["health", familyId] }),
        queryClient.invalidateQueries({ queryKey: ["requests", familyId] }),
        queryClient.invalidateQueries({ queryKey: ["activity", familyId] }),
        queryClient.invalidateQueries({ queryKey: ["activity-usage", familyId] }),
        queryClient.invalidateQueries({ queryKey: ["device-policy"] }),
      ]).catch(() => undefined);
    };

    const reconnect = () => {
      if (cancelled || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, Math.min(1000 * 2 ** retry++, 30000));
    };

    const connect = async () => {
      const currentGeneration = generation;
      try {
        if (role === "parent") await api.me();
        const token = role === "parent"
          ? await sessionStorage.getAccessToken()
          : await sessionStorage.getDeviceToken();
        if (cancelled || currentGeneration !== generation || !token) return;
        const WebSocketWithHeaders = WebSocket as unknown as new (
          url: string,
          protocols?: string | string[],
          options?: { headers?: Record<string, string> },
        ) => WebSocket;
        const connection = new WebSocketWithHeaders(
          api.websocketUrl(`/v1/ws/${role}`, { family_id: familyId }),
          undefined,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        socket = connection;
        const resetWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => connection.close(), 45000);
        };
        resetWatchdog();
        connection.onmessage = ({ data }) => {
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
          if (event.type === "catch-up") retry = 0;
          refresh();
        };
        connection.onerror = () => connection.close();
        connection.onclose = (event) => {
          if (socket === connection) {
            if (watchdog) clearTimeout(watchdog);
            socket = null;
            if (event.code !== 1008) reconnect();
          }
        };
      } catch {
        if (currentGeneration === generation) reconnect();
      }
    };

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        generation++;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        socket?.close();
        socket = null;
        void connect();
      }
    });
    void connect();
    return () => {
      cancelled = true;
      generation++;
      subscription.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearTimeout(watchdog);
      socket?.close();
    };
  }, [familyId, role, queryClient]);
}
