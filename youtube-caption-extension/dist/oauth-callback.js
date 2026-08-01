"use strict";
(() => {
  // src/oauth-callback.ts
  if (window.location.pathname === "/auth/callback") {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token");
    if (token) {
      const message = {
        token,
        type: "PURETEXT_GOOGLE_CALLBACK"
      };
      void chrome.runtime.sendMessage(message).catch(() => void 0);
    }
  }
})();
//# sourceMappingURL=oauth-callback.js.map
