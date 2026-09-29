// Reports the focused window to the host on every change, via the compositor's own log.
//
// WHY A SCRIPT RATHER THAN A D-BUS QUERY. KWin exposes org.kde.KWin.queryWindowInfo() and
// getWindowInfo(), but queryWindowInfo() is an INTERACTIVE picker — it opens a click-to-select
// UI and blocks on a reply, which is useless for a background watcher and would flash a window
// on the player's screen mid-flight. getWindowInfo() needs a window name up front and so cannot
// answer "what is focused right now". The scripting API can, so this is the script that asks.
//
// WHY `print()` AND THE JOURNAL. A KWin script runs INSIDE kwin_wayland, so its print() lands in
// the compositor's log, not on a pipe the app can read. Rather than stand up a D-Bus service
// (a second moving part, and a bus name to own) the host tails the user journal for this
// script's marker. Verified on this machine: `kwin_wayland` output is readable via
// `journalctl --user`, and the line arrives well inside a capture tick.
//
// 🔑 KWin is the only authority that can answer this on this setup. The game is a native Wayland
// client, so xprop/xdotool see only XWayland windows and would report the overlay (or nothing).
// Asking the compositor which client holds focus is the question with the right answer.
//
// Protocol: `SCFG1|name|x|y|w|h` on each change. The SCFG1 prefix is this script's marker: the
// journal is a shared stream carrying every KWin script's output, so without a unique prefix
// another script's print() would be parsed as a focus report.

var MARK = "SCFG1|";
var last = "";

function describe(client) {
    if (!client) return MARK + "||0|0|0|0";
    // resourceClass is the app's own identifier. On this setup the game reports
    // "starcitizen.exe" — which is the point of matching on it rather than on the process name:
    // the process is `wine`, and matching "wine" would fire the reader for every Wine app on the
    // machine. caption ("Star Citizen") is kept as a fallback for clients that set no class.
    var name = "";
    try {
        if (client.resourceClass) name = String(client.resourceClass);
        if (!name && client.caption) name = String(client.caption);
    } catch (e) { name = ""; }
    var x = 0, y = 0, w = 0, h = 0;
    try {
        var g = client.frameGeometry ? client.frameGeometry : client.geometry;
        if (g) { x = g.x; y = g.y; w = g.width; h = g.height; }
    } catch (e) { /* leave zeros; a null rect just means "unknown monitor" */ }
    return MARK + name + "|" + x + "|" + y + "|" + w + "|" + h;
}

function emit() {
    var line = describe(workspace.activeClient || workspace.activeWindow);
    // Only on change. Without this, workspace signals would emit many times a second for a
    // window that has not moved, and the host would re-parse the same fact on every one.
    if (line !== last) {
        last = line;
        print(line);
    }
}

// 🔑 Report BEFORE connecting, and connect through a guard. Two KWin versions ago the connects
// lived above this line and the script was silent on KWin 6, because `numberDesktopsChanged` no
// longer exists there: evaluating it threw, which aborted the rest of the script — including the
// initial emit() and the ready marker — so the host waited forever for a watcher that had
// loaded successfully and was doing nothing. Connecting first meant "loads fine" and "works" were
// not the same thing. Emitting first, and tolerating a signal this KWin does not have, makes
// them the same thing again.
emit();
print(MARK + "__ready__");

// Only signals verified to exist on KWin 6 are connected, and each is connected defensively so a
// future removal degrades to "one less trigger" instead of "no watcher at all".
["clientActivated", "currentDesktopChanged", "screensChanged"].forEach(function (sig) {
    try {
        if (workspace[sig]) workspace[sig].connect(emit);
    } catch (e) {
        print(MARK + "warn|skipped signal " + sig);
    }
});
