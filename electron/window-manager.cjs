"use strict";

// Native Linux window-management facade. Physical display discovery and focus ownership are
// deliberately isolated in electron/linux so future upstream merges do not touch widget code.

const { buildLayout, parseKScreenDoctor, parseXRandRListMonitors, parseXRandRQuery, rectUnion } = require("./linux/desktop-layout.cjs");
const { LinuxFocusController } = require("./linux/focus-controller.cjs");

class OverlayWindowManager {
  constructor({ BrowserWindow, screen, app, env = process.env, logger = console } = {}) {
    if (!BrowserWindow || !screen) throw new Error("OverlayWindowManager requires Electron BrowserWindow and screen");
    this.BrowserWindow = BrowserWindow;
    this.screen = screen;
    this.app = app || null;
    this.env = env;
    this.logger = logger;
    this._layout = null;
    this._windows = new Map();
    this._displayHooksInstalled = false;
    this._suspendedCanvasBounds = new Map();
    this.focus = new LinuxFocusController({ logger });
  }

  detect({ refresh = false } = {}) {
    if (this._layout && !refresh) return this._layout;
    this._layout = buildLayout({ screen: this.screen, env: this.env });
    return this._layout;
  }

  invalidate() { this._layout = null; }
  canvasBounds() { return { ...this.detect().canvas }; }
  primaryBounds() { const p = this.detect().primary; return { x: p.x, y: p.y, width: p.width, height: p.height }; }
  defaultZone() { return { ...this.detect().defaultZone }; }

  canvasInfo() {
    const { source, monitors, desktop, primary, canvas, defaultZone } = this.detect();
    return {
      source, layoutVersion: 3,
      vx: canvas.x, vy: canvas.y, vw: canvas.width, vh: canvas.height,
      px: primary.x - canvas.x, py: primary.y - canvas.y, pw: primary.width, ph: primary.height,
      dx: defaultZone.x, dy: defaultZone.y, dw: defaultZone.width, dh: defaultZone.height,
      desktop: { ...desktop },
      monitors: monitors.map((m) => ({
        name: m.name, id: m.id, primary: !!m.primary,
        x: m.x - canvas.x, y: m.y - canvas.y, width: m.width, height: m.height,
        globalX: m.x, globalY: m.y,
      })),
    };
  }

  logLayout() {
    const { source, monitors, desktop, primary, canvas, defaultZone } = this.detect();
    this.logger.log(`[window-manager] source=${source}; desktop ${desktop.width}x${desktop.height}+${desktop.x}+${desktop.y}`);
    for (const m of monitors) this.logger.log(`[window-manager] monitor ${m.name}${m.primary ? " (primary)" : ""}: ${m.width}x${m.height}+${m.x}+${m.y}`);
    this.logger.log(`[window-manager] canvas ${canvas.width}x${canvas.height}+${canvas.x}+${canvas.y}; primary ${primary.width}x${primary.height}+${primary.x}+${primary.y}; default zone ${defaultZone.width}x${defaultZone.height}+${defaultZone.x}+${defaultZone.y}`);
  }

  baseCanvasWindowOptions({ preload, webPreferences = {} } = {}) {
    const bounds = this.canvasBounds();
    return {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: true, backgroundColor: "#00000000", show: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, fullscreenable: false,
      focusable: true,
      type: process.platform === "linux" ? "toolbar" : undefined,
      webPreferences: { contextIsolation: true, preload, ...webPreferences },
    };
  }

  createCanvasWindow(name, options = {}) {
    const win = new this.BrowserWindow(this.baseCanvasWindowOptions(options));
    this.register(name, win);
    this.pin(win);
    return win;
  }

  register(name, win) {
    if (!name || !win) return;
    this._windows.set(name, win);
    win.once("closed", () => { if (this._windows.get(name) === win) this._windows.delete(name); });
  }

  pin(win) {
    if (!win || win.isDestroyed()) return;
    try { win.setAlwaysOnTop(true, "screen-saver"); } catch { try { win.setAlwaysOnTop(true); } catch {} }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  }

  setPassthrough(win, passthrough) {
    if (!win || win.isDestroyed()) return;
    try {
      if (process.platform === "linux") win.setIgnoreMouseEvents(!!passthrough);
      else win.setIgnoreMouseEvents(!!passthrough, { forward: true });
    } catch (e) { this.logger.error(`[window-manager] setIgnoreMouseEvents failed: ${String(e)}`); }
    if (process.platform !== "linux") { try { win.setFocusable(!passthrough); } catch {} }
    if (passthrough) { try { win.blur(); } catch {} }
  }

  // Electron's Linux BrowserWindow.setShape() clips both the input region and the visual
  // drawing surface. Using an empty shape therefore makes the transparent HUD completely
  // invisible. Keep the normal rectangular drawing surface and control click-through solely
  // with setIgnoreMouseEvents().
  setInteractiveRegions(win, _rects = []) {
    if (!win || win.isDestroyed()) return;
    try { win.setIgnoreMouseEvents(false); }
    catch (e) { this.logger.error(`[window-manager] setInteractiveRegions failed: ${String(e)}`); }
  }

