import { isAllowedYouTubeNavigation, videoIdFromUrl } from "./youtube-video";

describe("videoIdFromUrl", () => {
  it("reads watch, shorts and short-link URLs", () => {
    expect(videoIdFromUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=abc")).toBe("dQw4w9WgXcQ");
    expect(videoIdFromUrl("https://www.youtube.com/shorts/abcdefghijk")).toBe("abcdefghijk");
    expect(videoIdFromUrl("https://youtu.be/abcdefghijk")).toBe("abcdefghijk");
  });

  it("ignores non-video YouTube pages and other hosts", () => {
    expect(videoIdFromUrl("https://m.youtube.com/results?search_query=cats")).toBeNull();
    expect(videoIdFromUrl("https://example.com/watch?v=abcdefghijk")).toBeNull();
    expect(videoIdFromUrl("not a url")).toBeNull();
  });
});

describe("isAllowedYouTubeNavigation", () => {
  it("keeps navigation inside YouTube and Google sign-in", () => {
    expect(isAllowedYouTubeNavigation("https://m.youtube.com/results?search_query=cats")).toBe(true);
    expect(isAllowedYouTubeNavigation("https://youtu.be/abcdefghijk")).toBe(true);
    expect(isAllowedYouTubeNavigation("https://accounts.google.com/ServiceLogin")).toBe(true);
    expect(isAllowedYouTubeNavigation("about:blank")).toBe(true);
  });

  it("blocks app links, advertisers and look-alike hosts", () => {
    expect(isAllowedYouTubeNavigation("intent://watch?v=abcdefghijk#Intent;package=com.google.android.youtube;end")).toBe(false);
    expect(isAllowedYouTubeNavigation("vnd.youtube:abcdefghijk")).toBe(false);
    expect(isAllowedYouTubeNavigation("https://www.audiusa.com/")).toBe(false);
    expect(isAllowedYouTubeNavigation("https://www.google.com/search?q=x")).toBe(false);
    expect(isAllowedYouTubeNavigation("https://notyoutube.com/")).toBe(false);
  });
});
