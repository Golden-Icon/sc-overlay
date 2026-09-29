"use strict";

// Low-resource embedded browser support for the native Linux overlay canvas.
// Third-party pages render in isolated WebContentsView instances rather than in the overlay DOM.
// This avoids <webview>, keeps Node disabled, and lets the main process position the page exactly
// inside a normal draggable/resizable widget shell.

const DEFAULT_BROWSER_URL = "https://erkul.games/calculator";
const TWITCH_RESERVED_PATHS = new Set([
  "directory", "downloads", "jobs", "p", "search", "settings", "subscriptions",
  "turbo", "videos", "wallet", "drops", "inventory", "friends", "messages",
]);

function cleanBounds(value) {
  if (!value || typeof value !== "object") return null;
  const x = Math.round(Number(value.x));
  const y = Math.round(Number(value.y));
  const width = Math.round(Number(value.width ?? value.w));
  const height = Math.round(Number(value.height ?? value.h));
  if (![x, y, width, height].every(Number.isFinite) || width < 2 || height < 2) return null;
  return { x, y, width, height };
}

function normalizeAddress(input) {
  const raw = String(input || "").trim();
  if (!raw) return DEFAULT_BROWSER_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch { /* try shorthand/search below */ }
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw)) {
    try { return new URL(`https://${raw}`).href; } catch { /* search below */ }
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}

function twitchChannelFromUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "twitch.tv" && host !== "m.twitch.tv") return "";
    const first = url.pathname.split("/").filter(Boolean)[0] || "";
    if (!first || TWITCH_RESERVED_PATHS.has(first.toLowerCase())) return "";
    return /^[a-z0-9_]{2,25}$/i.test(first) ? first.toLowerCase() : "";
  } catch { return ""; }
}

