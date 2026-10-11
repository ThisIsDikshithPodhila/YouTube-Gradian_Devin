import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Image, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { api, sessionStorage, type VideoCheck } from "@/api/client";
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

  const check = gate && "check" in gate ? gate.check : null;
  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.brand}>Guardian · YouTube</Text>
        <SecondaryButton label="Back to My time" onPress={() => router.back()} />
      </View>
      <WebView
        ref={webView}
        source={{ uri: YOUTUBE_HOME }}
        injectedJavaScript={WATCH_SCRIPT}
        onMessage={onMessage}
        injectedJavaScriptBeforeContentLoaded={PLAY_GATE_SCRIPT}
        onLoadEnd={() => webView.current?.injectJavaScript(PLAY_GATE_SCRIPT + WATCH_SCRIPT)}
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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b1530" },
  toolbar: { paddingTop: 40, paddingHorizontal: 12, paddingBottom: 6, gap: 6 },
  brand: { color: "white", fontSize: 18, fontWeight: "700" },
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
