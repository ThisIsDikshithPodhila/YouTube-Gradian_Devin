import type { AccessRequest, VideoSettings, VideoSettingsInput } from "@/api/client";

export function videoSettingsInput(settings: VideoSettings): VideoSettingsInput {
  return {
    trusted_channels: settings.trusted_channels,
    blocked_channels: settings.blocked_channels,
    learning_topics: settings.learning_topics,
    picks: settings.picks,
    learning_only: settings.learning_only,
    hide_shorts: settings.hide_shorts,
    hide_comments: settings.hide_comments,
    autoplay_next: settings.autoplay_next,
    youtube_guardian_only: settings.youtube_guardian_only,
  };
}

export function parseSos(request: AccessRequest) {
  const [, label, title] = (request.reason ?? "").split(" | ");
  return { label: label || "needs help", title: title || null };
}

export function withChannel(settings: VideoSettings, channel: string, list: "trusted" | "blocked") {
  const key = channel.trim().toLowerCase();
  const without = (values: string[]) => values.filter((value) => value.trim().toLowerCase() !== key);
  const input = videoSettingsInput(settings);
  return list === "trusted"
    ? { ...input, trusted_channels: [...without(input.trusted_channels), channel], blocked_channels: without(input.blocked_channels) }
    : { ...input, blocked_channels: [...without(input.blocked_channels), channel], trusted_channels: without(input.trusted_channels) };
}
