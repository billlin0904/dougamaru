import { isYouTubeUrl } from "./youtube";

const QUEUE_ORIGIN = "https://gpuiapi.audio-io.com";
const QUEUE_ENDPOINT = `${QUEUE_ORIGIN}/api/youtube-live/jobs`;

export interface TranscriptionOptions {
  ignoreSubtitles: boolean;
  onProgress?: (progress: TranscriptionProgress) => void;
}

export interface TranscriptionResult {
  content: string;
}

export interface TranscriptionProgress {
  elapsedSeconds: number | null;
  estimatedCompletionAt: string | null;
  estimatedRemainingSeconds: number | null;
  message: string;
  processingSpeedX: number | null;
  progressPercent: number | null;
  stage: "creating" | "queued" | "transcribing" | "completed";
}

interface QueueSegment {
  elapsedSeconds: number | null;
  end: number;
  estimatedCompletionAt: string | null;
  estimatedRemainingSeconds: number | null;
  processingSpeedX: number | null;
  progressPercent: number | null;
  start: number;
  text: string;
}

interface SseEvent {
  data: string;
  event: string;
}

export async function transcribeYouTube(
  url: string,
  options: TranscriptionOptions,
): Promise<TranscriptionResult> {
  if (!isYouTubeUrl(url)) {
    throw new Error("請輸入有效的 YouTube 影片網址。");
  }

  return transcribeWithQueue(url, options.ignoreSubtitles, options.onProgress);
}

async function transcribeWithQueue(
  url: string,
  ignoreSubtitles: boolean,
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<TranscriptionResult> {
  onProgress?.(createProgress("creating", "正在建立影片轉譯工作…", 0));

  const response = await fetch(QUEUE_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      language: "",
      captcha_token: "",
      ignore_subtitles: ignoreSubtitles,
    }),
  });

  const rawBody = await response.text();
  const payload = parseJsonIfPossible(rawBody);

  if (!response.ok) {
    throw new Error(extractApiError(payload, response.status));
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Audio-IO 沒有回傳有效的佇列工作。");
  }

  const job = payload as Record<string, unknown>;
  const jobId = typeof job["job_id"] === "string" ? job["job_id"] : "";
  const rawEventsUrl =
    typeof job["events_url"] === "string"
      ? job["events_url"]
      : jobId
        ? `/api/youtube-live/jobs/${encodeURIComponent(jobId)}/events`
        : "";

  if (!rawEventsUrl) {
    throw new Error("Audio-IO 沒有回傳轉錄進度網址。");
  }

  const eventsUrl = new URL(rawEventsUrl, QUEUE_ORIGIN);
  if (eventsUrl.origin !== QUEUE_ORIGIN) {
    throw new Error("Audio-IO 回傳了不安全的轉錄進度網址。");
  }

  onProgress?.(
    createProgress("queued", "工作已排入佇列，等待 Audio-IO 處理…", 0),
  );
  return readQueueEvents(eventsUrl.href, onProgress);
}