  clearInteractiveRegions(win, { passthrough = true } = {}) {
    if (!win || win.isDestroyed()) return;
    try {
      if (process.platform === "linux") win.setIgnoreMouseEvents(!!passthrough);
      else win.setIgnoreMouseEvents(!!passthrough, { forward: true });
    } catch (e) { this.logger.error(`[window-manager] clearInteractiveRegions failed: ${String(e)}`); }
    if (passthrough) { try { win.blur(); } catch {} }
  }

  captureActiveWindow() { this.focus.captureActiveWindow(); }
  isStarCitizenActive() { return this.focus.isStarCitizenActive(); }
  isStarCitizenDirectlyActive() { return this.focus.isStarCitizenDirectlyActive(); }
  isOwnOverlayWindow(details) { return this.focus.isOwnOverlayWindow(details); }
  activeWindowDetails() { return this.focus.activeWindowDetails(); }
  pointerLocation() { return this.focus.pointerLocation(); }
  focusWindow(win) { this.focus.focus(win); }
  restorePreviousWindow() { this.focus.restore(); }

  _setAndLog(name, win, requested) {
    if (!win || win.isDestroyed()) return;
    try {
      win.setBounds(requested);
      const actual = win.getBounds();
      this.logger.log(`[window-manager] ${name} mapped ${actual.width}x${actual.height}+${actual.x}+${actual.y}; requested ${requested.width}x${requested.height}+${requested.x}+${requested.y}`);
    } catch (e) { this.logger.error(`[window-manager] ${name} bounds failed: ${String(e)}`); }
  }

  reassertCanvasWindow(name, win) {
    if (!win || win.isDestroyed()) return;
    const bounds = this.canvasBounds();
    this.pin(win);
    for (const delay of [0, 250, 1000]) setTimeout(() => this._setAndLog(name, win, bounds), delay);
    setTimeout(() => {
      if (!win || win.isDestroyed() || win.webContents?.isDestroyed?.()) return;
      win.webContents.executeJavaScript('({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio})', true)
        .then((v) => this.logger.log(`[window-manager] ${name} content ${v.w}x${v.h} dpr=${v.dpr}`)).catch(() => {});
    }, 600);
  }

  showCanvasWindow(name, win, { inactive = true } = {}) {
    if (!win || win.isDestroyed()) return;
    const bounds = this.canvasBounds();
    this.pin(win);
    try { win.setBounds(bounds); } catch {}
    try { inactive ? win.showInactive() : win.show(); } catch {}
    this.reassertCanvasWindow(name, win);
  }

  // KWin may remap a hidden toolbar-type BrowserWindow at the primary monitor origin.
  // Preserve the intended virtual-desktop bounds before hiding it, then reapply them
  // immediately after it is shown and several more times while XWayland finishes mapping.
  suspendCanvasWindow(name, win) {
    if (!name || !win || win.isDestroyed()) return false;
    const requested = this.canvasBounds();
    this._suspendedCanvasBounds.set(name, requested);
    try { win.setBounds(requested); } catch {}
    try { win.hide(); return true; } catch { return false; }
  }

  resumeCanvasWindow(name, win, { inactive = true, reason = "resume" } = {}) {
    if (!name || !win || win.isDestroyed()) return false;
    const requested = this._suspendedCanvasBounds.get(name) || this.canvasBounds();
    this._suspendedCanvasBounds.delete(name);
    this.pin(win);
    try { win.setBounds(requested); } catch {}
    try { inactive ? win.showInactive() : win.show(); } catch {}

    // Some KWin/XWayland remaps happen after showInactive() returns. Correct both the
    // immediate shift and any delayed compositor adjustment without changing widget data.
    this._setAndLog(`${name} ${reason}`, win, requested);
    for (const delay of [50, 250, 750, 1500]) {
      setTimeout(() => this._setAndLog(`${name} ${reason}`, win, requested), delay);
    }
    setTimeout(() => {
      if (!win || win.isDestroyed() || win.webContents?.isDestroyed?.()) return;
      win.webContents.executeJavaScript('({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio})', true)
        .then((v) => this.logger.log(`[window-manager] ${name} ${reason} content ${v.w}x${v.h} dpr=${v.dpr}`))
        .catch(() => {});
    }, 600);
    return true;
  }

  refitAll({ refresh = true } = {}) {
    if (refresh) this.invalidate();
    const bounds = this.canvasBounds();
    for (const [name, win] of this._windows.entries()) if (win && !win.isDestroyed()) this._setAndLog(name, win, bounds);
  }

  installDisplayHooks() {
    if (this._displayHooksInstalled) return;
    this._displayHooksInstalled = true;
    const update = () => setTimeout(() => { this.invalidate(); this.logLayout(); this.refitAll({ refresh: false }); }, 500);
    this.screen.on("display-added", update);
    this.screen.on("display-removed", update);
    this.screen.on("display-metrics-changed", update);
  }
}

module.exports = { OverlayWindowManager, parseKScreenDoctor, parseXRandRListMonitors, parseXRandRQuery, rectUnion };
