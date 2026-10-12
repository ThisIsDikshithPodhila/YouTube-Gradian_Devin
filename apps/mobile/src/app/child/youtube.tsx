import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { api, sessionStorage, type DeviceVideoSettings, type VideoCheck } from "@/api/client";
import { useFamilySync } from "@/hooks/use-family-sync";
import { PrimaryButton, SecondaryButton } from "@/design-system";
import { isAllowedYouTubeNavigation, videoIdFromUrl } from "@/state/youtube-video";

const YOUTUBE_HOME = "https://m.youtube.com/";

const PLAY_GATE_SCRIPT = `
(function () {
  if (window.__guardianGate) return;
  window.__guardianGate = true;
  window.__guardianAllowed = window.__guardianAllowed || {};
  function currentId() {
    var match = /[?&]v=([A-Za-z0-9_-]{11})/.exec(location.search)
      || /\\/(?:shorts|live|embed)\\/([A-Za-z0-9_-]{11})/.exec(location.pathname)
      || (/(^|\\.)youtu\\.be$/.test(location.hostname) ? /^\\/([A-Za-z0-9_-]{11})/.exec(location.pathname) : null);
    return match ? match[1] : null;
  }
  document.addEventListener("play", function (event) {
    var id = currentId();
    if (id && !window.__guardianAllowed[id]) window.__guardianHold = true;
    if (window.__guardianHold && event.target && event.target.pause) event.target.pause();
  }, true);
})();
true;
`;

const WATCH_SCRIPT = `
(function () {
  if (window.__guardianWatch) return;
  window.__guardianWatch = true;
  if (/(^|\\.)youtube\\.com$/.test(location.hostname) && document.cookie.indexOf("f2=8000000") === -1) {
    document.cookie = "PREF=f2=8000000; domain=.youtube.com; path=/; max-age=31536000";
    if (!sessionStorage.getItem("guardianRestricted")) {
      sessionStorage.setItem("guardianRestricted", "1");
      location.reload();
      return;
    }
  }
  window.__guardianHold = false;
  var lastHref = "";
  var videoPage = /\\/(watch|shorts\\/|live\\/|embed\\/)/;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (videoPage.test(location.pathname + "/")) window.__guardianHold = true;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "url", href: lastHref }));
    }
    if (window.__guardianHold) {
      document.querySelectorAll("video").forEach(function (video) { if (!video.paused) video.pause(); });
    }
  }, 250);
})();
true;
`;

const RESTRICT_SCRIPT = `
(function () {
  if (window.__guardianRestrict) return;
  window.__guardianRestrict = true;
  var style = document.createElement("style");
  style.id = "guardian-restrict";
  (document.head || document.documentElement).appendChild(style);
  var lastVideoPage = false;
  var endedAt = 0;
  var touchedAt = 0;
  document.addEventListener("ended", function () { endedAt = Date.now(); }, true);
  document.addEventListener("touchstart", function () { touchedAt = Date.now(); }, true);
  document.addEventListener("click", function () { touchedAt = Date.now(); }, true);
  function apply() {
    var s = window.__guardianSettings || { hide_shorts: true, hide_comments: true, autoplay_next: false };
    var css = "";
    if (s.hide_comments) css += "ytm-comment-section-renderer, ytm-comments-entry-point-header-renderer, ytm-comments-entry-point-teaser-renderer, ytm-item-section-renderer[section-identifier='comment-item-section'], #comments, ytm-engagement-panel-section-list-renderer[target-id*='comment'] { display: none !important; }";
    if (s.hide_shorts) css += "ytm-reel-shelf-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytm-reel-item-renderer, ytm-pivot-bar-item-renderer:has(.pivot-shorts), ytm-pivot-bar-item-renderer:has(a[href^='/shorts']), ytm-rich-item-renderer:has(a[href^='/shorts']), ytm-rich-section-renderer:has(a[href^='/shorts']), grid-shelf-view-model:has(a[href^='/shorts']), ytm-chip-cloud-chip-renderer:has(a[href^='/shorts']) { display: none !important; }";
    if (!s.autoplay_next) css += ".ytm-autonav-toggle-button-container, ytm-autonav-toggle-button-renderer, .ytp-autonav-endscreen-countdown-overlay, .ytm-autonav-endscreen { display: none !important; }";
    if (style.textContent !== css) style.textContent = css;
    if (s.hide_shorts && /^\\/shorts(\\/|$)/.test(location.pathname)) {
      var id = /^\\/shorts\\/([A-Za-z0-9_-]{11})/.exec(location.pathname);
      location.replace(id ? "/watch?v=" + id[1] : "/");
      return;
    }
    var videoPage = location.pathname === "/watch";
    if (!s.autoplay_next && videoPage && window.__guardianLastHref && window.__guardianLastHref !== location.href && lastVideoPage && endedAt && Date.now() - endedAt < 20000 && touchedAt < endedAt) {
      endedAt = 0;
      document.querySelectorAll("video").forEach(function (video) { video.pause(); });
      history.back();
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "autoplay-stopped" }));
    }
    lastVideoPage = videoPage;
    window.__guardianLastHref = location.href;
  }
  setInterval(apply, 300);
  apply();
})();
true;
`;