async function readQueueEvents(
  eventsUrl: string,
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<TranscriptionResult> {
  const response = await fetch(eventsUrl, {
    headers: {
      Accept: "text/event-stream",
    },
  });

  if (!response.ok || !response.body) {
    const payload = parseJsonIfPossible(await response.text());
    throw new Error(extractApiError(payload, response.status));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const segments: QueueSegment[] = [];
  let buffer = "";
  let duration = 0;
  let completed = false;
  let lastPercent = -1;
  let finalResult: TranscriptionResult | null = null;

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
                const message = (data as Record<string, unknown>)["message"];
                if (typeof message === "string" && message.trim()) {
                  onProgress?.(
                    createProgress(
                      "queued",
                      message,
                      Math.max(0, lastPercent),
                    ),
                  );
                }
              }
              break;
            }

            case "metadata": {
              const data = parseJsonIfPossible(event.data);
              if (data && typeof data === "object") {
                const rawDuration = (data as Record<string, unknown>)[
                  "duration"
                ];
                duration = Number(rawDuration) || 0;
                if (duration > 0) {
                  onProgress?.(
                    createProgress(
                      "transcribing",
                      `開始處理字幕，共約 ${Math.round(duration)} 秒…`,
                      Math.max(0, lastPercent),
                    ),
                  );
                }
              }
              break;
            }

            case "segment": {
              const segment = parseQueueSegment(event.data);
              if (segment) {
                segments.push(segment);
                const fallbackPercent =
                  duration > 0
                    ? Math.min(
                        99,
                        Math.max(0, (segment.end / duration) * 100),
                      )
                    : null;
                const percent = segment.progressPercent ?? fallbackPercent;

                if (percent !== null) {
                  lastPercent = percent;
                }

                onProgress?.({
                  elapsedSeconds: segment.elapsedSeconds,
                  estimatedCompletionAt: segment.estimatedCompletionAt,
                  estimatedRemainingSeconds:
                    segment.estimatedRemainingSeconds,
                  message:
                    percent !== null
                      ? `字幕處理中… ${formatPercent(percent)}%`
                      : `已完成 ${segments.length} 段字幕…`,
                  processingSpeedX: segment.processingSpeedX,
                  progressPercent: percent,
                  stage: "transcribing",
                });
              }
              break;
            }

            case "done": {
              finalResult = extractTranscription(
                parseJsonIfPossible(event.data),
              );
              completed = true;
              break;
            }

            case "failed": {
              const data = parseJsonIfPossible(event.data);
              const message =
                data && typeof data === "object"
                  ? (data as Record<string, unknown>)["message"]
                  : null;
              throw new Error(
                typeof message === "string" && message.trim()
                  ? message
                  : "影片轉譯失敗。",
              );
            }
          }
        }

        boundary = findSseBoundary(buffer);
      }

      if (done && !completed) {
        throw new Error("影片轉譯連線已中斷，請重新嘗試。");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const content = buildSrt(segments) || getTimedContent(finalResult?.content);
  if (!content) {
    throw new Error("轉譯已完成，但沒有回傳任何字幕片段。");
  }

  onProgress?.(
    createProgress("completed", "轉譯完成，正在掛載字幕…", 100),
  );
  return { content };
}

function findSseBoundary(
  value: string,
): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(value);
  return match
    ? {
        index: match.index,
        length: match[0].length,
      }
    : null;
}

function parseSseEvent(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];

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

  return data.length > 0 || event === "done"
    ? {
        data: data.join("\n"),
        event,
      }
    : null;
}

function parseQueueSegment(value: string): QueueSegment | null {
  const data = parseJsonIfPossible(value);
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = data as Record<string, unknown>;
  const text = typeof record["text"] === "string" ? record["text"].trim() : "";
  const start = Number(record["start"]) || 0;
  const parsedEnd = Number(record["end"]);
  const end =
    Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + 3;

  return text
    ? {
        elapsedSeconds: nullableNumber(record["elapsed_seconds"]),
        end,
        estimatedCompletionAt:
          typeof record["estimated_completion_at"] === "string"
            ? record["estimated_completion_at"]
            : null,
        estimatedRemainingSeconds: nullableNumber(
          record["estimated_remaining_seconds"],
        ),
        processingSpeedX: nullableNumber(record["processing_speed_x"]),
        progressPercent: nullableNumber(record["progress_percent"]),
        start,
        text,
      }
    : null;
}

function buildSrt(segments: QueueSegment[]): string {
  return [...segments]
    .sort((first, second) => first.start - second.start)
    .map(
      (segment, index) =>
        `${index + 1}\n${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(segment.end)}\n${segment.text}`,
    )
    .join("\n\n");
}

function getTimedContent(value: string | null | undefined): string | null {
  const content = value?.trim();
  return content?.includes("-->") ? content : null;
}

function formatSrtTimestamp(seconds: number): string {
  const millisecondsTotal = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(millisecondsTotal / 3_600_000);
  const minutes = Math.floor((millisecondsTotal % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((millisecondsTotal % 60_000) / 1000);
  const milliseconds = millisecondsTotal % 1000;

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${wholeSeconds
    .toString()
    .padStart(2, "0")},${milliseconds.toString().padStart(3, "0")}`;
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractTranscription(payload: unknown): TranscriptionResult | null {
  if (typeof payload === "string") {
    return { content: payload };
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  for (const key of ["content", "srt", "text", "result", "data"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return { content: candidate };
    }
  }

  return null;
}

function extractApiError(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const detail = (payload as Record<string, unknown>)["detail"];
    if (typeof detail === "string") {
      return `Audio-IO：${detail}`;
    }

    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const message = (item as Record<string, unknown>)["msg"];
          return typeof message === "string" ? message : null;
        })
        .filter((message): message is string => Boolean(message));

      if (messages.length > 0) {
        return `Audio-IO：${messages.join("、")}`;
      }
    }
  }

  return `Audio-IO 請求失敗（HTTP ${status}）。`;
}

function createProgress(
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

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}
