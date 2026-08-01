import type { CaptionState, ContentRequest, ContentResponse } from "./messages";
import { getYouTubeVideoId } from "./youtube";

interface SubtitleCue {
  endMs: number;
  startMs: number;
  text: string;
}

interface StoredCaption {
  sourceUrl: string;
  srt: string;
}

const STORAGE_PREFIX = "puretext-youtube-caption:";
const VISIBILITY_STORAGE_KEY = "puretext-caption-visible";
const OVERLAY_ID = "puretext-caption-overlay";
const INLINE_PANEL_ID = "puretext-inline-panel";

let cues: SubtitleCue[] = [];
let rawSrt = "";
let sourceUrl = "";
let activeVideo: HTMLVideoElement | null = null;
let overlayHost: HTMLDivElement | null = null;
let captionElement: HTMLDivElement | null = null;
let captionTextElement: HTMLDivElement | null = null;
let lastVideoId: string | null = null;
let animationFrameId: number | null = null;
let videoFrameRequestId: number | null = null;
let captionsVisible = true;

chrome.runtime.onMessage.addListener(
  (
    message: ContentRequest,
    _sender,
    sendResponse: (response: ContentResponse) => void,
  ) => {
    if (!message?.type) {
      return false;
    }

    void handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "字幕操作失敗。",
        });
      });

    return true;
  },
);

void initialize().catch(handleAsyncError);

async function initialize(): Promise<void> {
  lastVideoId = getYouTubeVideoId(location.href);
  await loadCaptionVisibility();
  await loadCurrentVideo();
  ensureVideoAndOverlay();

  document.addEventListener("yt-navigate-finish", () => {
    void handleNavigation().catch(handleAsyncError);
  });

  const observer = new MutationObserver(() => ensureVideoAndOverlay());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.setInterval(() => {
    const currentVideoId = getYouTubeVideoId(location.href);
    if (currentVideoId !== lastVideoId) {
      void handleNavigation().catch(handleAsyncError);
    } else {
      ensureVideoAndOverlay();
    }
  }, 1000);
}

async function handleNavigation(): Promise<void> {
  const currentVideoId = getYouTubeVideoId(location.href);
  if (currentVideoId === lastVideoId) {
    ensureVideoAndOverlay();
    return;
  }

  lastVideoId = currentVideoId;
  cues = [];
  rawSrt = "";
  sourceUrl = "";
  renderCaption();
  await loadCurrentVideo();
  ensureVideoAndOverlay();
}

async function handleMessage(
  message: ContentRequest,
): Promise<ContentResponse> {
  switch (message.type) {
    case "GET_CAPTION_STATE":
      return successState();

    case "GET_CAPTION_CONTENT":
      return {
        ...successState(),
        sourceUrl,
        srt: rawSrt,
      };

    case "TOGGLE_CAPTION_VISIBILITY":
      captionsVisible = !captionsVisible;
      await safeStorageSet({
        [VISIBILITY_STORAGE_KEY]: captionsVisible,
      });
      renderCaption();
      return successState();

    case "SET_CAPTIONS": {
      const requestedVideoId = getYouTubeVideoId(message.sourceUrl);
      const currentVideoId = getYouTubeVideoId(location.href);
      if (!requestedVideoId || requestedVideoId !== currentVideoId) {
        throw new Error("轉錄期間影片已切換，請在目前影片重新產生字幕。");
      }

      const parsedCues = parseSrt(message.srt);
      if (parsedCues.length === 0) {
        throw new Error("字幕內容中找不到有效的 SRT 時間軸。");
      }

      cues = parsedCues;
      rawSrt = message.srt;
      sourceUrl = message.sourceUrl;
      await persistCurrentVideo();
      ensureVideoAndOverlay();
      renderCaption();
      return successState();
    }

    case "TOGGLE_INLINE_PANEL":
      toggleInlinePanel();
      return successState();

    case "CLOSE_INLINE_PANEL":
      closeInlinePanel();
      return successState();
  }
}

function successState(): Extract<ContentResponse, { ok: true }> {
  return {
    ok: true,
    ...getCaptionState(),
  };
}

function getCaptionState(): CaptionState {
  return {
    cueCount: cues.length,
    hasCaptions: cues.length > 0,
    isVisible: captionsVisible,
  };
}

async function loadCaptionVisibility(): Promise<void> {
  const stored = await safeStorageGet(VISIBILITY_STORAGE_KEY);
  captionsVisible = stored?.[VISIBILITY_STORAGE_KEY] !== false;
}

