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

const NAVIGABLE_HOSTS = ["youtube.com", "youtu.be", "accounts.google.com", "consent.google.com"];

export function isAllowedYouTubeNavigation(href: string): boolean {
  if (href.startsWith("about:") || href.startsWith("data:") || href.startsWith("blob:")) return true;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return NAVIGABLE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
