# SC Overlay

<p align="center">
  <img src="build/icon.png" alt="SC Overlay blueprint tracker logo" width="180" />
</p>

SC Overlay is a desktop companion for Star Citizen. It started as a log watcher, but it has grown into a full in-game overlay built out of widgets you place, size and stack wherever you want them — mission and blueprint tracking, mining, and a few quality-of-life helpers that make the game feel less like a spreadsheet and more like a tool you actually use.

You can try the widgets in your browser, without installing anything: **[sc-overlay.subliminal.gg](https://sc-overlay.subliminal.gg)** runs the real ones.

This project is designed to be practical first and transparent second. If a feature needs extra processing, OCR, or a server-side handoff, it is opt-in and clearly separated from the local-first experience.

## What it does

The overlay is one transparent canvas across your monitors. Drag a widget where you want it, pull its corner to size it, and drop one onto another to stack them as tabs in a shared frame. Ten of them:

- **Mission & BP Tracker** — follow the mission you are currently tracking, see its blueprint pool with your real drop odds, and mark what you have already collected.
- **Mining Scanner** — reads the scan signature and names the deposit, calls out the ones you asked it to watch for, and counts your refinery jobs down with an alarm when they land.
- **Event Tracker** — your standing with a mission giver, the rank ladder above you, and which rank-gated ships sit at the top of it.
- **Unlock Alerts** — a blueprint unlock, with its picture, wherever on screen you actually look. Invisible until something drops.
- **Loot Split** — split a haul by SCU rather than by aUEC, price it from bundled commodity data, and save the split for the day the ore actually sells.
- **Journal** — scratch notes you can type into without leaving the game.
- **Twitch Chat** — any channel's live chat, rendered in the overlay's own styling. Sign in and you can reply without leaving the game; reading needs no account.
- **SC Feed** — Star Citizen news that surfaces when something breaks, then gets out of the way.
- **Infographic Viewer** — your own control chart, or any image, on a hotkey.
- **Web Page** — whatever site you keep checking, pinned over the game. Including the ones that refuse to be embedded anywhere else: the RSI site, UEX, erkul.

Plus:

- **Sixteen skins**, fifteen of them drawn from a manufacturer's own cockpit. Leave it on auto and the overlay matches whatever ship you are flying.
- **Fabricator helper**: optional OCR can identify a fabrication kiosk item and help build a capture for the blueprint catalog.
- **Optional sync**: if you enable it, the app can send data to my servers for account-based or collection-related features.
- Free, and it updates itself.

## Privacy and opt-in

This matters.

- OCR features are opt-in. They are not enabled by default.
- Any feature that sends data to my servers is opt-in. If you do not enable it, nothing leaves your machine.
- The core experience is local-first. The overlay can work without sending your data anywhere.
- If you do not want a feature, leave it off. That is the intended default.

In plain English: if you want the extra automation, you turn it on. If you do not, the app still works and stays local.

## How it works

The app watches Star Citizen's game log and turns it into structured events. Those events feed the overlay UI, which can surface mission info, blueprint progress, and other helpers while you play.

Optional OCR can be enabled when you want help reading fabrication screens. That is a separate path from the local mission-tracking experience.

## Quick start

Requirements:

- Windows, **or Linux** (see [Running on Linux](#running-on-linux) — the build is community-maintained, not shipped as an installer)
- Star Citizen installed and running

Install the desktop app:

- Download the latest installer from [sc-overlay.subliminal.gg](https://sc-overlay.subliminal.gg), or from the releases page here.
- Run the installer and follow the setup prompts. The installer is unsigned, so Windows SmartScreen will warn you — More info, then Run anyway.
- Launch the app and keep Star Citizen running while you use it.

The app checks for updates on its own, so this is a one-time install.

## Running on Linux

This is a community port, maintained on `main`. It is not an official build and there is no `.deb` —
you run it from source. It targets a **native Wayland** session (KDE Plasma / KWin) with the game
running under Wine via LUG Wine's experimental Wayland runner, so the game presents as a
Wayland-native window.

### Requirements

```bash
sudo apt install tesseract-ocr imagemagick spectacle   # tesseract + ImageMagick + KWin capture
```

- **tesseract** is the OCR engine. It shells out to the `tesseract` binary, so it is a system
  package and is deliberately *not* an npm dependency. Without it every OCR feature fails silently.
- **ImageMagick** (`magick`) does the cropping, binarising and polarity normalisation.
- **spectacle**, part of KDE, is what actually grabs the frame.

### First-time setup

From a fresh clone — this is everything, in order:

```bash
sudo apt install tesseract-ocr imagemagick spectacle   # system deps, see Requirements above
npm install                                             # Electron, tsx, everything else
./sc-overlay-linux.sh start
```

`npm install` is not optional and there is no build step: the app runs from source via `tsx`, so
there is nothing to compile. Expect the first `npm install` to take a few minutes.

### Running it

Use the launcher rather than calling Electron directly — it sets the display environment that
Wayland requires:

```bash
./sc-overlay-linux.sh start     # start the app and the sidecar
./sc-overlay-linux.sh toggle    # show/hide the overlay canvas
./sc-overlay-linux.sh stop
```

### The widget page

The sidecar serves a page with every widget on it at `http://localhost:8778/`. It is a **control
surface, not a control for the overlay**: the widgets are live and usable there, but ticking one
does not make it appear in-game and unticking it does not hide it in-game. Those stay separate.

It is served on all interfaces, so you can open it from a phone, tablet or second PC on the same
network at `http://<this-machine's-ip>:8778/`. Panels can be moved, resized, scaled and stacked
behind each other; that layout is remembered by the browser that arranged it, in `localStorage`,
and is never written to the server.

### Things that will otherwise waste your time

**The overlay is forced onto X11, even though your session is Wayland.** Click-through needs a real
X11 window, and the game is native Wayland. The launcher sets:

```bash
ELECTRON_OZONE_PLATFORM_HINT=x11
DISPLAY=:0
WAYLAND_DISPLAY=wayland-0
XAUTHORITY=/run/user/1000/xauth_XXXXXX   # auto-detected by the launcher
```

If you launch Electron by hand without these, the canvas either will not map or will swallow every
click.

**`desktopCapturer` returns a solid black frame.** Under XWayland it cannot see the game's window —
the game is native Wayland. This is why capture goes through `spectacle` instead. Do not "fix" this
by switching to `desktopCapturer`; it is not a bug, it is the wrong API for this setup.

**RapidOCR must never load on Linux.** `@gutenye/ocr-node` pulls in `sharp@0.33.5`, which aborts
the entire Electron process on import — and it does so on the *first mining tick* when the game
first gains focus. If the app dies the moment you aim at a rock, this is why. The capture loop
gates it off on Linux deliberately.

**Foreground detection runs through a KWin script, not an X11 hook.** `electron/kwin-foreground.qml`
is loaded over the `/Scripting` D-Bus interface and reports the focused window as `SCFG1|name|x|y|w|h`.
It must match `starcitizen.exe` — **never bare `wine`**, or every Wine app on your system counts as
the game and the gate opens when it should not.

**`spectacle` needs the full session environment.** `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`,
`DBUS_SESSION_BUS_ADDRESS` and `DISPLAY` must all be set, or it segfaults instead of failing
cleanly. `electron/capture-linux.cjs`'s `sessionEnv()` exists for this.

### Configuring the scan read area

This is the setting that decides whether the mining scanner works at all.

Open the **Mining Scanner** widget, then its cog, and tick **"Show the scan read area."** A
draggable box appears on the overlay. Drag it over the scan rating and it saves.

- A **stale saved region fails silently** — the app reports `scan: null` and gives no error, because
  from its point of view there is simply nothing in the box. If the scanner never reads, check this
  first before suspecting OCR.
- You must be **within mining beam range** (tens of metres) and **actually scanning**. Looking at a
  distant marker draws a distance readout, not a signature, so there is legitimately nothing to
  read.
- The signature lookup is exact, so a single misread digit sends you to the wrong rock with total
  confidence. That is why tesseract's 100% accuracy on confusable digits matters and is tested.

### Hotkeys

`holdToInteract` is **opt-in and defaults to `false`**. Until you turn it on in the config, the
interact key (default `F`) does nothing at all — the handler returns immediately. This is
intentional, so the overlay never eats a click during play, but it reads as a broken hotkey.

On Wayland the ordinary X11 key hook is blind while the *native Wayland* game holds focus, so there
is an evdev fallback that reads `/dev/input/event*` directly. It requires no extra permission on
most systems, since the input group normally owns those devices. If hold-to-interact does not work,
check the startup log:

```
[linux-interact] F: uiohook=ok evdev=ok
```

If in-game `F3` does not toggle the overlay, that is expected on Wayland — X11 never sees the
keypress. Bind a desktop shortcut to `./sc-overlay-linux.sh toggle` instead, which is what the
`--toggle-overlay` second-instance handler in `electron/main.cjs` exists for.

## Development notes

If you are working from source or building the project yourself, install the following first:

- Node.js
- npm

Then install dependencies:

```bash
npm install
```

Useful commands:

```bash
npm run build
npm run typecheck
npm run overlay-app
```

If you want to run the server-side overlay pieces separately:

```bash
npm run overlay
```

## Project status

This repository is public for transparency and to accept contributions.

If you want to contribute, the best path is to keep the changes aligned with the project's current direction: useful, local-first, and transparent. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

SC Overlay is **source-available**, not open source. It is licensed under the [Functional Source License 1.1 with an MIT future licence (FSL-1.1-MIT)](LICENSE.md).

In short: you may read, modify, fork and share the code, run your own build, and publish a **free** port to a platform this project does not support — a community Linux build is expressly fine. What you may not do is ship it inside a commercial product or service that substitutes for SC Overlay. Two years after each release, that version becomes MIT automatically.

**Ports and forks are welcome.** Only Windows is officially supported and tested; if you build for another OS, please give it its own name and say plainly that it is an unofficial community build.

**Names and logos are not licensed.** "SubliminalsTV", "SC Overlay", and the project's artwork are not covered by the licence — a fork needs its own branding. Star Citizen®, Roberts Space Industries® and Cloud Imperium® are registered trademarks of Cloud Imperium Rights LLC; this is an unofficial fan project.

If you want to do something the licence does not allow, ask: <sub@subliminal.gg>.