async function loadCurrentVideo(): Promise<void> {
  const storageKey = getStorageKey();
  if (!storageKey) {
    return;
  }

  const stored = await safeStorageGet(storageKey);
  if (!stored) {
    return;
  }

  const caption = stored[storageKey] as StoredCaption | undefined;
  if (!caption?.srt) {
    return;
  }

  const parsedCues = parseSrt(caption.srt);
  if (parsedCues.length === 0) {
    await safeStorageRemove(storageKey);
    return;
  }

  cues = parsedCues;
  rawSrt = caption.srt;
  sourceUrl = caption.sourceUrl;
  renderCaption();
}

async function persistCurrentVideo(): Promise<void> {
  const storageKey = getStorageKey();
  if (!storageKey || !rawSrt) {
    return;
  }

  const value: StoredCaption = {
    sourceUrl,
    srt: rawSrt,
  };
  await safeStorageSet({ [storageKey]: value });
}

function getStorageKey(): string | null {
  const videoId = getYouTubeVideoId(location.href);
  return videoId ? `${STORAGE_PREFIX}${videoId}` : null;
}

function toggleInlinePanel(): void {
  const existingPanel = document.getElementById(INLINE_PANEL_ID);
  if (existingPanel) {
    existingPanel.remove();
    return;
  }

  const panelUrl = getExtensionUrl("sidepanel.html");
  if (!panelUrl) {
    return;
  }

  const host = document.createElement("div");
  host.id = INLINE_PANEL_ID;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-label", "PureText YouTube 字幕");

  const shadowRoot = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      top: 76px;
      right: 18px;
      z-index: 2147483646;
      width: min(380px, calc(100vw - 36px));
      height: min(510px, calc(100vh - 94px));
      border: 1px solid rgb(82 82 91 / 90%);
      border-radius: 16px;
      overflow: hidden;
      background: #09090b;
      box-shadow:
        0 24px 70px rgb(0 0 0 / 48%),
        0 4px 18px rgb(0 0 0 / 30%);
    }

    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #09090b;
    }

    @media (max-width: 600px) {
      :host {
        top: 64px;
        right: 8px;
        width: calc(100vw - 16px);
        height: min(510px, calc(100vh - 72px));
      }
    }
  `;

  const frame = document.createElement("iframe");
  frame.src = panelUrl;
  frame.title = "PureText YouTube 字幕";
  frame.setAttribute("allow", "clipboard-write");

  shadowRoot.append(style, frame);
  document.documentElement.append(host);
}

function closeInlinePanel(): void {
  document.getElementById(INLINE_PANEL_ID)?.remove();
}

function ensureVideoAndOverlay(): void {
  const video = document.querySelector<HTMLVideoElement>(
    ".html5-video-player video, video.html5-main-video",
  );
  const player = document.querySelector<HTMLElement>(".html5-video-player");

  if (!video || !player) {
    return;
  }

  if (activeVideo !== video) {
    detachVideoListeners();
    activeVideo = video;
    activeVideo.addEventListener("timeupdate", renderCaption);
    activeVideo.addEventListener("seeking", renderCaption);
    activeVideo.addEventListener("seeked", renderCaption);
    activeVideo.addEventListener("loadedmetadata", renderCaption);
    startRenderLoop();
  }

  if (!overlayHost || !overlayHost.isConnected) {
    overlayHost = document.createElement("div");
    overlayHost.id = OVERLAY_ID;
    overlayHost.style.cssText = [
      "position:absolute",
      "left:5%",
      "right:5%",
      "bottom:12%",
      "z-index:60",
      "display:flex",
      "justify-content:center",
      "pointer-events:none",
      "text-align:center",
    ].join(";");

    const shadowRoot = overlayHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .caption {
        display: none;
        flex-direction: column;
        gap: 0.08em;
        max-width: min(92%, 1100px);
        padding: 0.18em 0.42em 0.24em;
        border-radius: 0.22em;
        color: #fff;
        background: rgb(0 0 0 / 78%);
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        font-family: "Noto Sans TC", "Microsoft JhengHei", Arial, sans-serif;
        font-size: clamp(18px, 3.1vw, 44px);
        font-weight: 700;
        line-height: 1.34;
        letter-spacing: 0.01em;
        text-shadow: 0 2px 3px rgb(0 0 0 / 90%);
        white-space: pre-line;
      }

      .caption-line {
        white-space: pre-line;
      }

    `;
    captionElement = document.createElement("div");
    captionElement.className = "caption";
    captionElement.setAttribute("aria-live", "off");
    captionTextElement = document.createElement("div");
    captionTextElement.className = "caption-line";
    captionElement.append(captionTextElement);
    shadowRoot.append(style, captionElement);
    player.append(overlayHost);
  } else if (overlayHost.parentElement !== player) {
    player.append(overlayHost);
  }

  renderCaption();
}

