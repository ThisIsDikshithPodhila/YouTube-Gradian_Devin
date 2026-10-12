import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type LearningTopic, type VideoSettingsInput } from "@/api/client";
import { videoSettingsInput } from "@/state/video-settings";
import { useFamilySync } from "@/hooks/use-family-sync";
import { videoIdFromUrl } from "@/state/youtube-video";
import { CardSurface, DataState, ListRow, PrimaryButton, ScreenScaffold, SecondaryButton, SectionSurface, TextField } from "@/design-system";

const EMPTY: VideoSettingsInput = {
  trusted_channels: [],
  blocked_channels: [],
  learning_topics: [],
  picks: [],
  learning_only: false,
  hide_shorts: true,
  hide_comments: true,
  autoplay_next: false,
  youtube_guardian_only: false,
};

const AGE_LABELS: Record<string, string> = {
  YOUNG_CHILD: "Under 9",
  PRETEEN: "9–12",
  TEEN: "13–15",
  OLDER_TEEN: "16–17",
};

function Toggle({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={styles.toggle}>
      <View style={styles.toggleText}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      <Text style={[styles.pill, value ? styles.on : styles.off]}>{value ? "On" : "Off"}</Text>
    </Pressable>
  );
}

export default function YouTubeLearningRoute() {
  const { familyId, childId } = useLocalSearchParams<{ familyId: string; childId: string }>();
  const queryClient = useQueryClient();
  useFamilySync(familyId, "parent", childId);
  const rules = useQuery({
    queryKey: ["video-rules", familyId, childId],
    queryFn: () => api.videoRules(familyId, childId),
    enabled: Boolean(familyId && childId),
  });
  const [draft, setDraft] = useState<VideoSettingsInput>(EMPTY);
  const [topicLabel, setTopicLabel] = useState("");
  const [topicKeywords, setTopicKeywords] = useState("");
  const [channel, setChannel] = useState("");
  const [pickUrl, setPickUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!rules.data) return;
    setDraft(videoSettingsInput(rules.data.settings));
  }, [rules.data]);
  const save = useMutation({
    mutationFn: (next: VideoSettingsInput) => api.updateVideoSettings(familyId, childId, next),
    onSuccess: (saved) => {
      setDraft(videoSettingsInput(saved));
      setMessage("Saved. Your child's YouTube updates right away.");
      void queryClient.invalidateQueries({ queryKey: ["video-rules", familyId, childId] });
    },
    onError: () => setMessage("Couldn't save. Check your connection and try again."),
  });
  const update = (patch: Partial<VideoSettingsInput>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    save.mutate(next);
  };
  const hasTopic = (topic: LearningTopic) => draft.learning_topics.some((t) => t.label === topic.label);
  const toggleTopic = (topic: LearningTopic) =>
    update({ learning_topics: hasTopic(topic) ? draft.learning_topics.filter((t) => t.label !== topic.label) : [...draft.learning_topics, topic] });
  const addChannel = (list: "trusted_channels" | "blocked_channels") => {
    const name = channel.trim();
    if (!name) return;
    const other = list === "trusted_channels" ? "blocked_channels" : "trusted_channels";
    const key = name.toLowerCase();
    update({
      [list]: [...draft[list].filter((c) => c.toLowerCase() !== key), name],
      [other]: draft[other].filter((c) => c.toLowerCase() !== key),
    });
    setChannel("");
  };
  const addPick = () => {
    const videoId = videoIdFromUrl(pickUrl.trim());
    if (!videoId) {
      setMessage("Paste a YouTube video link, for example https://youtu.be/…");
      return;
    }
    update({ picks: [...draft.picks.filter((p) => p.video_id !== videoId), { video_id: videoId }] });
    setPickUrl("");
  };
  const ageBand = rules.data?.age_band ?? "";
  const suggestions = rules.data?.suggested_learning_topics ?? [];
  const custom = draft.learning_topics.filter((t) => !suggestions.some((s) => s.label === t.label));
  return (
    <ScreenScaffold title="YouTube & learning">
      <DataState state={rules.isLoading ? "loading" : rules.isError ? "error" : "loaded"} onRetry={() => void rules.refetch()}>
        <SectionSurface>
          {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
          <CardSurface>
            <Text style={styles.heading}>What should they learn? · Age {AGE_LABELS[ageBand] ?? ageBand}</Text>
            <Text style={styles.detail}>Topics show as one-tap “Watch & learn” buttons on your child's YouTube screen. Every video is still checked before it plays.</Text>
            <View style={styles.chips}>
              {suggestions.map((topic) => (
                <Pressable key={topic.label} accessibilityRole="checkbox" accessibilityLabel={topic.label} accessibilityState={{ checked: hasTopic(topic) }} onPress={() => toggleTopic(topic)} style={[styles.chip, hasTopic(topic) && styles.chipOn]}>
                  <Text style={[styles.chipText, hasTopic(topic) && styles.chipTextOn]}>{topic.label}</Text>
                </Pressable>
              ))}
              {custom.map((topic) => (
                <Pressable key={topic.label} accessibilityRole="checkbox" accessibilityLabel={topic.label} accessibilityState={{ checked: true }} onPress={() => toggleTopic(topic)} style={[styles.chip, styles.chipOn]}>
                  <Text style={[styles.chipText, styles.chipTextOn]}>{topic.label} ✕</Text>
                </Pressable>
              ))}
            </View>
            <TextField label="Your own topic (e.g. Solar system)" value={topicLabel} onChangeText={setTopicLabel} />
            <TextField label="Search keywords (e.g. solar system for kids)" value={topicKeywords} onChangeText={setTopicKeywords} />
            <SecondaryButton label="Add topic" disabled={!topicLabel.trim()} onPress={() => {
              toggleTopic({ label: topicLabel.trim(), keywords: (topicKeywords.trim() || topicLabel.trim()) });
              setTopicLabel("");
              setTopicKeywords("");
            }} />
            <Toggle label="Only learning picks and trusted channels" detail="Anything else waits for your OK." value={draft.learning_only} onChange={(value) => update({ learning_only: value })} />
          </CardSurface>
          <CardSurface>
            <Text style={styles.heading}>Your picks to watch</Text>
            {draft.picks.map((pick) => (
              <ListRow key={pick.video_id} label={pick.title ?? pick.video_id} value="Remove" onPress={() => update({ picks: draft.picks.filter((p) => p.video_id !== pick.video_id) })} />
            ))}
            <TextField label="YouTube video link" value={pickUrl} onChangeText={setPickUrl} />
            <SecondaryButton label="Add to picks" disabled={!pickUrl.trim()} onPress={addPick} />
          </CardSurface>
          <CardSurface>
            <Text style={styles.heading}>Channels</Text>
            <TextField label="Channel name" value={channel} onChangeText={setChannel} />
            <SecondaryButton label="Trust channel" disabled={!channel.trim()} onPress={() => addChannel("trusted_channels")} />
            <SecondaryButton label="Block channel" disabled={!channel.trim()} onPress={() => addChannel("blocked_channels")} />
            {draft.trusted_channels.map((name) => (
              <ListRow key={`t-${name}`} label={`Trusted · ${name}`} value="Remove" onPress={() => update({ trusted_channels: draft.trusted_channels.filter((c) => c !== name) })} />
            ))}
            {draft.blocked_channels.map((name) => (
              <ListRow key={`b-${name}`} label={`Blocked · ${name}`} value="Remove" onPress={() => update({ blocked_channels: draft.blocked_channels.filter((c) => c !== name) })} />
            ))}
          </CardSurface>
          <CardSurface>
            <Text style={styles.heading}>Player</Text>
            <Toggle label="Hide Shorts" detail="Shorts open as normal videos and are checked first." value={draft.hide_shorts} onChange={(value) => update({ hide_shorts: value })} />
            <Toggle label="Hide comments" detail="Comments are hidden under every video." value={draft.hide_comments} onChange={(value) => update({ hide_comments: value })} />
            <Toggle label="Autoplay next video" detail="When off, the next video doesn't start by itself." value={draft.autoplay_next} onChange={(value) => update({ autoplay_next: value })} />
            <Toggle label="YouTube only inside Guardian" detail="Blocks youtube.com in the YouTube app and other browsers on the child phone (needs web protection on)." value={draft.youtube_guardian_only} onChange={(value) => update({ youtube_guardian_only: value })} />
          </CardSurface>
          <PrimaryButton label={save.isPending ? "Saving…" : "Save"} disabled={save.isPending} onPress={() => save.mutate(draft)} />
        </SectionSurface>
      </DataState>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 17, fontWeight: "700" },
  detail: { fontSize: 13, color: "#55607a" },
  message: { fontSize: 14, color: "#067647", fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: "#c7d0e6", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipOn: { backgroundColor: "#2b4fd6", borderColor: "#2b4fd6" },
  chipText: { fontSize: 14, color: "#24304d" },
  chipTextOn: { color: "white", fontWeight: "700" },
  toggle: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 15, fontWeight: "600" },
  pill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4, fontWeight: "700", overflow: "hidden" },
  on: { backgroundColor: "#d1fadf", color: "#067647" },
  off: { backgroundColor: "#eef1f7", color: "#55607a" },
});