function settingsScript(settings: DeviceVideoSettings | undefined) {
  if (!settings) return "true;";
  const value = JSON.stringify({ hide_shorts: settings.hide_shorts, hide_comments: settings.hide_comments, autoplay_next: settings.autoplay_next });
  return `window.__guardianSettings = ${value}; true;`;
}

type Sos = { status: "sending" } | { status: "sent"; requestId: string } | { status: "failed" };

type Gate =
  | { videoId: string; status: "checking" }
  | { videoId: string; status: "review" | "blocked" | "approved"; check: VideoCheck }
  | { videoId: string; status: "unavailable" };

export default function ChildYouTubeRoute() {
  const router = useRouter();
  const webView = useRef<WebView>(null);
  const [familyId, setFamilyId] = useState<string>();
  const [gate, setGate] = useState<Gate | null>(null);
  const allowed = useRef(new Set<string>());
  const canGoBack = useRef(false);
  const currentVideo = useRef<string | null>(null);
  const [sos, setSos] = useState<Sos | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const settings = useQuery({ queryKey: ["device-video-settings"], queryFn: () => api.deviceVideoSettings(), refetchInterval: 30_000 });
  const settingsJs = settingsScript(settings.data);
  useEffect(() => {
    webView.current?.injectJavaScript(settingsJs);
  }, [settingsJs]);

  useEffect(() => {
    void sessionStorage.getFamilyId().then((value) => setFamilyId(value ?? undefined)).catch(() => undefined);
  }, []);
  useFamilySync(familyId, "child");

  const hold = useCallback((held: boolean, allowVideoId?: string) => {
    const allow = allowVideoId ? `(window.__guardianAllowed = window.__guardianAllowed || {})[${JSON.stringify(allowVideoId)}] = true;` : "";
    webView.current?.injectJavaScript(
      `${allow} window.__guardianHold = ${held}; ${held ? "" : 'var v = document.querySelector("video"); if (v) v.play();'} true;`,
    );
  }, []);

  const inspect = useCallback(async (videoId: string) => {
    if (allowed.current.has(videoId)) {
      setGate(null);
      hold(false, videoId);
      return;
    }
    hold(true);
    setGate({ videoId, status: "checking" });
    try {
      const check = await api.checkVideo(videoId);
      if (currentVideo.current !== videoId) return;
      if (check.verdict === "ALLOW") {
        allowed.current.add(videoId);
        setGate(null);
        hold(false, videoId);
      } else {
        setGate({ videoId, status: check.verdict === "BLOCKED" ? "blocked" : "review", check });
      }
    } catch {
      if (currentVideo.current === videoId) setGate({ videoId, status: "unavailable" });
    }
  }, [hold]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let message: { type?: string; href?: string };
    try {
      message = JSON.parse(event.nativeEvent.data) as { type?: string; href?: string };
    } catch {
      return;
    }
    if (message.type === "autoplay-stopped") {
      setNotice("Autoplay is off. Pick your next video yourself.");
      return;
    }
    if (message.type !== "url" || !message.href) return;
    const videoId = videoIdFromUrl(message.href);
    if (videoId === currentVideo.current) {
      if (videoId && allowed.current.has(videoId)) hold(false, videoId);
      return;
    }
    currentVideo.current = videoId;
    if (videoId) void inspect(videoId);
    else {
      hold(false);
      setGate(null);
    }
  }, [hold, inspect]);

  const requestId = gate?.status === "review" ? gate.check.request_id : null;
  const decision = useQuery({
    queryKey: ["device-request", requestId],
    queryFn: () => api.deviceRequest(requestId as string),
    enabled: Boolean(requestId),
    refetchInterval: 2_000,
  });

  useEffect(() => {
    if (!gate || gate.status !== "review" || !decision.data) return;
    if (decision.data.state === "APPROVED") {
      allowed.current.add(gate.videoId);
      setGate({ ...gate, status: "approved" });
    } else if (decision.data.state === "DENIED") {
      setGate({ ...gate, status: "blocked" });
    } else if (decision.data.state === "EXPIRED" || decision.data.state === "CANCELLED") {
      setGate({ ...gate, status: "blocked" });
    }
  }, [decision.data, gate]);

  const leaveVideo = () => {
    currentVideo.current = null;
    setGate(null);
    if (webView.current) {
      webView.current.goBack();
    }
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack.current) return false;
      webView.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, []);

  const sosRequestId = sos?.status === "sent" ? sos.requestId : null;
  const sosState = useQuery({
    queryKey: ["device-request", sosRequestId],
    queryFn: () => api.deviceRequest(sosRequestId as string),
    enabled: Boolean(sosRequestId),
    refetchInterval: 3_000,
  });
  const sendSos = async () => {
    hold(true);
    setSos({ status: "sending" });
    try {
      const sent = await api.sendSos("SCARY_CONTENT", currentVideo.current);
      setSos({ status: "sent", requestId: sent.id });
    } catch {
      setSos({ status: "failed" });
    }
  };
  const open = (url: string) => {
    setNotice(null);
    webView.current?.injectJavaScript(`location.href = ${JSON.stringify(url)}; true;`);
  };
  const learn = settings.data;

  const check = gate && "check" in gate ? gate.check : null;
  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          <Text style={styles.brand}>Guardian · YouTube</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="I saw something scary" onPress={() => void sendSos()} style={styles.sos}>
            <Text style={styles.sosText}>I saw something scary</Text>
          </Pressable>
        </View>
        {learn ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Text style={styles.chipsLabel}>Watch & learn</Text>
            {learn.picks.map((pick) => (
              <Pressable key={pick.video_id} accessibilityRole="button" accessibilityLabel={`Parent pick: ${pick.title ?? pick.video_id}`} onPress={() => open(`https://m.youtube.com/watch?v=${pick.video_id}`)} style={[styles.chip, styles.pick]}>
                <Text style={styles.chipText} numberOfLines={1}>★ {pick.title ?? "Parent pick"}</Text>
              </Pressable>
            ))}
            {learn.learning_topics.map((topic) => (
              <Pressable key={topic.label} accessibilityRole="button" accessibilityLabel={`Learn: ${topic.label}`} onPress={() => open(`https://m.youtube.com/results?search_query=${encodeURIComponent(topic.keywords)}`)} style={styles.chip}>
                <Text style={styles.chipText} numberOfLines={1}>{topic.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <SecondaryButton label="Back to My time" onPress={() => router.back()} />
      </View>
      <WebView
        ref={webView}
        source={{ uri: YOUTUBE_HOME }}
        injectedJavaScript={WATCH_SCRIPT}
        onMessage={onMessage}
        injectedJavaScriptBeforeContentLoaded={settingsJs + PLAY_GATE_SCRIPT + RESTRICT_SCRIPT}
        onLoadEnd={() => webView.current?.injectJavaScript(settingsJs + PLAY_GATE_SCRIPT + RESTRICT_SCRIPT + WATCH_SCRIPT)}
        onNavigationStateChange={(state) => { canGoBack.current = state.canGoBack; }}
        onShouldStartLoadWithRequest={(request) => isAllowedYouTubeNavigation(request.url)}
        onOpenWindow={() => undefined}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        style={styles.web}
      />
      {gate ? (
        <View style={styles.overlay} accessibilityLiveRegion="polite">
          <View style={styles.card}>
            <Image source={{ uri: `https://i.ytimg.com/vi/${gate.videoId}/hqdefault.jpg` }} style={styles.thumb} />
            {check?.title ? <Text style={styles.title}>{check.title}</Text> : null}
            {check?.channel ? <Text style={styles.meta}>{check.channel}</Text> : null}
            {gate.status === "checking" ? <Text style={styles.body}>Checking this video against your family's rules…</Text> : null}
            {gate.status === "review" ? (
              <>
                <Text style={styles.badge}>{check?.topic ?? "Needs a parent's OK"}</Text>
                <Text style={styles.body}>This video needs a parent's OK. We've sent it to your parent — waiting for their answer…</Text>
                <SecondaryButton label="Watch something else" onPress={leaveVideo} />
              </>
            ) : null}
            {gate.status === "approved" ? (
              <>
                <Text style={styles.ok}>Your parent approved this video.</Text>
                <PrimaryButton label="Watch now" onPress={() => { setGate(null); hold(false, gate.videoId); }} />
              </>
            ) : null}
            {gate.status === "blocked" ? (
              <>
                <Text style={styles.blocked}>Your parent blocked this video.</Text>
                <PrimaryButton label="Watch something else" onPress={leaveVideo} />
              </>
            ) : null}
            {gate.status === "unavailable" ? (
              <>
                <Text style={styles.body}>Guardian couldn't check this video. It stays paused until your connection returns.</Text>
                <PrimaryButton label="Try again" onPress={() => void inspect(gate.videoId)} />
                <SecondaryButton label="Watch something else" onPress={leaveVideo} />
              </>
            ) : null}
          </View>
        </View>
      ) : null}
      {sos ? (
        <View style={styles.overlay} accessibilityLiveRegion="assertive">
          <View style={styles.card}>
            {sos.status === "sending" ? <Text style={styles.title}>Telling your parent…</Text> : null}
            {sos.status === "sent" ? (
              <>
                <Text style={styles.title}>You did the right thing.</Text>
                <Text style={styles.body}>
                  {sosState.data?.state === "APPROVED"
                    ? `Your parent saw your message${sosState.data.decision_reason ? `: “${sosState.data.decision_reason}”` : "."}`
                    : "We told your parent you saw something scary. The video is paused."}
                </Text>
              </>
            ) : null}
            {sos.status === "failed" ? (
              <Text style={styles.body}>Guardian couldn't reach your parent right now. Please go and find a grown-up nearby.</Text>
            ) : null}
            {sos.status === "failed" ? <PrimaryButton label="Try again" onPress={() => void sendSos()} /> : null}
            <PrimaryButton label="Leave this video" onPress={() => { setSos(null); leaveVideo(); }} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b1530" },
  toolbar: { paddingTop: 40, paddingHorizontal: 12, paddingBottom: 6, gap: 6 },
  toolbarRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  brand: { color: "white", fontSize: 18, fontWeight: "700" },
  sos: { backgroundColor: "#d92d20", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  sosText: { color: "white", fontWeight: "800", fontSize: 14 },
  chips: { gap: 8, alignItems: "center", paddingVertical: 2 },
  chipsLabel: { color: "#9fb3ff", fontWeight: "700", fontSize: 13 },
  chip: { backgroundColor: "#1d2b55", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, maxWidth: 220 },
  pick: { backgroundColor: "#2b4fd6" },
  chipText: { color: "white", fontSize: 13, fontWeight: "600" },
  notice: { color: "#fedf89", fontSize: 13 },
  web: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(11,21,48,0.92)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: "white", borderRadius: 16, padding: 16, gap: 10 },
  thumb: { width: "100%", aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: "#dde3f0" },
  title: { fontSize: 17, fontWeight: "700", color: "#0b1530" },
  meta: { fontSize: 14, color: "#55607a" },
  badge: { alignSelf: "flex-start", backgroundColor: "#fde8e8", color: "#b42318", fontWeight: "700", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  body: { fontSize: 15, color: "#24304d" },
  ok: { fontSize: 16, fontWeight: "700", color: "#067647" },
  blocked: { fontSize: 16, fontWeight: "700", color: "#b42318" },
});
