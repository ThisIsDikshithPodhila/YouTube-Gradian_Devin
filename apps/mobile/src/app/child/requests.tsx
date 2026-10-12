import { useCallback, useEffect, useState } from "react";
import { AppState, Text } from "react-native";
import { api } from "@/api/client";
import { useNetworkStatus } from "@/state/network";
import {
  enqueueRequest,
  flushRequestOutbox,
  readRequestOutbox,
  type QueuedAccessRequest,
} from "@/state/request-outbox";
import { CardSurface, PrimaryButton, ScreenScaffold, SectionSurface, TextField } from "@/design-system";

export default function ChildRequestsRoute() {
  const limitedChildBuild = process.env.EXPO_PUBLIC_GUARDIAN_LIMITED_CHILD === "true";
  const { isOffline } = useNetworkStatus();
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<QueuedAccessRequest[]>([]);
  const sync = useCallback(async () => {
    try {
      const remaining = await flushRequestOutbox((item) =>
        api.createRequest({
          request_type: item.request_type,
          subject: item.subject,
          reason: item.reason,
        }, item.idempotencyKey ?? item.id),
      );
      setOutbox(remaining);
      if (remaining.some((item) => item.state === "DEVICE_REVOKED")) {
        setMessage("This device was revoked before the request could be delivered.");
      } else if (remaining.some((item) => item.state === "FAILED")) {
        setMessage("The request is still queued and will retry when online.");
      } else if (remaining.length === 0) {
        setMessage("Request delivered. A parent can review it.");
      }
    } catch {
      const queued = await readRequestOutbox().catch(() => []);
      setOutbox(queued);
      setMessage("The request is still queued and will retry when online.");
    }
  }, []);
  useEffect(() => {
    void readRequestOutbox().then(setOutbox).catch(() => setOutbox([]));
  }, []);
  useEffect(() => {
    if (!isOffline) {
      void sync().catch(() => {
        setMessage("The request is still queued and will retry when online.");
      });
    }
  }, [isOffline, sync]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void sync().catch(() => {
          setMessage("The request is still queued and will retry when online.");
        });
      }
    });
    return () => subscription.remove();
  }, [sync]);
  const create = async (
    requestType: "MORE_TIME" | "UNBLOCK_APP" | "UNBLOCK_SITE",
  ) => {
    const item: QueuedAccessRequest = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      idempotencyKey: `child-request-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      request_type: requestType,
      subject: subject || null,
      reason: reason || null,
      state: "QUEUED",
    };
    try {
      await enqueueRequest(item);
      setOutbox((current) => [...current, item]);
      setMessage(
        isOffline
          ? "Queued locally. This cannot unlock anything until approval reaches this device."
          : "Sending request…",
      );
      if (!isOffline) await sync();
    } catch {
      setMessage("The request could not be saved on this device. Try again.");
    }
  };
  return (
    <ScreenScaffold title="Ask for help">
      <SectionSurface>
        <Text>Requests can be queued while offline. A queued request unlocks nothing until a parent approves it and that approval reaches this device.</Text>
        {isOffline ? <Text>Offline · queued requests will sync when connectivity returns.</Text> : null}
        <TextField label={limitedChildBuild ? "Website (optional)" : "App or website (optional)"} value={subject} onChangeText={setSubject} />
        <TextField label="Note to parent (optional)" value={reason} onChangeText={setReason} />
        {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
        <CardSurface>
          {!limitedChildBuild ? <PrimaryButton label="Ask for more time" onPress={() => void create("MORE_TIME")} /> : null}
          {!limitedChildBuild ? (
            <PrimaryButton label="Ask to unblock app" disabled={!subject} onPress={() => void create("UNBLOCK_APP")} />
          ) : null}
          <PrimaryButton label="Ask to unblock site" disabled={!subject} onPress={() => void create("UNBLOCK_SITE")} />
        </CardSurface>
        {outbox.map((item) => (
          <Text key={item.id}>
            {item.state === "QUEUED"
              ? "Queued · waiting for connectivity"
              : item.state === "DEVICE_REVOKED"
                ? "Not delivered · this device was revoked"
                : "Delivery failed · will retry when online"}
          </Text>
        ))}
      </SectionSurface>
    </ScreenScaffold>
  );
}
