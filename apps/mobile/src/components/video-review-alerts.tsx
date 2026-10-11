import { Image, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AccessRequest } from "@/api/client";
import { useFamilySync } from "@/hooks/use-family-sync";
import { CardSurface, PrimaryButton, SecondaryButton } from "@/design-system";

export function parseVideoReview(request: AccessRequest) {
  const videoId = request.subject?.startsWith("youtube:") ? request.subject.slice("youtube:".length) : null;
  const [topic, title, channel] = (request.reason ?? "").split(" | ");
  return { videoId, topic: topic || "Needs review", title: title || "YouTube video", channel: channel || "" };
}

export function VideoReviewAlerts({ familyId, childNames }: { familyId: string; childNames: Record<string, string> }) {
  const queryClient = useQueryClient();
  useFamilySync(familyId, "parent");
  const requests = useQuery({
    queryKey: ["requests", familyId, "video-review"],
    queryFn: () => api.requests(familyId),
    refetchInterval: 5_000,
  });
  const decide = useMutation({
    mutationFn: ({ requestId, decision }: { requestId: string; decision: "approve" | "deny" }) =>
      api.decideRequest(familyId, requestId, decision, decision === "approve" ? "Approved this video" : "Blocked this video"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["requests", familyId] }),
  });
  const now = Date.now();
  const pending = (requests.data ?? []).filter((request) =>
    request.request_type === "VIDEO_REVIEW"
    && request.state === "PENDING"
    && (!request.expires_at || Date.parse(request.expires_at) > now));
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((request) => {
        const video = parseVideoReview(request);
        return (
          <CardSurface key={request.id}>
            <View style={styles.header} accessibilityLiveRegion="polite">
              <Text style={styles.live}>LIVE · YouTube</Text>
              <Text style={styles.heading}>{childNames[request.child_profile_id] ?? "Your child"} wants to watch</Text>
            </View>
            {video.videoId ? <Image source={{ uri: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg` }} style={styles.thumb} /> : null}
            <Text style={styles.title}>{video.title}</Text>
            {video.channel ? <Text style={styles.meta}>{video.channel}</Text> : null}
            <Text style={styles.badge}>Flagged: {video.topic}</Text>
            <PrimaryButton label="Approve video" disabled={decide.isPending} onPress={() => decide.mutate({ requestId: request.id, decision: "approve" })} />
            <SecondaryButton label="Block video" disabled={decide.isPending} onPress={() => decide.mutate({ requestId: request.id, decision: "deny" })} />
          </CardSurface>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  header: { gap: 2 },
  live: { color: "#b42318", fontWeight: "800", fontSize: 12, letterSpacing: 1 },
  heading: { fontSize: 18, fontWeight: "700" },
  thumb: { width: "100%", aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: "#dde3f0" },
  title: { fontSize: 16, fontWeight: "700" },
  meta: { fontSize: 14, color: "#55607a" },
  badge: { alignSelf: "flex-start", backgroundColor: "#fde8e8", color: "#b42318", fontWeight: "700", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
});
