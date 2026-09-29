// Linux replacement for electron/foreground.cjs.
//
// 🔑 WHY THIS EXISTS. foreground.cjs is a thin client over the Windows PowerShell helper that
// calls GetForegroundWindow. On Linux the equivalent is KWin, and the shape of the answer is the
// same ({ name, rect }) so capture.cjs needs no changes beyond picking a provider. The gap
// closed here is a platform one, not a feature one: without it, the Linux capture path — which
// grabs the whole OUTPUT because Chromium cannot see a native-Wayland window through XWayland
// (see capture-linux.cjs) — has no way to know whether the pixels it just grabbed are the game.
// It would OCR whatever is on screen and report it as a scan.
//
// The API mirrors foreground.cjs exactly: want/stop/foreground/ready/gameInFront/onChange. The
// point of mirroring rather than refactoring is that capture.cjs then has one call site and the
// Windows behaviour is untouched.
//
// How it gets the answer: load electron/kwin-foreground.qml into kwin_wayland through
// org.kde.KWin.Scripting, and tail the user journal for that script's output. See the QML for
// why a script and why the journal.

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Matches the game's own identifier as KWin reports it. Deliberately NOT "wine": on this setup
 *  the game runs under the LUG Wine runner, so the process is wine and matching it would fire the
 *  reader for every Wine application open. `starcitizen.exe` is what resourceClass actually
 *  contains. */
const GAME_RE = /starcitizen/i;
const MARK = "SCFG1|";
/** Our own KWin script name. Loading it twice would double every line in the journal, so the
 *  host unloads any previous instance by this name before loading. */
const PLUGIN = "sc-overlay-foreground";
const QML = path.join(__dirname, "kwin-foreground.qml");

let current = { name: "", rect: null };
let everRead = false;
let stopped = false;
let tail = null;         // journalctl -f child
let loadedByUs = false;  // only unload the script if we were the ones who loaded it
const listeners = [];
const wanted = new Set();

function parseLine(raw) {
  const line = String(raw).trim();
  if (!line.startsWith(MARK)) return false;
  const body = line.slice(MARK.length);
  if (body === "__ready__") { everRead = true; emit(); return true; }
  // name can be empty (a client with no resourceClass and no caption), so the name is
  // everything up to the FIRST pipe and the four numbers are positional after it.
  const firstPipe = body.indexOf("|");
  if (firstPipe < 0) return false;
  const name = body.slice(0, firstPipe);
  const p = body.slice(firstPipe + 1).split("|");
  const x = +p[0], y = +p[1], w = +p[2], h = +p[3];
  const rect = w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
  // Only report a CHANGE. The QML already filters, but a repeated identical line would still
  // wake the capture loop and re-run a tick for a window that did not move.
  if (name === current.name
    && ((!rect && !current.rect) || (rect && current.rect
      && rect.x === current.rect.x && rect.y === current.rect.y
      && rect.width === current.rect.width && rect.height === current.rect.height))) {
    return true;
  }
  current = { name, rect };
  everRead = true;
  emit();
  return true;
}

function emit() { for (const cb of listeners) { try { cb(current); } catch { /* listener's problem */ } } }

/** Ask the user journal for lines newer than right now, then follow it. */
function startTail() {
  // --since "now" is what keeps a restart from replaying the whole journal: without it every
  // launch would re-emit every focus change the machine has ever made, and the first one
  // processed would be an arbitrary old window rather than the real current one.
  const args = ["--user", "-f", "-o", "cat", "--since", "now"];
  try {
    tail = spawn("journalctl", args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch { tail = null; return; }
  let buf = "";
  tail.stdout?.on("data", (d) => {
    buf += String(d);
    // KWin's print() emits one line per call, but a read can land mid-line, so hold a partial
    // tail back until its newline arrives.
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const l of lines) { if (stopped) return; parseLine(l); }
  });
  tail.on("error", (e) => {
    console.warn(`[fg-linux] could not read the user journal (${e && e.message}); foreground detection is unavailable`);
    tail = null;
  });
}

function dbus(args) {
  return new Promise((done) => {
    try {
      execFile("qdbus6", args, { timeout: 5000, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${process.env.XDG_RUNTIME_DIR || "/run/user/1000"}/bus` } },
        (err, out) => done(err ? null : String(out).trim()));
    } catch { done(null); }
  });
}

async function loadScript() {
  if (stopped) return;
  if (!fs.existsSync(QML)) {
    console.warn(`[fg-linux] ${QML} is missing; foreground detection is unavailable`);
    return;
  }
  // Drop a previous instance first — a crashed host leaves its script loaded, and a second copy
  // would double every line in the journal.
  await dbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", PLUGIN]);
  const id = await dbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", QML, PLUGIN]);
  if (id === null) {
    console.warn("[fg-linux] KWin refused the script (org.kde.KWin.Scripting unavailable — is this a KWin session?)");
    return;
  }
  loadedByUs = true;
  await dbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"]);
}

function halt() {
  if (tail) { try { tail.kill("SIGTERM"); } catch { /* gone */ } tail = null; }
  if (loadedByUs) {
    // Fire-and-forget: this runs on the shutdown path, where awaiting a D-Bus round trip is not
    // worth blocking app exit for. A leftover script is inert — it only prints on focus change.
    dbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", PLUGIN]);
    loadedByUs = false;
  }
}

function start() {
  if (stopped || tail) return;
  startTail();
  loadScript();
}

/** Declare whether a feature needs foreground tracking. The helper runs only while at least one
 *  reason is live, so a player who never mines never pays for it. Mirrors foreground.cjs. */
function want(reason, on) {
  if (on) wanted.add(reason); else wanted.delete(reason);
  if (wanted.size > 0) { stopped = false; start(); } else { stop(); }
}

function stop() {
  stopped = true;
  halt();
  // Reset so a later want() re-runs loadScript: the script was unloaded in halt().
  tail = null;
}

/** Last known foreground window: { name, rect }. `name` is "" until the compositor answers. */
function foreground() { return current; }
function ready() { return everRead; }
function gameInFront() { return GAME_RE.test(current.name); }
function onChange(cb) { if (typeof cb === "function") listeners.push(cb); }

module.exports = { want, stop, foreground, ready, gameInFront, onChange, GAME_RE };