function cleanChannel(value) {
  const channel = String(value || "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(channel) ? channel : "";
}

class BrowserWidgetController {
  constructor({ WebContentsView, session, logger = console, state = {}, onInteractionClaim = null } = {}) {
    this.WebContentsView = WebContentsView;
    this.sessionModule = session;
    this.logger = logger;
    this.parent = null;
    this.browserView = null;
    this.chatView = null;
    this.browserBounds = null;
    this.chatBounds = null;
    this.browserVisible = !!state.browserVisible;
    this.chatVisible = !!state.chatVisible;
    this.browserLoaded = false;
    this.chatLoaded = false;
    this.url = normalizeAddress(state.url || DEFAULT_BROWSER_URL);
    this.title = "Browser";
    this.channel = cleanChannel(state.channel || twitchChannelFromUrl(this.url));
    this.loading = false;
    this.interactionKeyHeld = false;
    this.onState = typeof state.onState === "function" ? state.onState : null;
    this.onInteractionClaim = typeof onInteractionClaim === "function" ? onInteractionClaim : null;
  }

  attach(parent) {
    if (!parent || parent.isDestroyed?.()) return false;
    if (!this.WebContentsView || !parent.contentView?.addChildView) {
      this.logger.error("[browser] WebContentsView is unavailable in this Electron runtime");
      return false;
    }
    this.parent = parent;
    const ses = this.sessionModule.fromPartition("persist:sc-overlay-browser", { cache: true });
    // The browser widget is for read/browse use. Deny camera, microphone, geolocation,
    // notifications, MIDI, USB, serial, and other privileged capabilities by default.
    try { ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); } catch {}
    try { ses.setPermissionCheckHandler(() => false); } catch {}

    this.browserView = this.#makeView(ses, "browser");
    this.chatView = this.#makeView(ses, "chat");
    parent.contentView.addChildView(this.browserView);
    parent.contentView.addChildView(this.chatView);
    this.browserView.setVisible(false);
    this.chatView.setVisible(false);
    this.#wireBrowser();
    this.#wireChat();
    this.#syncVisibility();
    this.#emitState();
    return true;
  }

  #makeView(ses, kind) {
    const view = new this.WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: true,
        autoplayPolicy: kind === "browser" ? "user-gesture-required" : "user-gesture-required",
      },
    });
    try { view.setBackgroundColor(kind === "chat" ? "#0e0e10" : "#10161d"); } catch {}
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) this.navigate(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    view.webContents.on("will-prevent-unload", (event) => event.preventDefault());
    // The in-game interaction key is the letter F. If a click focuses this child view while F
    // is physically held, do not type a stray repeated "f" into a page field.
    view.webContents.on("before-input-event", (event, input) => {
      if (this.interactionKeyHeld && String(input.key || "").toLowerCase() === "f") event.preventDefault();
    });
    // WebContentsView clicks do not bubble through the parent overlay DOM. A focus event is the
    // reliable signal that the user clicked the embedded browser or Twitch chat, so notify the
    // main state machine and latch overlay ownership just like a normal widget click.
    view.webContents.on("focus", () => {
      try { this.onInteractionClaim?.(kind); } catch {}
    });
    return view;
  }

  #wireBrowser() {
    const wc = this.browserView.webContents;
    const update = () => {
      this.url = wc.getURL() || this.url;
      this.title = wc.getTitle() || "Browser";
      const detected = twitchChannelFromUrl(this.url);
      if (detected && detected !== this.channel) {
        this.channel = detected;
        if (this.chatVisible) this.#loadChat();
      }
      this.#emitState();
    };
    wc.on("did-start-loading", () => { this.loading = true; this.#emitState(); });
    wc.on("did-stop-loading", () => { this.loading = false; update(); });
    wc.on("did-navigate", update);
    wc.on("did-navigate-in-page", update);
    wc.on("page-title-updated", update);
    wc.on("render-process-gone", (_e, details) => {
      this.logger.error(`[browser] browser renderer exited: ${details.reason}`);
      this.browserLoaded = false;
      this.#emitState();
    });
  }

  #wireChat() {
    this.chatView.webContents.on("render-process-gone", (_e, details) => {
      this.logger.error(`[browser] Twitch chat renderer exited: ${details.reason}`);
      this.chatLoaded = false;
    });
  }

  #ensureBrowser() {
    if (!this.browserView || this.browserLoaded) return;
    this.browserLoaded = true;
    this.browserView.webContents.loadURL(this.url).catch((e) => {
      this.browserLoaded = false;
      this.logger.error(`[browser] load failed: ${String(e)}`);
      this.#emitState({ error: String(e) });
    });
  }

  #chatUrl() {
    // Twitch's official chat embed requires a parent domain. The overlay shell is served from
    // 127.0.0.1, so that is the parent declared here. Cookies live in the persistent browser
    // partition, allowing the user to remain signed in across app upgrades.
    return this.channel
      ? `https://www.twitch.tv/embed/${encodeURIComponent(this.channel)}/chat?parent=127.0.0.1&darkpopout`
      : "data:text/html;charset=utf-8," + encodeURIComponent(
          "<!doctype html><meta name=color-scheme content=dark><style>body{margin:0;background:#0e0e10;color:#adadb8;font:14px system-ui;display:grid;place-items:center;height:100vh;text-align:center;padding:20px;box-sizing:border-box}</style><div>Open a Twitch channel in the browser or enter a channel name above.</div>",
        );
  }

  #loadChat() {
    if (!this.chatView) return;
    const url = this.#chatUrl();
    this.chatLoaded = true;
    this.chatView.webContents.loadURL(url).catch((e) => {
      this.chatLoaded = false;
      this.logger.error(`[browser] Twitch chat load failed: ${String(e)}`);
    });
    this.#emitState();
  }

  #syncVisibility() {
    if (this.browserView) {
      const show = this.browserVisible && !!this.browserBounds;
      this.browserView.setVisible(show);
      try { this.browserView.webContents.setAudioMuted(!show); } catch {}
      if (show) {
        this.browserView.setBounds(this.browserBounds);
        this.#ensureBrowser();
      }
    }
    if (this.chatView) {
      const show = this.chatVisible && !!this.chatBounds;
      this.chatView.setVisible(show);
      try { this.chatView.webContents.setAudioMuted(true); } catch {}
      if (show) {
        this.chatView.setBounds(this.chatBounds);
        if (!this.chatLoaded) this.#loadChat();
      }
    }
  }

  #emitState(extra = {}) {
    const wc = this.browserView?.webContents;
    const state = {
      browserVisible: this.browserVisible,
      chatVisible: this.chatVisible,
      url: this.url,
      title: this.title,
      loading: this.loading,
      canGoBack: !!wc?.navigationHistory?.canGoBack?.(),
      canGoForward: !!wc?.navigationHistory?.canGoForward?.(),
      channel: this.channel,
      ...extra,
    };
    try { this.onState?.(state); } catch {}
    return state;
  }

  state() { return this.#emitState(); }
  setInteractionKeyHeld(on) { this.interactionKeyHeld = !!on; }


  setBrowserBounds(bounds) {
    this.browserBounds = cleanBounds(bounds);
    this.#syncVisibility();
  }

  setChatBounds(bounds) {
    this.chatBounds = cleanBounds(bounds);
    this.#syncVisibility();
  }

  setBrowserVisible(on) {
    this.browserVisible = !!on;
    this.#syncVisibility();
    this.#emitState();
  }

  setChatVisible(on) {
    this.chatVisible = !!on;
    if (this.chatVisible && !this.chatLoaded) this.#loadChat();
    this.#syncVisibility();
    this.#emitState();
  }

  navigate(input) {
    this.url = normalizeAddress(input);
    this.browserLoaded = true;
    if (this.browserView) {
      this.browserView.webContents.loadURL(this.url).catch((e) => {
        this.browserLoaded = false;
        this.logger.error(`[browser] navigation failed: ${String(e)}`);
        this.#emitState({ error: String(e) });
      });
    }
    this.#emitState();
    return this.url;
  }

  back() {
    const h = this.browserView?.webContents?.navigationHistory;
    if (h?.canGoBack?.()) h.goBack();
  }

  forward() {
    const h = this.browserView?.webContents?.navigationHistory;
    if (h?.canGoForward?.()) h.goForward();
  }

  reload() { this.browserView?.webContents?.reload(); }
  stop() { this.browserView?.webContents?.stop(); }

  setChannel(value) {
    this.channel = cleanChannel(value);
    this.chatLoaded = false;
    if (this.chatVisible) this.#loadChat();
    this.#emitState();
    return this.channel;
  }

  suspendHidden() {
    // Hide native child views before the parent BrowserWindow is suspended for Config.
    try { this.browserView?.setVisible(false); } catch {}
    try { this.chatView?.setVisible(false); } catch {}
  }

  resume() { this.#syncVisibility(); }

  destroy() {
    for (const view of [this.browserView, this.chatView]) {
      if (!view) continue;
      try { this.parent?.contentView?.removeChildView?.(view); } catch {}
      try { view.webContents.close(); } catch {}
    }
    this.browserView = null;
    this.chatView = null;
    this.parent = null;
  }
}

module.exports = {
  BrowserWidgetController,
  DEFAULT_BROWSER_URL,
  normalizeAddress,
  twitchChannelFromUrl,
  cleanBounds,
};
