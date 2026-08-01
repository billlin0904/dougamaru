const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

export function isYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && YOUTUBE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function getYouTubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    if (!YOUTUBE_HOSTS.has(url.hostname)) {
      return null;
    }

    if (url.hostname === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    const queryId = url.searchParams.get("v");
    if (queryId) {
      return queryId;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (["shorts", "live", "embed"].includes(segments[0] ?? "")) {
      return segments[1] ?? null;
    }

    return null;
  } catch {
    return null;
  }
}
