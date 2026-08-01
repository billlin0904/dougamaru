// src/puretext-api.ts
var API_ORIGIN = "https://website-builder-pro--billlin0904.replit.app";
var API_BASE = `${API_ORIGIN}/api`;
var PURETEXT_TOKEN_KEY = "puretext-user-token";
var PURETEXT_GOOGLE_RETURN_TAB_KEY = "puretext-google-return-tab-id";

// src/background.ts
var PURETEXT_ORIGIN = "https://website-builder-pro--billlin0904.replit.app";
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === void 0) {
    return;
  }
  void chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_INLINE_PANEL" }).catch((error) => {
    console.warn(
      "Unable to open the inline panel. Reload the YouTube tab.",
      error
    );
  });
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isGoogleCallbackMessage(message) || !isTrustedGoogleCallback(sender)) {
    return false;
  }
  void (async () => {
    try {
      await chrome.storage.local.set({
        [PURETEXT_TOKEN_KEY]: message.token
      });
      await focusGoogleLoginReturnTab().catch(() => void 0);
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: false });
    }
  })();
  return true;
});
async function focusGoogleLoginReturnTab() {
  const stored = await chrome.storage.session.get(
    PURETEXT_GOOGLE_RETURN_TAB_KEY
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
  await chrome.tabs.update(tab.id, { active: true }).catch(() => void 0);
  if (tab.windowId !== void 0) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => void 0);
  }
}
function isGoogleCallbackMessage(message) {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message;
  return record["type"] === "PURETEXT_GOOGLE_CALLBACK" && typeof record["token"] === "string" && record["token"].length > 20;
}
function isTrustedGoogleCallback(sender) {
  if (!sender.url || sender.tab?.id === void 0) {
    return false;
  }
  try {
    const url = new URL(sender.url);
    return url.origin === PURETEXT_ORIGIN && url.pathname === "/auth/callback";
  } catch {
    return false;
  }
}
//# sourceMappingURL=background.js.map
