import { parseSos, withChannel } from "./video-settings";
import type { AccessRequest, VideoSettings } from "@/api/client";

const settings: VideoSettings = {
  trusted_channels: ["Science Kids"],
  blocked_channels: ["Shock Clips"],
  learning_topics: [],
  picks: [],
  learning_only: false,
  hide_shorts: true,
  hide_comments: true,
  autoplay_next: false,
  youtube_guardian_only: false,
  rules_revision: 3,
};

test("trusting a channel removes it from the blocked list and drops the revision", () => {
  const next = withChannel(settings, "shock clips", "trusted");
  expect(next.trusted_channels).toEqual(["Science Kids", "shock clips"]);
  expect(next.blocked_channels).toEqual([]);
  expect("rules_revision" in next).toBe(false);
});

test("blocking a channel removes it from the trusted list", () => {
  const next = withChannel(settings, "Science Kids", "blocked");
  expect(next.trusted_channels).toEqual([]);
  expect(next.blocked_channels).toEqual(["Shock Clips", "Science Kids"]);
});

test("SOS reason is shown as a parent-readable label", () => {
  const request = { reason: "SCARY_CONTENT | saw something scary | Scary clip" } as AccessRequest;
  expect(parseSos(request)).toEqual({ label: "saw something scary", title: "Scary clip" });
});
