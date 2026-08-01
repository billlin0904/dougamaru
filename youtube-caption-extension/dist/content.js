"use strict";
(() => {
  // src/youtube.ts
  var YOUTUBE_HOSTS = /* @__PURE__ */ new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be"
  ]);
  function getYouTubeVideoId(value) {
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

  // src/content.ts
  var STORAGE_PREFIX = "puretext-youtube-caption:";
  var VISIBILITY_STORAGE_KEY = "puretext-caption-visible";
  var OVERLAY_ID = "puretext-caption-overlay";
  var INLINE_PANEL_ID = "puretext-inline-panel";
  var cues = [];
  var rawSrt = "";
  var sourceUrl = "";
  var activeVideo = null;
  var overlayHost = null;
  var captionElement = null;
  var captionTextElement = null;
  var lastVideoId = null;
  var animationFrameId = null;
  var videoFrameRequestId = null;
  var captionsVisible = true;
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (!message?.type) {
        return false;
      }
      void handleMessage(message).then(sendResponse).catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "\u5B57\u5E55\u64CD\u4F5C\u5931\u6557\u3002"
        });
      });
      return true;
    }
  );
  void initialize().catch(handleAsyncError);
  async function initialize() {
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
      subtree: true
    });
    window.setInterval(() => {
      const currentVideoId = getYouTubeVideoId(location.href);
      if (currentVideoId !== lastVideoId) {
        void handleNavigation().catch(handleAsyncError);
      } else {
        ensureVideoAndOverlay();
      }
    }, 1e3);
  }
  async function handleNavigation() {
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
  async function handleMessage(message) {
    switch (message.type) {
      case "GET_CAPTION_STATE":
        return successState();
      case "GET_CAPTION_CONTENT":
        return {
          ...successState(),
          sourceUrl,
          srt: rawSrt
        };
      case "TOGGLE_CAPTION_VISIBILITY":
        captionsVisible = !captionsVisible;
        await safeStorageSet({
          [VISIBILITY_STORAGE_KEY]: captionsVisible
        });
        renderCaption();
        return successState();
      case "SET_CAPTIONS": {
        const requestedVideoId = getYouTubeVideoId(message.sourceUrl);
        const currentVideoId = getYouTubeVideoId(location.href);
        if (!requestedVideoId || requestedVideoId !== currentVideoId) {
          throw new Error("\u8F49\u9304\u671F\u9593\u5F71\u7247\u5DF2\u5207\u63DB\uFF0C\u8ACB\u5728\u76EE\u524D\u5F71\u7247\u91CD\u65B0\u7522\u751F\u5B57\u5E55\u3002");
        }
        const parsedCues = parseSrt(message.srt);
        if (parsedCues.length === 0) {
          throw new Error("\u5B57\u5E55\u5167\u5BB9\u4E2D\u627E\u4E0D\u5230\u6709\u6548\u7684 SRT \u6642\u9593\u8EF8\u3002");
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
  function successState() {
    return {
      ok: true,
      ...getCaptionState()
    };
  }
  function getCaptionState() {
    return {
      cueCount: cues.length,
      hasCaptions: cues.length > 0,
      isVisible: captionsVisible
    };
  }
  async function loadCaptionVisibility() {
    const stored = await safeStorageGet(VISIBILITY_STORAGE_KEY);
    captionsVisible = stored?.[VISIBILITY_STORAGE_KEY] !== false;
  }
  async function loadCurrentVideo() {
    const storageKey = getStorageKey();
    if (!storageKey) {
      return;
    }
    const stored = await safeStorageGet(storageKey);
    if (!stored) {
      return;
    }
    const caption = stored[storageKey];
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
  async function persistCurrentVideo() {
    const storageKey = getStorageKey();
    if (!storageKey || !rawSrt) {
      return;
    }
    const value = {
      sourceUrl,
      srt: rawSrt
    };
    await safeStorageSet({ [storageKey]: value });
  }
  function getStorageKey() {
    const videoId = getYouTubeVideoId(location.href);
    return videoId ? `${STORAGE_PREFIX}${videoId}` : null;
  }
  function toggleInlinePanel() {
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
    host.setAttribute("aria-label", "PureText YouTube \u5B57\u5E55");
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
    frame.title = "PureText YouTube \u5B57\u5E55";
    frame.setAttribute("allow", "clipboard-write");
    shadowRoot.append(style, frame);
    document.documentElement.append(host);
  }
  function closeInlinePanel() {
    document.getElementById(INLINE_PANEL_ID)?.remove();
  }
  function ensureVideoAndOverlay() {
    const video = document.querySelector(
      ".html5-video-player video, video.html5-main-video"
    );
    const player = document.querySelector(".html5-video-player");
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
        "text-align:center"
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
  function detachVideoListeners() {
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
  function startRenderLoop() {
    const videoForLoop = activeVideo;
    const tick = () => {
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
  function renderCaption() {
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
    const playbackMs = activeVideo.currentTime * 1e3;
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
  function findCue(cueList, timeMs) {
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
  function parseSrt(srt) {
    return srt.replace(/^\uFEFF/, "").replace(/^WEBVTT[^\n]*\n+/i, "").split(/\r?\n\s*\r?\n/).map((block) => {
      const lines = block.split(/\r?\n/);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) {
        return null;
      }
      const match = lines[timingIndex]?.match(
        /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/
      );
      if (!match) {
        return null;
      }
      const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").replace(/\\N/g, "\n").trim();
      if (!text) {
        return null;
      }
      return {
        startMs: timestampToMs(match.slice(1, 5)),
        endMs: timestampToMs(match.slice(5, 9)),
        text
      };
    }).filter((cue) => cue !== null).sort((first, second) => first.startMs - second.startMs);
  }
  function timestampToMs(parts) {
    const [hours = "0", minutes = "0", seconds = "0", milliseconds = "0"] = parts;
    return Number(hours) * 36e5 + Number(minutes) * 6e4 + Number(seconds) * 1e3 + Number(milliseconds);
  }
  async function safeStorageGet(key) {
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
  async function safeStorageSet(items) {
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
  async function safeStorageRemove(key) {
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
  function getExtensionUrl(path) {
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
  function isExtensionContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }
  function isExtensionContextInvalidated(error) {
    return error instanceof Error && error.message.toLowerCase().includes("extension context invalidated");
  }
  function handleAsyncError(error) {
    if (!isExtensionContextInvalidated(error)) {
      console.error("[PureText captions]", error);
    }
  }
})();
//# sourceMappingURL=content.js.map
