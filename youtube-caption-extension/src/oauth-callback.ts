interface GoogleCallbackMessage {
  token: string;
  type: "PURETEXT_GOOGLE_CALLBACK";
}

if (window.location.pathname === "/auth/callback") {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token");

  if (token) {
    const message: GoogleCallbackMessage = {
      token,
      type: "PURETEXT_GOOGLE_CALLBACK",
    };

    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }
}