function detachVideoListeners(): void {
  if (!activeVideo) {
    return;
  }
  activeVideo.removeEventListener("timeupdate", renderCaption);
  activeVideo.removeEventListener("seeking", renderCaption);
  activeVideo.removeEventListener("seeked", renderCaption);
  activeVideo.removeEventListener("loadedmetadata", renderCaption);
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (videoFrameRequestId !== null) {
    activeVideo.cancelVideoFrameCallback(videoFrameRequestId);
    videoFrameRequestId = null;
  }
}

function startRenderLoop(): void {
  const videoForLoop = activeVideo;

  const tick = (): void => {
    if (!videoForLoop || activeVideo !== videoForLoop) {
      return;
    }
    renderCaption();

    if ("requestVideoFrameCallback" in videoForLoop) {
      videoFrameRequestId = videoForLoop.requestVideoFrameCallback(tick);
    } else {
      animationFrameId = requestAnimationFrame(tick);
    }
  };

  tick();
}

function renderCaption(): void {
  if (!captionElement || !captionTextElement || !activeVideo) {
    return;
  }

  const player = activeVideo.closest(".html5-video-player");
  const isAdPlaying = player?.classList.contains("ad-showing") ?? false;
  if (!captionsVisible || cues.length === 0 || isAdPlaying) {
    captionElement.style.display = "none";
    captionTextElement.textContent = "";
    return;
  }

  const playbackMs = activeVideo.currentTime * 1000;
  const cue = findCue(cues, playbackMs);
  if (!cue) {
    captionElement.style.display = "none";
    captionTextElement.textContent = "";
    return;
  }

  if (captionTextElement.textContent !== cue.text) {
    captionTextElement.textContent = cue.text;
  }

  captionElement.style.display = "inline-flex";
}

function findCue(cueList: SubtitleCue[], timeMs: number): SubtitleCue | null {
  let low = 0;
  let high = cueList.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cueList[middle];
    if (!cue) {
      return null;
    }

    if (timeMs < cue.startMs) {
      high = middle - 1;
    } else if (timeMs > cue.endMs) {
      low = middle + 1;
    } else {
      return cue;
    }
  }

  return null;
}

function parseSrt(srt: string): SubtitleCue[] {
  return srt
    .replace(/^\uFEFF/, "")
    .replace(/^WEBVTT[^\n]*\n+/i, "")
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) {
        return null;
      }

      const match = lines[timingIndex]?.match(
        /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/,
      );
      if (!match) {
        return null;
      }

      const text = lines
        .slice(timingIndex + 1)
        .join("\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\\N/g, "\n")
        .trim();
      if (!text) {
        return null;
      }

      return {
        startMs: timestampToMs(match.slice(1, 5)),
        endMs: timestampToMs(match.slice(5, 9)),
        text,
      };
    })
    .filter((cue): cue is SubtitleCue => cue !== null)
    .sort((first, second) => first.startMs - second.startMs);
}

function timestampToMs(parts: string[]): number {
  const [hours = "0", minutes = "0", seconds = "0", milliseconds = "0"] = parts;
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    Number(milliseconds)
  );
}

async function safeStorageGet(
  key: string,
): Promise<Record<string, unknown> | null> {
  if (!isExtensionContextValid()) {
    return null;
  }

  try {
    return await chrome.storage.local.get(key);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      return null;
    }
    throw error;
  }
}

async function safeStorageSet(items: Record<string, unknown>): Promise<void> {
  if (!isExtensionContextValid()) {
    return;
  }

  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    if (!isExtensionContextInvalidated(error)) {
      throw error;
    }
  }
}

async function safeStorageRemove(key: string): Promise<void> {
  if (!isExtensionContextValid()) {
    return;
  }

  try {
    await chrome.storage.local.remove(key);
  } catch (error) {
    if (!isExtensionContextInvalidated(error)) {
      throw error;
    }
  }
}

function getExtensionUrl(path: string): string | null {
  if (!isExtensionContextValid()) {
    return null;
  }

  try {
    return chrome.runtime.getURL(path);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      return null;
    }
    throw error;
  }
}

function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function isExtensionContextInvalidated(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("extension context invalidated")
  );
}

function handleAsyncError(error: unknown): void {
  if (!isExtensionContextInvalidated(error)) {
    console.error("[PureText captions]", error);
  }
}
