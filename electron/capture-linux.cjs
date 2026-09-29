// Linux screen capture for the mining/fabricator reader.
//
// 🔑 WHY THIS FILE EXISTS AT ALL. On Windows, capture.cjs calls Electron's desktopCapturer
// directly. On this box that returns a PURE BLACK frame: Star Citizen runs as a NATIVE Wayland
// window (LUG/Wayland runner), the overlay is an X11 client under XWayland, and Chromium's
// X11 capture path cannot see a compositor surface it does not own. Measured: 3840x1607 frame,
// exactly 1 unique colour. The reader then finds no text, classifies nothing, and the only
// visible symptom is "mining does nothing" — with capture, OCR and classification all innocent.
//
// So on Linux the frame comes from the compositor instead, which CAN see every surface:
// KDE's own `spectacle` in batch mode. Verified on this machine: same scene, 302,263 unique
// colours, real HUD text, tesseract reads it in ~220ms.
//
// The tradeoff is explicit and worth stating: spectacle grabs the whole OUTPUT, so this captures
// whatever is on screen, not just the game. That is why foreground detection is not optional
// here — the reader must only run when the game is actually in front, or it will OCR the
// desktop and the chat window. Windows gets this for free from GetForegroundWindow; Linux gets
// it from KWin's scripting interface (see foreground-linux.cjs).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** How long to wait for spectacle. It is a Qt app that has to connect to the compositor over
 *  D-Bus before it grabs; on this machine a cold start to written file measured ~1.2s. 8s is
 *  generous but still well inside the capture loop's own 15s watchdog — a timeout here would
 *  otherwise stack on top of the loop's and wedge a tick. */
const CAPTURE_TIMEOUT_MS = 8000;

/** Reused across ticks. spectacle is told -b -n (background, no notifications) so this is silent,
 *  but a fresh file per tick is still cheap insurance against a half-written PNG being read. */
let seq = 0;
function nextFramePath() {
  seq += 1;
  return path.join(os.tmpdir(), `sc-linux-capture-${process.pid}-${seq}.png`);
}

/** The environment a GUI Qt app needs to reach the compositor.
 *
 *  🔑 This is the single most important line in the file. Run from a plain terminal or from a
 *  service with a partial environment, spectacle dies with SIGSEGV (observed: "dumped core",
 *  no output, exit 0) because it never reaches the display. With these four set it captures
 *  correctly. Anything spawning spectacle — including anything that forgets to forward the
 *  launcher's env — must go through here. */
function sessionEnv() {
  const env = { ...process.env };
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`;
  env.XDG_RUNTIME_DIR = runtime;
  if (!env.WAYLAND_DISPLAY) {
    // Read the compositor socket rather than assuming wayland-0: the number varies with
    // compositor restarts, and a stale WAYLAND_DISPLAY fails the same silent way as none at all.
    try {
      const socks = fs.readdirSync(runtime).filter((f) => /^wayland-\d+$/.test(f));
      if (socks.length) env.WAYLAND_DISPLAY = socks[0];
    } catch { /* leave unset; spectacle will report the real problem */ }
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`;
  }
  // XWayland display for the overlay's own X11 windows; spectacle needs it to find the X root.
  if (!env.DISPLAY) env.DISPLAY = ":0";
  return env;
}

/** Grab the primary display to a PNG on disk. Resolves to the path, or null on any failure.
 *
 *  -f  full screen (all of the output, no window guessing)
 *  -b  background: take the shot and exit without opening the GUI
 *  -n  no notification/flash, so this is invisible to a player mid-flight
 */
function grabPng(outPath) {
  return new Promise((done) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; done(v); } };

    let child;
    try {
      child = spawn("spectacle", ["-b", "-n", "-f", "-o", outPath], {
        env: sessionEnv(),
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch { finish(null); return; }

    let stderr = "";
    child.stderr?.on("data", (d) => { if (stderr.length < 2000) stderr += String(d); });

    // Hard kill rather than trusting spectacle to exit. A wedged Qt app that outlives its own
    // tick would accumulate one process per capture and eventually wedge the compositor.
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(null);
    }, CAPTURE_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      if (e && e.code === "ENOENT") {
        console.warn("[linux-capture] spectacle not found — install KDE Spectacle (package: spectacle)");
      } else {
        console.warn(`[linux-capture] spectacle failed to start: ${e && e.message}`);
      }
      finish(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // A non-zero exit with no file is the compositor refusing the grab (another fullscreen
      // exclusive client, or a DRM lease held by the game). Not fatal — the loop retries.
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        if (code !== 0) {
          console.warn(`[linux-capture] spectacle exited ${code}${stderr ? `: ${stderr.trim().slice(0, 160)}` : ""}`);
        }
        finish(null);
        return;
      }
      finish(outPath);
    });
  });
}

/** The one function capture.cjs calls, shaped exactly like the desktopCapturer result it
 *  replaces: `{ image, width, height, onPrimary }` where `image` is an Electron nativeImage.
 *
 *  `winRect` selects the monitor the game is on, mirroring the Windows path's
 *  screen.getDisplayMatching(). On a single-output setup (the common case) that is the primary
 *  display and spectacle's full-screen grab is already it.
 */
async function captureGameLinux(winRect, { nativeImage, screen }) {
  const out = nextFramePath();
  const pngPath = await grabPng(out);
  if (!pngPath) return null;
  try {
    const image = nativeImage.createFromPath(pngPath);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    // onPrimary: the calibration box is drawn on the PRIMARY display only, so a frame from
    // another monitor cannot be calibrated against pixels the player can see. Same contract as
    // the Windows path.
    const disp = winRect ? screen.getDisplayMatching(winRect) : screen.getPrimaryDisplay();
    return { image, width: size.width, height: size.height, onPrimary: disp.id === screen.getPrimaryDisplay().id };
  } catch (e) {
    console.warn(`[linux-capture] could not decode frame: ${e && e.message}`);
    return null;
  } finally {
    // The PNG is a scratch artefact a few MB in size, on a 900ms-3s tick. Never let it pile up.
    try { fs.unlinkSync(pngPath); } catch { /* already gone */ }
  }
}

/** True when this box needs the Linux capture path. Kept as a function (not a module-load-time
 *  constant) so tests and the probe can ask without the side effects of importing electron. */
function needsLinuxCapture() {
  return process.platform === "linux";
}

module.exports = { captureGameLinux, needsLinuxCapture, grabPng, sessionEnv, CAPTURE_TIMEOUT_MS };
