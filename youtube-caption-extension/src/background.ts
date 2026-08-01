import {
  PURETEXT_GOOGLE_RETURN_TAB_KEY,
  PURETEXT_TOKEN_KEY,
} from "./puretext-api";

const PURETEXT_ORIGIN =
  "https://website-builder-pro--billlin0904.replit.app";

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) {
    return;
  }

  void chrome.tabs
    .sendMessage(tab.id, { type: "TOGGLE_INLINE_PANEL" })
    .catch((error: unknown) => {
      console.warn(
        "Unable to open the inline panel. Reload the YouTube tab.",
        error,
      );
    });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isGoogleCallbackMessage(message) || !isTrustedGoogleCallback(sender)) {
    return false;
  }

  void (async () => {
    try {
      await chrome.storage.local.set({
        [PURETEXT_TOKEN_KEY]: message.token,
      });
      await focusGoogleLoginReturnTab().catch(() => undefined);
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: false });
    }
  })();

  return true;
});

async function focusGoogleLoginReturnTab(): Promise<void> {
  const stored = await chrome.storage.session.get(
    PURETEXT_GOOGLE_RETURN_TAB_KEY,
  );
  await chrome.storage.session.remove(PURETEXT_GOOGLE_RETURN_TAB_KEY);

  const tabId = stored[PURETEXT_GOOGLE_RETURN_TAB_KEY];
  if (typeof tabId !== "number") {
    return;
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) {
    return;
  }

  await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
  if (tab.windowId !== undefined) {
    await chrome.windows
      .update(tab.windowId, { focused: true })
      .catch(() => undefined);
  }
}

function isGoogleCallbackMessage(
  message: unknown,
): message is { token: string; type: "PURETEXT_GOOGLE_CALLBACK" } {
  if (!message || typeof message !== "object") {
    return false;
  }

  const record = message as Record<string, unknown>;
  return (
    record["type"] === "PURETEXT_GOOGLE_CALLBACK" &&
    typeof record["token"] === "string" &&
    record["token"].length > 20
  );
}

function isTrustedGoogleCallback(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.url || sender.tab?.id === undefined) {
    return false;
  }

  try {
    const url = new URL(sender.url);
    return url.origin === PURETEXT_ORIGIN && url.pathname === "/auth/callback";
  } catch {
    return false;
  }
}
