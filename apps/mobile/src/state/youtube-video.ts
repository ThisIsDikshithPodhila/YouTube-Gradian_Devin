const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function videoIdFromUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be") return matchId(url.pathname.slice(1));
  if (host !== "youtube.com") return null;
  if (url.pathname === "/watch") return matchId(url.searchParams.get("v"));
  const shorts = /^\/(shorts|embed|live)\/([^/?#]+)/.exec(url.pathname);
  return shorts ? matchId(shorts[2]) : null;
}

function matchId(value: string | null | undefined): string | null {
  return value && VIDEO_ID.test(value) ? value : null;
}
