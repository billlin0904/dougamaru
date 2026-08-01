const API_ORIGIN = "https://website-builder-pro--billlin0904.replit.app";
const API_BASE = `${API_ORIGIN}/api`;
export const PURETEXT_TOKEN_KEY = "puretext-user-token";
export const PURETEXT_GOOGLE_RETURN_TAB_KEY =
  "puretext-google-return-tab-id";

export interface PureTextUser {
  email: string;
  emailVerified: boolean;
  id: number;
  name: string | null;
  remainingMinutes: number;
}

export interface PureTextCredits {
  eligibleMinutes: number;
  totalMinutes: number;
}

interface LoginResponse {
  token: string;
  user: PureTextUser;
}

interface MeResponse {
  user: PureTextUser;
}

export class PureTextApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PureTextApiError";
  }
}

export async function login(
  email: string,
  password: string,
): Promise<{ credits: PureTextCredits; user: PureTextUser }> {
  const result = await requestJson<LoginResponse>("/user/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!result.token) {
    throw new PureTextApiError("登入成功，但伺服器沒有回傳 Token。", 500);
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

export async function restoreSession(): Promise<{
  credits: PureTextCredits;
  user: PureTextUser;
} | null> {
  const token = await getToken();
  if (!token) {
    return null;
  }

  try {
    const [me, credits] = await Promise.all([
      requestJson<MeResponse>(
        "/user/me",
        {
          method: "GET",
        },
        token,
      ),
      getCredits(token),
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

export async function refreshCredits(): Promise<PureTextCredits> {
  const token = await getToken();
  if (!token) {
    throw new PureTextApiError("請先登入 PureText。", 401);
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

export async function logout(): Promise<void> {
  await clearToken();
}

export async function startGoogleLogin(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (activeTab?.id !== undefined) {
    await chrome.storage.session.set({
      [PURETEXT_GOOGLE_RETURN_TAB_KEY]: activeTab.id,
    });
  }

  await chrome.tabs.create({
    url: `${API_BASE}/user/google?next=${encodeURIComponent("/")}`,
  });
}

async function getCredits(token: string): Promise<PureTextCredits> {
  return requestJson<PureTextCredits>(
    "/user/credits",
    {
      method: "GET",
    },
    token,
  );
}

async function getToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(PURETEXT_TOKEN_KEY);
  const token = stored[PURETEXT_TOKEN_KEY];
  return typeof token === "string" && token ? token : null;
}

async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(PURETEXT_TOKEN_KEY);
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  token?: string,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new PureTextApiError("無法連線 PureText API，請稍後再試。", 0);
  }

  const rawBody = await response.text();
  const payload = parseJson(rawBody);

  if (!response.ok) {
    throw new PureTextApiError(
      extractError(payload) || `PureText API 請求失敗（HTTP ${response.status}）。`,
      response.status,
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new PureTextApiError("PureText API 回傳格式不正確。", response.status);
  }

  return payload as T;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return typeof payload === "string" && payload.trim() ? payload : null;
  }

  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}
