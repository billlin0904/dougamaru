import {
  transcribeYouTube,
  type TranscriptionProgress,
} from "./audio-io";
import type { ContentRequest, ContentResponse } from "./messages";
import {
  login,
  logout,
  PureTextApiError,
  PURETEXT_TOKEN_KEY,
  refreshCredits,
  restoreSession,
  startGoogleLogin,
  type PureTextCredits,
  type PureTextUser,
} from "./puretext-api";
import { getYouTubeVideoId, isYouTubeUrl } from "./youtube";

const urlInput = getElement<HTMLInputElement>("youtube-url");
const generateButton = getElement<HTMLButtonElement>("generate");
const importCaptionButton =
  getElement<HTMLButtonElement>("import-caption");
const importCaptionFileInput =
  getElement<HTMLInputElement>("import-caption-file");
const downloadCaptionButton =
  getElement<HTMLButtonElement>("download-caption");
const toggleCaptionVisibilityButton = getElement<HTMLButtonElement>(
  "toggle-caption-visibility",
);
const statusElement = getElement<HTMLParagraphElement>("status");
const closeButton = getElement<HTMLButtonElement>("close-panel");
const ignoreSubtitlesInput = getElement<HTMLInputElement>("ignore-subtitles");
const loginButton = getElement<HTMLButtonElement>("login-button");
const loginPanel = getElement<HTMLElement>("login-panel");
const loginForm = getElement<HTMLFormElement>("login-form");
const loginEmailInput = getElement<HTMLInputElement>("login-email");
const loginPasswordInput = getElement<HTMLInputElement>("login-password");
const loginSubmitButton = getElement<HTMLButtonElement>("login-submit");
const googleLoginButton = getElement<HTMLButtonElement>("google-login");
const loginErrorElement = getElement<HTMLParagraphElement>("login-error");
const accountCard = getElement<HTMLElement>("account-card");
const accountNameElement = getElement<HTMLElement>("account-name");
const accountEmailElement = getElement<HTMLElement>("account-email");
const remainingMinutesElement =
  getElement<HTMLElement>("remaining-minutes");
const progressCard = getElement<HTMLElement>("progress-card");
const progressPercentElement = getElement<HTMLElement>("progress-percent");
const progressTrackElement =
  progressCard.querySelector<HTMLElement>(".progress-track");
const progressBarElement = getElement<HTMLElement>("progress-bar");
const progressEtaElement = getElement<HTMLElement>("progress-eta");
const progressRemainingElement =
  getElement<HTMLElement>("progress-remaining");
const progressSpeedElement = getElement<HTMLElement>("progress-speed");
const progressElapsedElement = getElement<HTMLElement>("progress-elapsed");
const progressUpdatedElement = getElement<HTMLElement>("progress-updated");

const IGNORE_SUBTITLES_KEY = "puretext-ignore-youtube-subtitles";
const PROGRESS_STORAGE_PREFIX = "puretext-transcription-progress:";
const completionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

interface StoredTranscriptionProgress
  extends Omit<TranscriptionProgress, "stage"> {
  sourceUrl: string;
  stage: TranscriptionProgress["stage"] | "failed";
  updatedAt: string;
}

let activeTabId: number | null = null;
let activeTabUrl = "";
let currentUser: PureTextUser | null = null;
let currentCredits: PureTextCredits | null = null;
let isGenerating = false;
let progressWriteTimer: number | null = null;
const pendingProgressWrites = new Map<
  string,
  StoredTranscriptionProgress
>();
const latestProgressByVideoId = new Map<
  string,
  StoredTranscriptionProgress
>();

