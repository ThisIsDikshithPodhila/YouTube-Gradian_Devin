import { videoIdFromUrl } from "./youtube-video";

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
