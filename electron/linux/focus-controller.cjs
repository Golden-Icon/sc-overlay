"use strict";

const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");

class LinuxFocusController {
  constructor({ logger = console, platform = process.platform } = {}) {
    this.logger = logger;
    this.platform = platform;
    this.restoreWindowId = null;
  }



  pointerLocation() {
    if (this.platform !== "linux") return null;
    try {
      const out = String(execFileSync("xdotool", ["getmouselocation", "--shell"], { encoding: "utf8", timeout: 1200, stdio: ["ignore", "pipe", "ignore"] }));
      const x = Number((out.match(/^X=(-?\d+)/m) || [])[1]);
      const y = Number((out.match(/^Y=(-?\d+)/m) || [])[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch { return null; }
  }

  activeWindowDetails() {
    if (this.platform !== "linux") return null;
    try {
      const id = String(execFileSync("xdotool", ["getactivewindow"], { encoding: "utf8", timeout: 1200, stdio: ["ignore", "pipe", "ignore"] })).trim();
      if (!/^\d+$/.test(id)) return null;
      const read = (args) => {
        try { return String(execFileSync("xdotool", args, { encoding: "utf8", timeout: 1200, stdio: ["ignore", "pipe", "ignore"] })).trim(); }
        catch { return ""; }
      };
      const title = read(["getwindowname", id]);
      const className = read(["getwindowclassname", id]);
      const pidText = read(["getwindowpid", id]);
      const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
      let cmdline = "";
      let comm = "";
      if (pid) {
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch {}
        try { comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch {}
      }
      return { id, title, className, pid, cmdline, comm };
    } catch { return null; }
  }

  detailsForWindowId(id) {
    if (this.platform !== "linux" || !/^\d+$/.test(String(id || ""))) return null;
    try {
      const read = (args) => {
        try { return String(execFileSync("xdotool", args, { encoding: "utf8", timeout: 1200, stdio: ["ignore", "pipe", "ignore"] })).trim(); }
        catch { return ""; }
      };
      const windowId = String(id);
      const title = read(["getwindowname", windowId]);
      const className = read(["getwindowclassname", windowId]);
      const pidText = read(["getwindowpid", windowId]);
      const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
      let cmdline = "";
      let comm = "";
      if (pid) {
        try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch {}
        try { comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch {}
      }
      return { id: windowId, title, className, pid, cmdline, comm };
    } catch { return null; }
  }

  detailsBlob(details) {
    return [details?.title, details?.className, details?.comm, details?.cmdline].filter(Boolean).join(" ");
  }

  isOwnOverlayWindow(details) {
    const blob = this.detailsBlob(details);
    return /sc-overlay-custom-linux|sc-blueprint-tracker|\bSC Overlay\b/i.test(blob);
  }

  findStarCitizenWindowId() {
    if (this.platform !== "linux" || !this.starCitizenProcessRunning()) return null;
    const ownId = this.activeWindowDetails()?.id || null;
    const candidates = new Set();
    const searches = [
      ["search", "--onlyvisible", "--name", "Star Citizen"],
      ["search", "--onlyvisible", "--class", "StarCitizen"],
      ["search", "--onlyvisible", "--classname", "StarCitizen"],
      ["search", "--onlyvisible", "--class", "gamescope"],
      ["search", "--onlyvisible", "--name", "gamescope"],
    ];
    for (const args of searches) {
      try {
        const out = String(execFileSync("xdotool", args, { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }));
        for (const id of out.split(/\s+/).filter((v) => /^\d+$/.test(v))) candidates.add(id);
      } catch {}
    }

    let wrapperFallback = null;
    for (const id of candidates) {
      if (id === ownId) continue;
      const d = this.detailsForWindowId(id);
      if (!d || this.isOwnOverlayWindow(d)) continue;
      const blob = this.detailsBlob(d);
      if (/rsi launcher/i.test(blob)) continue;
      if (/star[ _-]?citizen(?:_live)?(?:\.exe)?/i.test(blob) || /StarCitizen\/LIVE/i.test(blob)) return id;
      if (!wrapperFallback && /gamescope|wine|umu|steam_app|sdl|xwayland/i.test(blob)) wrapperFallback = id;
    }
    return wrapperFallback;
  }

  starCitizenProcessRunning() {
    if (this.platform !== "linux") return false;
    try {
      for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const cmd = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ");
          if (/star[ _-]?citizen(?:_live)?(?:\.exe)?/i.test(cmd) || /StarCitizen\/LIVE/i.test(cmd)) return true;
        } catch {}
      }
    } catch {}
    return false;
  }

  isStarCitizenDirectlyActive() {
    const running = this.starCitizenProcessRunning();
    const d = this.activeWindowDetails();
    if (!running || !d || this.isOwnOverlayWindow(d)) return false;
    const blob = this.detailsBlob(d);
    if (/rsi launcher/i.test(blob)) return false;
    return /star[ _-]?citizen(?:_live)?(?:\.exe)?/i.test(blob)
      || /StarCitizen\/LIVE/i.test(blob)
      || /gamescope|wine|umu|steam_app|sdl|xwayland/i.test(blob);
  }

  isStarCitizenActive() {
    const running = this.starCitizenProcessRunning();
    const d = this.activeWindowDetails();
    // Native Wayland can leave XWayland without a queryable active-window ID. In that case the
    // running game process is the best available signal and is preferable to silently disabling
    // the held-F interaction gesture.
    if (!d) return running;
    const blob = this.detailsBlob(d);
    if (/rsi launcher/i.test(blob)) return false;
    if (/star[ _-]?citizen(?:_live)?(?:\.exe)?/i.test(blob) || /StarCitizen\/LIVE/i.test(blob)) return true;
    // KWin may continue reporting our always-on-top XWayland toolbar as the active window even
    // while the game owns the real keyboard/mouse interaction underneath it. The r15 log exposed
    // this exact case. Treat our own overlay as a proxy for the running game instead of rejecting F.
    if (running && this.isOwnOverlayWindow(d)) return true;
    // Gamescope, Wine, UMU and SDL/XWayland wrappers may own the active surface without putting
    // Star Citizen in the X11 title/class. Accept those wrappers only while the game process runs.
    if (running && /gamescope|wine|umu|steam_app|sdl|xwayland/i.test(blob)) return true;
    // Some compositors expose an empty/root-like active X11 surface for a native-Wayland game.
    if (running && !blob.trim()) return true;
    return false;
  }

  captureActiveWindow() {
    if (this.platform !== "linux") return;
    try {
      const active = this.activeWindowDetails();
      // Do not save the overlay itself as the restoration target. When KWin reports the toolbar
      // as active while Star Citizen is underneath, locate the visible game/Gamescope window.
      if (active && this.isOwnOverlayWindow(active) && this.starCitizenProcessRunning()) {
        const gameId = this.findStarCitizenWindowId();
        if (gameId) this.restoreWindowId = gameId;
        // Keep an earlier valid external target when window search is temporarily unavailable.
        return;
      }
      this.restoreWindowId = active && /^\d+$/.test(String(active.id || "")) ? String(active.id) : null;
    } catch { this.restoreWindowId = null; }
  }

  x11WindowId(win) {
    if (this.platform !== "linux" || !win || win.isDestroyed()) return null;
    try { const m = String(win.getMediaSourceId()).match(/^window:(\d+):/); return m ? m[1] : null; } catch { return null; }
  }

  focus(win) {
    if (!win || win.isDestroyed()) return;
    const focusNow = () => {
      if (!win || win.isDestroyed()) return;
      try { win.show(); } catch {}
      try { win.focus(); } catch {}
      try { win.webContents.focus(); } catch {}
      try { win.moveTop(); } catch {}
    };
    focusNow();
    if (this.platform === "linux") {
      const force = () => {
        const id = this.x11WindowId(win); if (!id) return;
        try { const child = spawn("xdotool", ["windowactivate", "--sync", id], { detached: true, stdio: "ignore" }); child.unref(); } catch {}
      };
      setTimeout(() => { focusNow(); force(); }, 60);
      setTimeout(focusNow, 250);
    }
  }

  restore() {
    if (this.platform !== "linux" || !this.restoreWindowId) return;
    const id = this.restoreWindowId; this.restoreWindowId = null;
    try { const child = spawn("xdotool", ["windowactivate", "--sync", id], { detached: true, stdio: "ignore" }); child.unref(); } catch {}
  }
}

module.exports = { LinuxFocusController };