generateButton.addEventListener("click", () => void generateCaptions());
importCaptionButton.addEventListener("click", () => openCaptionFilePicker());
importCaptionFileInput.addEventListener(
  "change",
  () => void importCaptionFile(),
);
downloadCaptionButton.addEventListener(
  "click",
  () => void downloadCurrentCaption(),
);
toggleCaptionVisibilityButton.addEventListener(
  "click",
  () => void toggleCaptionVisibility(),
);
closeButton.addEventListener("click", () => void closePanel());
loginButton.addEventListener("click", () => void handleLoginButton());
loginForm.addEventListener("submit", (event) => void submitLogin(event));
googleLoginButton.addEventListener("click", () => void beginGoogleLogin());
ignoreSubtitlesInput.addEventListener(
  "change",
  () => void saveIgnoreSubtitlesPreference(),
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

  if (changes[PURETEXT_TOKEN_KEY]?.newValue !== undefined) {
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

async function initializePanel(): Promise<void> {
  const [stored] = await Promise.all([
    chrome.storage.local.get(IGNORE_SUBTITLES_KEY),
    refreshActiveTab(),
    initializeAccount(),
  ]);
  ignoreSubtitlesInput.checked = stored[IGNORE_SUBTITLES_KEY] === true;
}

async function initializeAccount(): Promise<void> {
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

async function handleLoginButton(): Promise<void> {
  if (currentUser) {
    await logout();
    currentUser = null;
    currentCredits = null;
    loginPasswordInput.value = "";
    renderAccount();
    setStatus("已登出 PureText。", "success");
    return;
  }

  loginPanel.hidden = !loginPanel.hidden;
  loginErrorElement.textContent = "";
  if (!loginPanel.hidden) {
    loginEmailInput.focus();
  }
}

async function submitLogin(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const email = loginEmailInput.value.trim();
  const password = loginPasswordInput.value;
  if (!email || !password) {
    loginErrorElement.textContent = "請輸入 Email 和密碼。";
    return;
  }

  loginSubmitButton.disabled = true;
  loginSubmitButton.textContent = "登入中…";
  loginErrorElement.textContent = "";

  try {
    const session = await login(email, password);
    currentUser = session.user;
    currentCredits = session.credits;
    loginPasswordInput.value = "";
    loginPanel.hidden = true;
    renderAccount();
    setStatus("PureText 登入成功，可以開始產生字幕。", "success");
  } catch (error) {
    loginErrorElement.textContent = getApiErrorMessage(error);
  } finally {
    loginSubmitButton.disabled = false;
    loginSubmitButton.textContent = "登入";
  }
}

async function beginGoogleLogin(): Promise<void> {
  googleLoginButton.disabled = true;
  googleLoginButton.textContent = "正在開啟 Google…";
  loginErrorElement.textContent = "";

  try {
    await startGoogleLogin();
    loginErrorElement.dataset.kind = "neutral";
    loginErrorElement.textContent = "請在新分頁完成 Google 登入。";
  } catch (error) {
    loginErrorElement.dataset.kind = "error";
    loginErrorElement.textContent = getApiErrorMessage(error);
  } finally {
    googleLoginButton.disabled = false;
    googleLoginButton.textContent = "使用 Google 登入";
  }
}

async function completeExternalLogin(): Promise<void> {
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
    setStatus("Google 登入成功，可以開始產生字幕。", "success");
  } catch (error) {
    loginErrorElement.dataset.kind = "error";
    loginErrorElement.textContent = getApiErrorMessage(error);
  }
}

function renderAccount(): void {
  const isLoggedIn = currentUser !== null;
  loginButton.textContent = isLoggedIn ? "登出" : "登入";
  loginButton.disabled = isGenerating;
  accountCard.hidden = !isLoggedIn;
  generateButton.disabled = isGenerating;

  if (!currentUser) {
    accountNameElement.textContent = "PureText 使用者";
    accountEmailElement.textContent = "";
    remainingMinutesElement.textContent = "--";
    return;
  }

  accountNameElement.textContent = currentUser.name?.trim() || "PureText 使用者";
  accountEmailElement.textContent = currentUser.email;
  remainingMinutesElement.textContent = (
    currentCredits?.totalMinutes ?? currentUser.remainingMinutes
  ).toLocaleString();
}

async function saveIgnoreSubtitlesPreference(): Promise<void> {
  await chrome.storage.local.set({
    [IGNORE_SUBTITLES_KEY]: ignoreSubtitlesInput.checked,
  });
  setStatus(
    ignoreSubtitlesInput.checked
      ? "下次將忽略內建字幕並重新轉錄音軌。"
      : "下次會優先使用 YouTube 內建字幕。",
    "success",
  );
}

async function closePanel(): Promise<void> {
  if (activeTabId === null) {
    return;
  }

  try {
    await sendToTab(activeTabId, { type: "CLOSE_INLINE_PANEL" });
  } catch {
    window.close();
  }
}

async function refreshActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
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
  setStatus("請先在目前視窗開啟一部 YouTube 影片。", "error");
}

async function generateCaptions(): Promise<void> {
  if (!currentUser) {
    loginPanel.hidden = false;
    loginEmailInput.focus();
    setStatus("請先登入 PureText，再產生字幕。", "error");
    return;
  }

  const url = urlInput.value.trim();
  if (!isYouTubeUrl(url) || !getYouTubeVideoId(url)) {
    setStatus("請輸入有效的 YouTube 影片網址。", "error");
    return;
  }

  if (activeTabId === null) {
    setStatus("找不到目前的 YouTube 分頁。", "error");
    return;
  }

  const sourceTabId = activeTabId;
  const sourceVideoId = getYouTubeVideoId(url);
  if (!sourceVideoId) {
    setStatus("找不到 YouTube 影片 ID。", "error");
    return;
  }

  isGenerating = true;
  generateButton.textContent = "正在產生字幕…";
  renderAccount();

  try {
    currentCredits = await refreshCredits();
    renderAccount();
    if (currentCredits.totalMinutes <= 0) {
      throw new Error("剩餘分鐘數不足，請先儲值後再試。");
    }

    setStatus("已送出 Audio-IO 請求；沒有現成字幕時可能需要數分鐘。");

    const transcription = await transcribeYouTube(url, {
      ignoreSubtitles: ignoreSubtitlesInput.checked,
      onProgress: (progress) => {
        void updateTranscriptionProgress(sourceVideoId, url, progress);
      },
    });

    const contentResponse = await sendToTab(sourceTabId, {
      type: "SET_CAPTIONS",
      sourceUrl: url,
      srt: transcription.content,
    });
    if (!contentResponse.ok) {
      throw new Error(contentResponse.error);
    }

    renderCaptionControls(contentResponse);
    setStatus(
      `字幕已掛載，共 ${contentResponse.cueCount.toLocaleString()} 段。`,
      "success",
    );
    await updateTranscriptionProgress(
      sourceVideoId,
      url,
      createStoredProgressUpdate(
        "completed",
        `字幕已掛載，共 ${contentResponse.cueCount.toLocaleString()} 段。`,
        100,
      ),
      true,
    );
    await updateCreditsAfterTranscription();
  } catch (error) {
    if (error instanceof PureTextApiError && error.status === 401) {
      currentUser = null;
      currentCredits = null;
      renderAccount();
      loginPanel.hidden = false;
    }
    const message =
      error instanceof Error ? error.message : "字幕產生失敗。";
    setStatus(message, "error");
    await updateTranscriptionProgress(
      sourceVideoId,
      url,
      {
        ...createStoredProgressUpdate("completed", message, null),
        stage: "failed",
      },
      true,
    );
  } finally {
    isGenerating = false;
    generateButton.textContent = "產生並掛載字幕";
    renderAccount();
  }
}

async function updateCreditsAfterTranscription(): Promise<void> {
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

async function refreshCaptionState(): Promise<void> {
  if (activeTabId === null) {
    return;
  }

  try {
    const response = await sendToTab(activeTabId, {
      type: "GET_CAPTION_STATE",
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    renderCaptionControls(response);
    if (response.hasCaptions) {
      setStatus(
        `已載入本機字幕，共 ${response.cueCount.toLocaleString()} 段。`,
        "success",
      );
    } else {
      setStatus("可直接使用目前影片網址產生字幕。");
    }
  } catch {
    downloadCaptionButton.disabled = true;
    toggleCaptionVisibilityButton.disabled = true;
    setStatus("請重新整理 YouTube 分頁，讓字幕外掛完成載入。", "error");
  }
}

async function toggleCaptionVisibility(): Promise<void> {
  if (activeTabId === null) {
    setStatus("找不到目前的 YouTube 分頁。", "error");
    return;
  }

  try {
    const response = await sendToTab(activeTabId, {
      type: "TOGGLE_CAPTION_VISIBILITY",
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    renderCaptionControls(response);
    setStatus(
      response.isVisible ? "已顯示字幕。" : "已隱藏字幕。",
      "success",
    );
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "無法切換字幕顯示狀態。",
      "error",
    );
  }
}

function openCaptionFilePicker(): void {
  if (
    activeTabId === null ||
    !isYouTubeUrl(activeTabUrl) ||
    !getYouTubeVideoId(activeTabUrl)
  ) {
    setStatus("請先在目前視窗開啟一部 YouTube 影片。", "error");
    return;
  }

  importCaptionFileInput.click();
}

async function importCaptionFile(): Promise<void> {
  const file = importCaptionFileInput.files?.[0];
  importCaptionFileInput.value = "";
  if (!file) {
    return;
  }

  if (activeTabId === null || !getYouTubeVideoId(activeTabUrl)) {
    setStatus("找不到目前的 YouTube 影片。", "error");
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    setStatus("SRT 檔案不可超過 10 MB。", "error");
    return;
  }

  importCaptionButton.disabled = true;
  importCaptionButton.textContent = "正在匯入…";

  try {
    const srt = (await file.text()).replace(/^\uFEFF/, "").trim();
    if (!srt) {
      throw new Error("選取的 SRT 檔案沒有內容。");
    }

    const response = await sendToTab(activeTabId, {
      type: "SET_CAPTIONS",
      sourceUrl: activeTabUrl,
      srt,
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    renderCaptionControls(response);
    const visibilityMessage = response.isVisible
      ? ""
      : "（字幕目前為隱藏狀態）";
    setStatus(
      `已匯入 ${file.name}，共 ${response.cueCount.toLocaleString()} 段${visibilityMessage}。`,
      "success",
    );
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "SRT 匯入失敗。",
      "error",
    );
  } finally {
    importCaptionButton.disabled = false;
    importCaptionButton.textContent = "匯入 SRT";
  }
}

function renderCaptionControls(
  state: Extract<ContentResponse, { ok: true }>,
): void {
  downloadCaptionButton.disabled = !state.hasCaptions;
  toggleCaptionVisibilityButton.disabled = !state.hasCaptions;
  toggleCaptionVisibilityButton.textContent = state.isVisible
    ? "隱藏字幕"
    : "顯示字幕";
}

async function downloadCurrentCaption(): Promise<void> {
  if (activeTabId === null) {
    setStatus("找不到目前的 YouTube 分頁。", "error");
    return;
  }

  try {
    const response = await sendToTab(activeTabId, {
      type: "GET_CAPTION_CONTENT",
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    const srt = response.srt?.trim();
    if (!srt) {
      downloadCaptionButton.disabled = true;
      throw new Error("目前影片還沒有可下載的字幕。");
    }

    const videoId =
      getYouTubeVideoId(response.sourceUrl || activeTabUrl) || "youtube";
    const blob = new Blob([`\uFEFF${srt}\n`], {
      type: "application/x-subrip;charset=utf-8",
    });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `puretext-${videoId}.srt`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    setStatus(`已下載 puretext-${videoId}.srt。`, "success");
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "字幕下載失敗。",
      "error",
    );
  }
}

async function sendToTab(
  tabId: number,
  request: ContentRequest,
): Promise<ContentResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
  } catch {
    throw new Error("無法連接 YouTube 分頁；請重新整理影片頁面後再試。");
  }
}

function setStatus(
  message: string,
  kind: "success" | "error" | "neutral" = "neutral",
): void {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

async function updateTranscriptionProgress(
  videoId: string,
  sourceUrl: string,
  progress: TranscriptionProgress | FailedTranscriptionProgress,
  immediate = false,
): Promise<void> {
  const previous =
    progress.stage === "creating"
      ? null
      : latestProgressByVideoId.get(videoId) ?? null;
  const stored: StoredTranscriptionProgress = {
    elapsedSeconds:
      progress.elapsedSeconds ?? previous?.elapsedSeconds ?? null,
    estimatedCompletionAt:
      progress.estimatedCompletionAt ??
      previous?.estimatedCompletionAt ??
      null,
    estimatedRemainingSeconds:
      progress.estimatedRemainingSeconds ??
      previous?.estimatedRemainingSeconds ??
      null,
    message: progress.message,
    processingSpeedX:
      progress.processingSpeedX ?? previous?.processingSpeedX ?? null,
    progressPercent:
      progress.progressPercent ?? previous?.progressPercent ?? null,
    sourceUrl,
    stage: progress.stage,
    updatedAt: new Date().toISOString(),
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

type FailedTranscriptionProgress = Omit<TranscriptionProgress, "stage"> & {
  stage: "failed";
};

function scheduleProgressWrite(): void {
  if (progressWriteTimer !== null) {
    return;
  }

  progressWriteTimer = window.setTimeout(() => {
    progressWriteTimer = null;
    void flushProgressWrites();
  }, 750);
}

async function flushProgressWrites(): Promise<void> {
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

async function restoreLastProgress(sourceUrl: string): Promise<void> {
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

function renderProgress(progress: StoredTranscriptionProgress): void {
  progressCard.hidden = false;

  const percent = clampPercent(progress.progressPercent);
  const percentText =
    percent === null ? "--" : `${formatPercent(percent)}%`;
  progressPercentElement.textContent = percentText;
  progressBarElement.style.width = `${percent ?? 0}%`;
  progressTrackElement?.setAttribute(
    "aria-valuenow",
    String(Math.round(percent ?? 0)),
  );

  if (progress.stage === "completed") {
    progressEtaElement.textContent = "已完成";
  } else if (progress.stage === "failed") {
    progressEtaElement.textContent = "轉譯失敗";
  } else if (progress.estimatedCompletionAt) {
    const completionAt = new Date(progress.estimatedCompletionAt);
    progressEtaElement.textContent = Number.isNaN(completionAt.getTime())
      ? "正在估算完成時間…"
      : `${completionTimeFormatter.format(completionAt)} 完成`;
  } else {
    progressEtaElement.textContent = "正在估算完成時間…";
  }

  progressRemainingElement.textContent =
    progress.stage === "completed"
      ? "0:00"
      : progress.estimatedRemainingSeconds === null
        ? "--"
        : formatDuration(progress.estimatedRemainingSeconds);
  progressSpeedElement.textContent =
    progress.processingSpeedX === null
      ? "--"
      : `${progress.processingSpeedX.toFixed(1)}x`;
  progressElapsedElement.textContent =
    progress.elapsedSeconds === null
      ? "--"
      : formatDuration(progress.elapsedSeconds);
  progressUpdatedElement.textContent = `最後更新 ${formatUpdatedAt(progress.updatedAt)}`;

  setStatus(
    progress.message,
    progress.stage === "failed"
      ? "error"
      : progress.stage === "completed"
        ? "success"
        : "neutral",
  );
}

function hideProgress(): void {
  progressCard.hidden = true;
}

function getProgressStorageKey(videoId: string): string {
  return `${PROGRESS_STORAGE_PREFIX}${videoId}`;
}

function isStoredProgress(value: unknown): value is StoredTranscriptionProgress {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record["message"] === "string" &&
    typeof record["sourceUrl"] === "string" &&
    typeof record["updatedAt"] === "string" &&
    ["creating", "queued", "transcribing", "completed", "failed"].includes(
      String(record["stage"]),
    )
  );
}

function createStoredProgressUpdate(
  stage: TranscriptionProgress["stage"],
  message: string,
  progressPercent: number | null,
): TranscriptionProgress {
  return {
    elapsedSeconds: null,
    estimatedCompletionAt: null,
    estimatedRemainingSeconds: null,
    message,
    processingSpeedX: null,
    progressPercent,
    stage,
  };
}

function clampPercent(value: number | null): number | null {
  return value === null || !Number.isFinite(value)
    ? null
    : Math.min(100, Math.max(0, value));
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder
        .toString()
        .padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--"
    : completionTimeFormatter.format(date);
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

function getApiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "PureText 登入失敗。";
}
