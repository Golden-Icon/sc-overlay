// Probe: can Electron grab a real frame on this Wayland/KDE + LUG-Wayland-game box,
// and can tesseract read the SC HUD's scan text? Writes a PNG, prints its size.
//
//   npx electron tools/ocr-probe.cjs
const { app, desktopCapturer, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const OUT = process.env.PROBE_OUT || "/tmp/opencode/ocr-probe.png";
// The game's scan box, as fraction of the display, from ~/sc-blueprint-tracker/config.json
const REGION = process.env.PROBE_REGION
  ? JSON.parse(process.env.PROBE_REGION)
  : { x: 0.2872674418604651, y: 0.06486111111111112, w: 0.34, h: 0.22499999999999998 };

app.whenReady().then(async () => {
  try {
    const displays = screen.getAllDisplays();
    console.log("displays:", JSON.stringify(displays.map((d) => ({
      id: d.id, primary: d.primary, scale: d.scaleFactor,
      b: d.bounds, w: d.workArea,
    }))));

    // 1. Can we capture a display at all?
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 3840, height: 2160 },
      fetchWindowIcons: false,
    });
    console.log("screen sources:", sources.length);
    if (!sources.length) throw new Error("no screen sources — capture unavailable on this platform/session");

    const primary = screen.getPrimaryDisplay();
    const src = sources.find((s) => s.display_id === String(primary.id)) || sources[0];
    console.log("using source:", src.display_id, "size:", JSON.stringify(src.thumbnail.getSize()));

    const full = src.thumbnail.toPNG();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, full);
    console.log("wrote full frame:", OUT, (full.length / 1024).toFixed(0) + "KB");

    // 2. Crop the scan region so we can test tesseract on just the HUD text.
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromBuffer(full);
    const s = img.getSize();
    const crop = img.crop({
      x: Math.round(REGION.x * s.width),
      y: Math.round(REGION.y * s.height),
      width: Math.round(REGION.w * s.width),
      height: Math.round(REGION.h * s.height),
    });
    const cropPath = OUT.replace(/\.png$/, "-crop.png");
    fs.writeFileSync(cropPath, crop.toPNG());
    console.log("wrote crop:", cropPath, JSON.stringify(crop.getSize()));
    console.log("OK");
  } catch (e) {
    console.error("PROBE FAILED:", String(e));
  }
  app.quit();
});
