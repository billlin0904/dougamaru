"use strict";
(() => {
  // src/youtube.ts
  var YOUTUBE_HOSTS = /* @__PURE__ */ new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be"
  ]);
  function isYouTubeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && YOUTUBE_HOSTS.has(url.hostname);
    } catch {
      return false;
    }
  }
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

  // src/audio-io.ts
  var QUEUE_ORIGIN = "https://gpuiapi.audio-io.com";
  var QUEUE_ENDPOINT = `${QUEUE_ORIGIN}/api/youtube-live/jobs`;
  async function transcribeYouTube(url, options) {
    if (!isYouTubeUrl(url)) {
      throw new Error("\u8ACB\u8F38\u5165\u6709\u6548\u7684 YouTube \u5F71\u7247\u7DB2\u5740\u3002");
    }
    return transcribeWithQueue(url, options.ignoreSubtitles, options.onProgress);
  }
  async function transcribeWithQueue(url, ignoreSubtitles, onProgress) {
    onProgress?.(createProgress("creating", "\u6B63\u5728\u5EFA\u7ACB\u5F71\u7247\u8F49\u8B6F\u5DE5\u4F5C\u2026", 0));
    const response = await fetch(QUEUE_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        language: "",
        captcha_token: "",
        ignore_subtitles: ignoreSubtitles
      })
    });
    const rawBody = await response.text();
    const payload = parseJsonIfPossible(rawBody);
    if (!response.ok) {
      throw new Error(extractApiError(payload, response.status));
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Audio-IO \u6C92\u6709\u56DE\u50B3\u6709\u6548\u7684\u4F47\u5217\u5DE5\u4F5C\u3002");
    }
    const job = payload;
    const jobId = typeof job["job_id"] === "string" ? job["job_id"] : "";
    const rawEventsUrl = typeof job["events_url"] === "string" ? job["events_url"] : jobId ? `/api/youtube-live/jobs/${encodeURIComponent(jobId)}/events` : "";
    if (!rawEventsUrl) {
      throw new Error("Audio-IO \u6C92\u6709\u56DE\u50B3\u8F49\u9304\u9032\u5EA6\u7DB2\u5740\u3002");
    }
    const eventsUrl = new URL(rawEventsUrl, QUEUE_ORIGIN);
    if (eventsUrl.origin !== QUEUE_ORIGIN) {
      throw new Error("Audio-IO \u56DE\u50B3\u4E86\u4E0D\u5B89\u5168\u7684\u8F49\u9304\u9032\u5EA6\u7DB2\u5740\u3002");
    }
    onProgress?.(
      createProgress("queued", "\u5DE5\u4F5C\u5DF2\u6392\u5165\u4F47\u5217\uFF0C\u7B49\u5F85 Audio-IO \u8655\u7406\u2026", 0)
    );
    return readQueueEvents(eventsUrl.href, onProgress);
  }
  async function readQueueEvents(eventsUrl, onProgress) {
    const response = await fetch(eventsUrl, {
      headers: {
        Accept: "text/event-stream"
      }
    });
    if (!response.ok || !response.body) {
      const payload = parseJsonIfPossible(await response.text());
      throw new Error(extractApiError(payload, response.status));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const segments = [];
    let buffer = "";
    let duration = 0;
    let completed = false;
    let lastPercent = -1;
    let finalResult = null;
    try {
      while (!completed) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = findSseBoundary(buffer);
        while (boundary) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const event = parseSseEvent(block);
          if (event) {
            switch (event.event) {
              case "status": {
                const data = parseJsonIfPossible(event.data);
                if (data && typeof data === "object") {
                  const message = data["message"];
                  if (typeof message === "string" && message.trim()) {
                    onProgress?.(
                      createProgress(
                        "queued",
                        message,
                        Math.max(0, lastPercent)
                      )
                    );
                  }
                }
                break;
              }
              case "metadata": {
                const data = parseJsonIfPossible(event.data);
                if (data && typeof data === "object") {
                  const rawDuration = data["duration"];
                  duration = Number(rawDuration) || 0;
                  if (duration > 0) {
                    onProgress?.(
                      createProgress(
                        "transcribing",
                        `\u958B\u59CB\u8655\u7406\u5B57\u5E55\uFF0C\u5171\u7D04 ${Math.round(duration)} \u79D2\u2026`,
                        Math.max(0, lastPercent)
                      )
                    );
                  }
                }
                break;
              }
              case "segment": {
                const segment = parseQueueSegment(event.data);
                if (segment) {
                  segments.push(segment);
                  const fallbackPercent = duration > 0 ? Math.min(
                    99,
                    Math.max(0, segment.end / duration * 100)
                  ) : null;
                  const percent = segment.progressPercent ?? fallbackPercent;
                  if (percent !== null) {
                    lastPercent = percent;
                  }
                  onProgress?.({
                    elapsedSeconds: segment.elapsedSeconds,
                    estimatedCompletionAt: segment.estimatedCompletionAt,
                    estimatedRemainingSeconds: segment.estimatedRemainingSeconds,
                    message: percent !== null ? `\u5B57\u5E55\u8655\u7406\u4E2D\u2026 ${formatPercent(percent)}%` : `\u5DF2\u5B8C\u6210 ${segments.length} \u6BB5\u5B57\u5E55\u2026`,
                    processingSpeedX: segment.processingSpeedX,
                    progressPercent: percent,
                    stage: "transcribing"
                  });
                }
                break;
              }
              case "done": {
                finalResult = extractTranscription(
                  parseJsonIfPossible(event.data)
                );
                completed = true;
                break;
              }
              case "failed": {
                const data = parseJsonIfPossible(event.data);
                const message = data && typeof data === "object" ? data["message"] : null;
                throw new Error(
                  typeof message === "string" && message.trim() ? message : "\u5F71\u7247\u8F49\u8B6F\u5931\u6557\u3002"
                );
              }
            }
          }
          boundary = findSseBoundary(buffer);
        }
        if (done && !completed) {
          throw new Error("\u5F71\u7247\u8F49\u8B6F\u9023\u7DDA\u5DF2\u4E2D\u65B7\uFF0C\u8ACB\u91CD\u65B0\u5617\u8A66\u3002");
        }
      }
    } finally {
      await reader.cancel().catch(() => void 0);
    }
    const content = buildSrt(segments) || getTimedContent(finalResult?.content);
    if (!content) {
      throw new Error("\u8F49\u8B6F\u5DF2\u5B8C\u6210\uFF0C\u4F46\u6C92\u6709\u56DE\u50B3\u4EFB\u4F55\u5B57\u5E55\u7247\u6BB5\u3002");
    }
    onProgress?.(
      createProgress("completed", "\u8F49\u8B6F\u5B8C\u6210\uFF0C\u6B63\u5728\u639B\u8F09\u5B57\u5E55\u2026", 100)
    );
    return { content };
  }
  function findSseBoundary(value) {
    const match = /\r?\n\r?\n/.exec(value);
    return match ? {
      index: match.index,
      length: match[0].length
    } : null;
  }
  function parseSseEvent(block) {
    let event = "message";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
    return data.length > 0 || event === "done" ? {
      data: data.join("\n"),
      event
    } : null;
  }
  function parseQueueSegment(value) {
    const data = parseJsonIfPossible(value);
    if (!data || typeof data !== "object") {
      return null;
    }
    const record = data;
    const text = typeof record["text"] === "string" ? record["text"].trim() : "";
    const start = Number(record["start"]) || 0;
    const parsedEnd = Number(record["end"]);
    const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + 3;
    return text ? {
      elapsedSeconds: nullableNumber(record["elapsed_seconds"]),
      end,
      estimatedCompletionAt: typeof record["estimated_completion_at"] === "string" ? record["estimated_completion_at"] : null,
      estimatedRemainingSeconds: nullableNumber(
        record["estimated_remaining_seconds"]
      ),
      processingSpeedX: nullableNumber(record["processing_speed_x"]),
      progressPercent: nullableNumber(record["progress_percent"]),
      start,
      text
    } : null;
  }
  function buildSrt(segments) {
    return [...segments].sort((first, second) => first.start - second.start).map(
      (segment, index) => `${index + 1}
${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}
${segment.text}`
    ).join("\n\n");
  }
  function getTimedContent(value) {
    const content = value?.trim();
    return content?.includes("-->") ? content : null;
  }
  function formatSrtTimestamp(seconds) {
    const millisecondsTotal = Math.max(0, Math.round(seconds * 1e3));
    const hours = Math.floor(millisecondsTotal / 36e5);
    const minutes = Math.floor(millisecondsTotal % 36e5 / 6e4);
    const wholeSeconds = Math.floor(millisecondsTotal % 6e4 / 1e3);
    const milliseconds = millisecondsTotal % 1e3;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${wholeSeconds.toString().padStart(2, "0")},${milliseconds.toString().padStart(3, "0")}`;
  }
  function parseJsonIfPossible(value) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  function extractTranscription(payload) {
    if (typeof payload === "string") {
      return { content: payload };
    }
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const record = payload;
    for (const key of ["content", "srt", "text", "result", "data"]) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        return { content: candidate };
      }
    }
    return null;
  }
  function extractApiError(payload, status) {
    if (payload && typeof payload === "object") {
      const detail = payload["detail"];
      if (typeof detail === "string") {
        return `Audio-IO\uFF1A${detail}`;
      }
      if (Array.isArray(detail)) {
        const messages = detail.map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const message = item["msg"];
          return typeof message === "string" ? message : null;
        }).filter((message) => Boolean(message));
        if (messages.length > 0) {
          return `Audio-IO\uFF1A${messages.join("\u3001")}`;
        }
      }
    }
    return `Audio-IO \u8ACB\u6C42\u5931\u6557\uFF08HTTP ${status}\uFF09\u3002`;
  }
  function createProgress(stage, message, progressPercent) {
    return {
      elapsedSeconds: null,
      estimatedCompletionAt: null,
      estimatedRemainingSeconds: null,
      message,
      processingSpeedX: null,
      progressPercent,
      stage
    };
  }
  function nullableNumber(value) {
    if (value === null || value === void 0 || value === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function formatPercent(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  }

  // src/puretext-api.ts
  var API_ORIGIN = "https://website-builder-pro--billlin0904.replit.app";
  var API_BASE = `${API_ORIGIN}/api`;
  var PURETEXT_TOKEN_KEY = "puretext-user-token";
  var PURETEXT_GOOGLE_RETURN_TAB_KEY = "puretext-google-return-tab-id";
  var PureTextApiError = class extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
      this.name = "PureTextApiError";
    }
    status;
  };
  async function login(email, password) {
    const result = await requestJson("/user/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });
    if (!result.token) {
      throw new PureTextApiError("\u767B\u5165\u6210\u529F\uFF0C\u4F46\u4F3A\u670D\u5668\u6C92\u6709\u56DE\u50B3 Token\u3002", 500);
    }
    await chrome.storage.local.set({ [PURETEXT_TOKEN_KEY]: result.token });
    try {
      const credits = await getCredits(result.token);
      return { credits, user: result.user };
    } catch (error) {
      await clearToken();
      throw error;
    }
  }
  async function restoreSession() {
    const token = await getToken();
    if (!token) {
      return null;
    }
    try {
      const [me, credits] = await Promise.all([
        requestJson(
          "/user/me",
          {
            method: "GET"
          },
          token
        ),
        getCredits(token)
      ]);
      return { credits, user: me.user };
    } catch (error) {
      if (error instanceof PureTextApiError && error.status === 401) {
        await clearToken();
        return null;
      }
      throw error;
    }
  }
  async function refreshCredits() {
    const token = await getToken();
    if (!token) {
      throw new PureTextApiError("\u8ACB\u5148\u767B\u5165 PureText\u3002", 401);
    }
    try {
      return await getCredits(token);
    } catch (error) {
      if (error instanceof PureTextApiError && error.status === 401) {
        await clearToken();
      }
      throw error;
    }
  }
  async function logout() {
    await clearToken();
  }
  async function startGoogleLogin() {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (activeTab?.id !== void 0) {
      await chrome.storage.session.set({
        [PURETEXT_GOOGLE_RETURN_TAB_KEY]: activeTab.id
      });
    }
    await chrome.tabs.create({
      url: `${API_BASE}/user/google?next=${encodeURIComponent("/")}`
    });
  }
  async function getCredits(token) {
    return requestJson(
      "/user/credits",
      {
        method: "GET"
      },
      token
    );
  }
  async function getToken() {
    const stored = await chrome.storage.local.get(PURETEXT_TOKEN_KEY);
    const token = stored[PURETEXT_TOKEN_KEY];
    return typeof token === "string" && token ? token : null;
  }
  async function clearToken() {
    await chrome.storage.local.remove(PURETEXT_TOKEN_KEY);
  }
  async function requestJson(path, init, token) {
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...init.headers,
          ...token ? { Authorization: `Bearer ${token}` } : {}
        }
      });
    } catch {
      throw new PureTextApiError("\u7121\u6CD5\u9023\u7DDA PureText API\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66\u3002", 0);
    }
    const rawBody = await response.text();
    const payload = parseJson(rawBody);
    if (!response.ok) {
      throw new PureTextApiError(
        extractError(payload) || `PureText API \u8ACB\u6C42\u5931\u6557\uFF08HTTP ${response.status}\uFF09\u3002`,
        response.status
      );
    }
    if (!payload || typeof payload !== "object") {
      throw new PureTextApiError("PureText API \u56DE\u50B3\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002", response.status);
    }
    return payload;
  }
  function parseJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  function extractError(payload) {
    if (!payload || typeof payload !== "object") {
      return typeof payload === "string" && payload.trim() ? payload : null;
    }
    const record = payload;
    for (const key of ["error", "message", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    return null;
  }

  // src/sidepanel.ts
  var urlInput = getElement("youtube-url");
  var generateButton = getElement("generate");
  var importCaptionButton = getElement("import-caption");
  var importCaptionFileInput = getElement("import-caption-file");
  var downloadCaptionButton = getElement("download-caption");
  var toggleCaptionVisibilityButton = getElement(
    "toggle-caption-visibility"
  );
  var statusElement = getElement("status");
  var closeButton = getElement("close-panel");
  var ignoreSubtitlesInput = getElement("ignore-subtitles");
  var loginButton = getElement("login-button");
  var loginPanel = getElement("login-panel");
  var loginForm = getElement("login-form");
  var loginEmailInput = getElement("login-email");
  var loginPasswordInput = getElement("login-password");
  var loginSubmitButton = getElement("login-submit");
  var googleLoginButton = getElement("google-login");
  var loginErrorElement = getElement("login-error");
  var accountCard = getElement("account-card");
  var accountNameElement = getElement("account-name");
  var accountEmailElement = getElement("account-email");
  var remainingMinutesElement = getElement("remaining-minutes");
  var progressCard = getElement("progress-card");
  var progressPercentElement = getElement("progress-percent");
  var progressTrackElement = progressCard.querySelector(".progress-track");
  var progressBarElement = getElement("progress-bar");
  var progressEtaElement = getElement("progress-eta");
  var progressRemainingElement = getElement("progress-remaining");
  var progressSpeedElement = getElement("progress-speed");
  var progressElapsedElement = getElement("progress-elapsed");
  var progressUpdatedElement = getElement("progress-updated");
  var IGNORE_SUBTITLES_KEY = "puretext-ignore-youtube-subtitles";
  var PROGRESS_STORAGE_PREFIX = "puretext-transcription-progress:";
  var completionTimeFormatter = new Intl.DateTimeFormat(void 0, {
    hour: "2-digit",
    minute: "2-digit"
  });
  var activeTabId = null;
  var activeTabUrl = "";
  var currentUser = null;
  var currentCredits = null;
  var isGenerating = false;
  var progressWriteTimer = null;
  var pendingProgressWrites = /* @__PURE__ */ new Map();
  var latestProgressByVideoId = /* @__PURE__ */ new Map();
  generateButton.addEventListener("click", () => void generateCaptions());
  importCaptionButton.addEventListener("click", () => openCaptionFilePicker());
  importCaptionFileInput.addEventListener(
    "change",
    () => void importCaptionFile()
  );
  downloadCaptionButton.addEventListener(
    "click",
    () => void downloadCurrentCaption()
  );
  toggleCaptionVisibilityButton.addEventListener(
    "click",
    () => void toggleCaptionVisibility()
  );
  closeButton.addEventListener("click", () => void closePanel());
  loginButton.addEventListener("click", () => void handleLoginButton());
  loginForm.addEventListener("submit", (event) => void submitLogin(event));
  googleLoginButton.addEventListener("click", () => void beginGoogleLogin());
  ignoreSubtitlesInput.addEventListener(
    "change",
    () => void saveIgnoreSubtitlesPreference()
  );
  chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === activeTabId && changeInfo.url) {
      void refreshActiveTab();
    }
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes[PURETEXT_TOKEN_KEY]?.newValue !== void 0) {
      void completeExternalLogin();
    }
    const activeVideoId = getYouTubeVideoId(activeTabUrl);
    if (!activeVideoId) {
      return;
    }
    const progressKey = getProgressStorageKey(activeVideoId);
    const changedProgress = changes[progressKey]?.newValue;
    if (isStoredProgress(changedProgress)) {
      latestProgressByVideoId.set(activeVideoId, changedProgress);
      renderProgress(changedProgress);
    }
  });
  void initializePanel();
  async function initializePanel() {
    const [stored] = await Promise.all([
      chrome.storage.local.get(IGNORE_SUBTITLES_KEY),
      refreshActiveTab(),
      initializeAccount()
    ]);
    ignoreSubtitlesInput.checked = stored[IGNORE_SUBTITLES_KEY] === true;
  }
  async function initializeAccount() {
    try {
      const session = await restoreSession();
      currentUser = session?.user ?? null;
      currentCredits = session?.credits ?? null;
      renderAccount();
    } catch (error) {
      currentUser = null;
      currentCredits = null;
      renderAccount();
      setStatus(getApiErrorMessage(error), "error");
    }
  }
  async function handleLoginButton() {
    if (currentUser) {
      await logout();
      currentUser = null;
      currentCredits = null;
      loginPasswordInput.value = "";
      renderAccount();
      setStatus("\u5DF2\u767B\u51FA PureText\u3002", "success");
      return;
    }
    loginPanel.hidden = !loginPanel.hidden;
    loginErrorElement.textContent = "";
    if (!loginPanel.hidden) {
      loginEmailInput.focus();
    }
  }
  async function submitLogin(event) {
    event.preventDefault();
    const email = loginEmailInput.value.trim();
    const password = loginPasswordInput.value;
    if (!email || !password) {
      loginErrorElement.textContent = "\u8ACB\u8F38\u5165 Email \u548C\u5BC6\u78BC\u3002";
      return;
    }
    loginSubmitButton.disabled = true;
    loginSubmitButton.textContent = "\u767B\u5165\u4E2D\u2026";
    loginErrorElement.textContent = "";
    try {
      const session = await login(email, password);
      currentUser = session.user;
      currentCredits = session.credits;
      loginPasswordInput.value = "";
      loginPanel.hidden = true;
      renderAccount();
      setStatus("PureText \u767B\u5165\u6210\u529F\uFF0C\u53EF\u4EE5\u958B\u59CB\u7522\u751F\u5B57\u5E55\u3002", "success");
    } catch (error) {
      loginErrorElement.textContent = getApiErrorMessage(error);
    } finally {
      loginSubmitButton.disabled = false;
      loginSubmitButton.textContent = "\u767B\u5165";
    }
  }
  async function beginGoogleLogin() {
    googleLoginButton.disabled = true;
    googleLoginButton.textContent = "\u6B63\u5728\u958B\u555F Google\u2026";
    loginErrorElement.textContent = "";
    try {
      await startGoogleLogin();
      loginErrorElement.dataset.kind = "neutral";
      loginErrorElement.textContent = "\u8ACB\u5728\u65B0\u5206\u9801\u5B8C\u6210 Google \u767B\u5165\u3002";
    } catch (error) {
      loginErrorElement.dataset.kind = "error";
      loginErrorElement.textContent = getApiErrorMessage(error);
    } finally {
      googleLoginButton.disabled = false;
      googleLoginButton.textContent = "\u4F7F\u7528 Google \u767B\u5165";
    }
  }
  async function completeExternalLogin() {
    try {
      const session = await restoreSession();
      if (!session) {
        return;
      }
      currentUser = session.user;
      currentCredits = session.credits;
      loginPanel.hidden = true;
      loginErrorElement.textContent = "";
      renderAccount();
      setStatus("Google \u767B\u5165\u6210\u529F\uFF0C\u53EF\u4EE5\u958B\u59CB\u7522\u751F\u5B57\u5E55\u3002", "success");
    } catch (error) {
      loginErrorElement.dataset.kind = "error";
      loginErrorElement.textContent = getApiErrorMessage(error);
    }
  }
  function renderAccount() {
    const isLoggedIn = currentUser !== null;
    loginButton.textContent = isLoggedIn ? "\u767B\u51FA" : "\u767B\u5165";
    loginButton.disabled = isGenerating;
    accountCard.hidden = !isLoggedIn;
    generateButton.disabled = isGenerating;
    if (!currentUser) {
      accountNameElement.textContent = "PureText \u4F7F\u7528\u8005";
      accountEmailElement.textContent = "";
      remainingMinutesElement.textContent = "--";
      return;
    }
    accountNameElement.textContent = currentUser.name?.trim() || "PureText \u4F7F\u7528\u8005";
    accountEmailElement.textContent = currentUser.email;
    remainingMinutesElement.textContent = (currentCredits?.totalMinutes ?? currentUser.remainingMinutes).toLocaleString();
  }
  async function saveIgnoreSubtitlesPreference() {
    await chrome.storage.local.set({
      [IGNORE_SUBTITLES_KEY]: ignoreSubtitlesInput.checked
    });
    setStatus(
      ignoreSubtitlesInput.checked ? "\u4E0B\u6B21\u5C07\u5FFD\u7565\u5167\u5EFA\u5B57\u5E55\u4E26\u91CD\u65B0\u8F49\u9304\u97F3\u8ECC\u3002" : "\u4E0B\u6B21\u6703\u512A\u5148\u4F7F\u7528 YouTube \u5167\u5EFA\u5B57\u5E55\u3002",
      "success"
    );
  }
  async function closePanel() {
    if (activeTabId === null) {
      return;
    }
    try {
      await sendToTab(activeTabId, { type: "CLOSE_INLINE_PANEL" });
    } catch {
      window.close();
    }
  }
  async function refreshActiveTab() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    activeTabId = tab?.id ?? null;
    activeTabUrl = tab?.url ?? "";
    if (isYouTubeUrl(activeTabUrl) && getYouTubeVideoId(activeTabUrl)) {
      urlInput.value = activeTabUrl;
      await refreshCaptionState();
      await restoreLastProgress(activeTabUrl);
      return;
    }
    hideProgress();
    downloadCaptionButton.disabled = true;
    toggleCaptionVisibilityButton.disabled = true;
    setStatus("\u8ACB\u5148\u5728\u76EE\u524D\u8996\u7A97\u958B\u555F\u4E00\u90E8 YouTube \u5F71\u7247\u3002", "error");
  }
  async function generateCaptions() {
    if (!currentUser) {
      loginPanel.hidden = false;
      loginEmailInput.focus();
      setStatus("\u8ACB\u5148\u767B\u5165 PureText\uFF0C\u518D\u7522\u751F\u5B57\u5E55\u3002", "error");
      return;
    }
    const url = urlInput.value.trim();
    if (!isYouTubeUrl(url) || !getYouTubeVideoId(url)) {
      setStatus("\u8ACB\u8F38\u5165\u6709\u6548\u7684 YouTube \u5F71\u7247\u7DB2\u5740\u3002", "error");
      return;
    }
    if (activeTabId === null) {
      setStatus("\u627E\u4E0D\u5230\u76EE\u524D\u7684 YouTube \u5206\u9801\u3002", "error");
      return;
    }
    const sourceTabId = activeTabId;
    const sourceVideoId = getYouTubeVideoId(url);
    if (!sourceVideoId) {
      setStatus("\u627E\u4E0D\u5230 YouTube \u5F71\u7247 ID\u3002", "error");
      return;
    }
    isGenerating = true;
    generateButton.textContent = "\u6B63\u5728\u7522\u751F\u5B57\u5E55\u2026";
    renderAccount();
    try {
      currentCredits = await refreshCredits();
      renderAccount();
      if (currentCredits.totalMinutes <= 0) {
        throw new Error("\u5269\u9918\u5206\u9418\u6578\u4E0D\u8DB3\uFF0C\u8ACB\u5148\u5132\u503C\u5F8C\u518D\u8A66\u3002");
      }
      setStatus("\u5DF2\u9001\u51FA Audio-IO \u8ACB\u6C42\uFF1B\u6C92\u6709\u73FE\u6210\u5B57\u5E55\u6642\u53EF\u80FD\u9700\u8981\u6578\u5206\u9418\u3002");
      const transcription = await transcribeYouTube(url, {
        ignoreSubtitles: ignoreSubtitlesInput.checked,
        onProgress: (progress) => {
          void updateTranscriptionProgress(sourceVideoId, url, progress);
        }
      });
      const contentResponse = await sendToTab(sourceTabId, {
        type: "SET_CAPTIONS",
        sourceUrl: url,
        srt: transcription.content
      });
      if (!contentResponse.ok) {
        throw new Error(contentResponse.error);
      }
      renderCaptionControls(contentResponse);
      setStatus(
        `\u5B57\u5E55\u5DF2\u639B\u8F09\uFF0C\u5171 ${contentResponse.cueCount.toLocaleString()} \u6BB5\u3002`,
        "success"
      );
      await updateTranscriptionProgress(
        sourceVideoId,
        url,
        createStoredProgressUpdate(
          "completed",
          `\u5B57\u5E55\u5DF2\u639B\u8F09\uFF0C\u5171 ${contentResponse.cueCount.toLocaleString()} \u6BB5\u3002`,
          100
        ),
        true
      );
      await updateCreditsAfterTranscription();
    } catch (error) {
      if (error instanceof PureTextApiError && error.status === 401) {
        currentUser = null;
        currentCredits = null;
        renderAccount();
        loginPanel.hidden = false;
      }
      const message = error instanceof Error ? error.message : "\u5B57\u5E55\u7522\u751F\u5931\u6557\u3002";
      setStatus(message, "error");
      await updateTranscriptionProgress(
        sourceVideoId,
        url,
        {
          ...createStoredProgressUpdate("completed", message, null),
          stage: "failed"
        },
        true
      );
    } finally {
      isGenerating = false;
      generateButton.textContent = "\u7522\u751F\u4E26\u639B\u8F09\u5B57\u5E55";
      renderAccount();
    }
  }
  async function updateCreditsAfterTranscription() {
    try {
      currentCredits = await refreshCredits();
      renderAccount();
    } catch (error) {
      if (error instanceof PureTextApiError && error.status === 401) {
        currentUser = null;
        currentCredits = null;
        renderAccount();
      }
    }
  }
  async function refreshCaptionState() {
    if (activeTabId === null) {
      return;
    }
    try {
      const response = await sendToTab(activeTabId, {
        type: "GET_CAPTION_STATE"
      });
      if (!response.ok) {
        throw new Error(response.error);
      }
      renderCaptionControls(response);
      if (response.hasCaptions) {
        setStatus(
          `\u5DF2\u8F09\u5165\u672C\u6A5F\u5B57\u5E55\uFF0C\u5171 ${response.cueCount.toLocaleString()} \u6BB5\u3002`,
          "success"
        );
      } else {
        setStatus("\u53EF\u76F4\u63A5\u4F7F\u7528\u76EE\u524D\u5F71\u7247\u7DB2\u5740\u7522\u751F\u5B57\u5E55\u3002");
      }
    } catch {
      downloadCaptionButton.disabled = true;
      toggleCaptionVisibilityButton.disabled = true;
      setStatus("\u8ACB\u91CD\u65B0\u6574\u7406 YouTube \u5206\u9801\uFF0C\u8B93\u5B57\u5E55\u5916\u639B\u5B8C\u6210\u8F09\u5165\u3002", "error");
    }
  }
  async function toggleCaptionVisibility() {
    if (activeTabId === null) {
      setStatus("\u627E\u4E0D\u5230\u76EE\u524D\u7684 YouTube \u5206\u9801\u3002", "error");
      return;
    }
    try {
      const response = await sendToTab(activeTabId, {
        type: "TOGGLE_CAPTION_VISIBILITY"
      });
      if (!response.ok) {
        throw new Error(response.error);
      }
      renderCaptionControls(response);
      setStatus(
        response.isVisible ? "\u5DF2\u986F\u793A\u5B57\u5E55\u3002" : "\u5DF2\u96B1\u85CF\u5B57\u5E55\u3002",
        "success"
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "\u7121\u6CD5\u5207\u63DB\u5B57\u5E55\u986F\u793A\u72C0\u614B\u3002",
        "error"
      );
    }
  }
  function openCaptionFilePicker() {
    if (activeTabId === null || !isYouTubeUrl(activeTabUrl) || !getYouTubeVideoId(activeTabUrl)) {
      setStatus("\u8ACB\u5148\u5728\u76EE\u524D\u8996\u7A97\u958B\u555F\u4E00\u90E8 YouTube \u5F71\u7247\u3002", "error");
      return;
    }
    importCaptionFileInput.click();
  }
  async function importCaptionFile() {
    const file = importCaptionFileInput.files?.[0];
    importCaptionFileInput.value = "";
    if (!file) {
      return;
    }
    if (activeTabId === null || !getYouTubeVideoId(activeTabUrl)) {
      setStatus("\u627E\u4E0D\u5230\u76EE\u524D\u7684 YouTube \u5F71\u7247\u3002", "error");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus("SRT \u6A94\u6848\u4E0D\u53EF\u8D85\u904E 10 MB\u3002", "error");
      return;
    }
    importCaptionButton.disabled = true;
    importCaptionButton.textContent = "\u6B63\u5728\u532F\u5165\u2026";
    try {
      const srt = (await file.text()).replace(/^\uFEFF/, "").trim();
      if (!srt) {
        throw new Error("\u9078\u53D6\u7684 SRT \u6A94\u6848\u6C92\u6709\u5167\u5BB9\u3002");
      }
      const response = await sendToTab(activeTabId, {
        type: "SET_CAPTIONS",
        sourceUrl: activeTabUrl,
        srt
      });
      if (!response.ok) {
        throw new Error(response.error);
      }
      renderCaptionControls(response);
      const visibilityMessage = response.isVisible ? "" : "\uFF08\u5B57\u5E55\u76EE\u524D\u70BA\u96B1\u85CF\u72C0\u614B\uFF09";
      setStatus(
        `\u5DF2\u532F\u5165 ${file.name}\uFF0C\u5171 ${response.cueCount.toLocaleString()} \u6BB5${visibilityMessage}\u3002`,
        "success"
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "SRT \u532F\u5165\u5931\u6557\u3002",
        "error"
      );
    } finally {
      importCaptionButton.disabled = false;
      importCaptionButton.textContent = "\u532F\u5165 SRT";
    }
  }
  function renderCaptionControls(state) {
    downloadCaptionButton.disabled = !state.hasCaptions;
    toggleCaptionVisibilityButton.disabled = !state.hasCaptions;
    toggleCaptionVisibilityButton.textContent = state.isVisible ? "\u96B1\u85CF\u5B57\u5E55" : "\u986F\u793A\u5B57\u5E55";
  }
  async function downloadCurrentCaption() {
    if (activeTabId === null) {
      setStatus("\u627E\u4E0D\u5230\u76EE\u524D\u7684 YouTube \u5206\u9801\u3002", "error");
      return;
    }
    try {
      const response = await sendToTab(activeTabId, {
        type: "GET_CAPTION_CONTENT"
      });
      if (!response.ok) {
        throw new Error(response.error);
      }
      const srt = response.srt?.trim();
      if (!srt) {
        downloadCaptionButton.disabled = true;
        throw new Error("\u76EE\u524D\u5F71\u7247\u9084\u6C92\u6709\u53EF\u4E0B\u8F09\u7684\u5B57\u5E55\u3002");
      }
      const videoId = getYouTubeVideoId(response.sourceUrl || activeTabUrl) || "youtube";
      const blob = new Blob([`\uFEFF${srt}
`], {
        type: "application/x-subrip;charset=utf-8"
      });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `puretext-${videoId}.srt`;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1e3);
      setStatus(`\u5DF2\u4E0B\u8F09 puretext-${videoId}.srt\u3002`, "success");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "\u5B57\u5E55\u4E0B\u8F09\u5931\u6557\u3002",
        "error"
      );
    }
  }
  async function sendToTab(tabId, request) {
    try {
      return await chrome.tabs.sendMessage(tabId, request);
    } catch {
      throw new Error("\u7121\u6CD5\u9023\u63A5 YouTube \u5206\u9801\uFF1B\u8ACB\u91CD\u65B0\u6574\u7406\u5F71\u7247\u9801\u9762\u5F8C\u518D\u8A66\u3002");
    }
  }
  function setStatus(message, kind = "neutral") {
    statusElement.textContent = message;
    statusElement.dataset.kind = kind;
  }
  async function updateTranscriptionProgress(videoId, sourceUrl, progress, immediate = false) {
    const previous = progress.stage === "creating" ? null : latestProgressByVideoId.get(videoId) ?? null;
    const stored = {
      elapsedSeconds: progress.elapsedSeconds ?? previous?.elapsedSeconds ?? null,
      estimatedCompletionAt: progress.estimatedCompletionAt ?? previous?.estimatedCompletionAt ?? null,
      estimatedRemainingSeconds: progress.estimatedRemainingSeconds ?? previous?.estimatedRemainingSeconds ?? null,
      message: progress.message,
      processingSpeedX: progress.processingSpeedX ?? previous?.processingSpeedX ?? null,
      progressPercent: progress.progressPercent ?? previous?.progressPercent ?? null,
      sourceUrl,
      stage: progress.stage,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    latestProgressByVideoId.set(videoId, stored);
    if (getYouTubeVideoId(activeTabUrl) === videoId) {
      renderProgress(stored);
    }
    const key = getProgressStorageKey(videoId);
    pendingProgressWrites.set(key, stored);
    if (immediate) {
      await flushProgressWrites();
    } else {
      scheduleProgressWrite();
    }
  }
  function scheduleProgressWrite() {
    if (progressWriteTimer !== null) {
      return;
    }
    progressWriteTimer = window.setTimeout(() => {
      progressWriteTimer = null;
      void flushProgressWrites();
    }, 750);
  }
  async function flushProgressWrites() {
    if (progressWriteTimer !== null) {
      window.clearTimeout(progressWriteTimer);
      progressWriteTimer = null;
    }
    if (pendingProgressWrites.size === 0) {
      return;
    }
    const batch = Object.fromEntries(pendingProgressWrites);
    pendingProgressWrites.clear();
    await chrome.storage.local.set(batch);
    if (pendingProgressWrites.size > 0) {
      scheduleProgressWrite();
    }
  }
  async function restoreLastProgress(sourceUrl) {
    const videoId = getYouTubeVideoId(sourceUrl);
    if (!videoId) {
      hideProgress();
      return;
    }
    const key = getProgressStorageKey(videoId);
    const stored = await chrome.storage.local.get(key);
    const progress = stored[key];
    if (!isStoredProgress(progress)) {
      hideProgress();
      return;
    }
    latestProgressByVideoId.set(videoId, progress);
    renderProgress(progress);
  }
  function renderProgress(progress) {
    progressCard.hidden = false;
    const percent = clampPercent(progress.progressPercent);
    const percentText = percent === null ? "--" : `${formatPercent2(percent)}%`;
    progressPercentElement.textContent = percentText;
    progressBarElement.style.width = `${percent ?? 0}%`;
    progressTrackElement?.setAttribute(
      "aria-valuenow",
      String(Math.round(percent ?? 0))
    );
    if (progress.stage === "completed") {
      progressEtaElement.textContent = "\u5DF2\u5B8C\u6210";
    } else if (progress.stage === "failed") {
      progressEtaElement.textContent = "\u8F49\u8B6F\u5931\u6557";
    } else if (progress.estimatedCompletionAt) {
      const completionAt = new Date(progress.estimatedCompletionAt);
      progressEtaElement.textContent = Number.isNaN(completionAt.getTime()) ? "\u6B63\u5728\u4F30\u7B97\u5B8C\u6210\u6642\u9593\u2026" : `${completionTimeFormatter.format(completionAt)} \u5B8C\u6210`;
    } else {
      progressEtaElement.textContent = "\u6B63\u5728\u4F30\u7B97\u5B8C\u6210\u6642\u9593\u2026";
    }
    progressRemainingElement.textContent = progress.stage === "completed" ? "0:00" : progress.estimatedRemainingSeconds === null ? "--" : formatDuration(progress.estimatedRemainingSeconds);
    progressSpeedElement.textContent = progress.processingSpeedX === null ? "--" : `${progress.processingSpeedX.toFixed(1)}x`;
    progressElapsedElement.textContent = progress.elapsedSeconds === null ? "--" : formatDuration(progress.elapsedSeconds);
    progressUpdatedElement.textContent = `\u6700\u5F8C\u66F4\u65B0 ${formatUpdatedAt(progress.updatedAt)}`;
    setStatus(
      progress.message,
      progress.stage === "failed" ? "error" : progress.stage === "completed" ? "success" : "neutral"
    );
  }
  function hideProgress() {
    progressCard.hidden = true;
  }
  function getProgressStorageKey(videoId) {
    return `${PROGRESS_STORAGE_PREFIX}${videoId}`;
  }
  function isStoredProgress(value) {
    if (!value || typeof value !== "object") {
      return false;
    }
    const record = value;
    return typeof record["message"] === "string" && typeof record["sourceUrl"] === "string" && typeof record["updatedAt"] === "string" && ["creating", "queued", "transcribing", "completed", "failed"].includes(
      String(record["stage"])
    );
  }
  function createStoredProgressUpdate(stage, message, progressPercent) {
    return {
      elapsedSeconds: null,
      estimatedCompletionAt: null,
      estimatedRemainingSeconds: null,
      message,
      processingSpeedX: null,
      progressPercent,
      stage
    };
  }
  function clampPercent(value) {
    return value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value));
  }
  function formatPercent2(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  }
  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = seconds % 60;
    return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}` : `${minutes}:${remainder.toString().padStart(2, "0")}`;
  }
  function formatUpdatedAt(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--" : completionTimeFormatter.format(date);
  }
  function getElement(id) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing element #${id}`);
    }
    return element;
  }
  function getApiErrorMessage(error) {
    return error instanceof Error ? error.message : "PureText \u767B\u5165\u5931\u6557\u3002";
  }
})();
//# sourceMappingURL=sidepanel.js.map
