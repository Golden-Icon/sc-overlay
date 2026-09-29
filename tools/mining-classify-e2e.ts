// Proves the LAST link: that the mining reader itself accepts what the tesseract backend returns.
//
// tools/ocr-digits-accuracy.ts proves the engine reads digits. ocr-selftest-linux.ts proves the
// diagnostics report honestly. Neither proves the reader will ACT on the result — and that is a
// real risk rather than a formality, because tesseract and Windows OCR do not hand back the same
// thing. Windows OCR emits a line per visual line; tesseract emits a line per (block, paragraph,
// line) triple after whitespace collapsing. classifyScreen filters lines by the scanRegion rect,
// scores signature-shaped candidates, and hunts the scan glyph by a box it derives from those
// lines. If any of that assumed Windows' segmentation, a perfect digit read would still classify
// to nothing — and the user would see the same "mining does nothing" as before, now with a
// passing self-test, which is a far more confusing failure than the one it replaced.
//
// The frame is synthetic because the real one needs a player standing at a rock. It is built to
// the shape the reader cares about: a signature inside the configured scanRegion, an ore name
// beside it, and HUD noise outside the region that must NOT be picked up.
//
//   npx tsx tools/mining-classify-e2e.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrImageLinux } from "../src/screen-read-linux.ts";
import { classifyScreen, loadCatalog } from "../src/screen-read.ts";

/** The signature the frame contains, and the ore beside it. A wrong read here is the exact bug
 *  that sends a player to the wrong rock, so the assertion is on the NUMBER, not on "it found
 *  something". */
const TRUTH_SIG = 7514;
const TRUTH_ORE = "COMSTANTINE";

/** Must match the app's own configured region, because classifyScreen discards anything outside
 *  it. Reading it from the real config keeps this test honest if the region ever moves. */
const CONFIG = JSON.parse(readFileSync("/home/golden/sc-blueprint-tracker/config.json", "utf8"));
const REGION = CONFIG.scanRegion as { x: number; y: number; w: number; h: number };

const FRAME_W = 3440, FRAME_H = 1440;

function renderFrame(dir: string): string {
  const path = join(dir, "frame.png");
  const font = execFileSync("fc-match", ["-f", "%{file}", "DejaVu Sans Condensed:bold"], { encoding: "utf8" }).trim();
  // Everything is placed in one ImageMagick call so the whole frame is drawn in a single pass,
  // and coordinates are computed from FRAME_W/H so the region maths below is honest.
  const rx = Math.round(REGION.x * FRAME_W), ry = Math.round(REGION.y * FRAME_H);
  const rw = Math.round(REGION.w * FRAME_W), rh = Math.round(REGION.h * FRAME_H);
  const args = [
    "-size", `${FRAME_W}x${FRAME_H}`, "xc:rgb(10,12,14)",
    // a dim frame-wide panel edge, so the crop is not a flat void
    "-fill", "rgb(28,36,40)", "-draw", `rectangle 0,0 ${FRAME_W - 1},${FRAME_H - 1}`,
    "-font", font,
    // the scan box: signature + ore, INSIDE the region
    "-fill", "rgb(240,246,250)", "-pointsize", "60",
    "-annotate", `+${rx + 60}+${ry + 120}`, String(TRUTH_SIG),
    "-fill", "rgb(120,230,190)", "-pointsize", "44",
    "-annotate", `+${rx + 320}+${ry + 118}`, TRUTH_ORE,
    // The scan-panel word the reader gates on (SCAN_HUD in screen-read.ts). Without it the frame
    // is rejected as "not a scan" even with a perfect signature — which is the correct behaviour
    // (a stray centred number on some other screen must not read as a rock) and is why the frame
    // has to carry the panel label, not just the number.
    "-fill", "rgb(200,210,220)", "-pointsize", "38",
    "-annotate", `+${rx + 60}+${ry + 200}`, "COMSTANTINE - MODERATE",
    // HUD noise OUTSIDE the region, which must not become the answer
    "-fill", "rgb(180,190,200)", "-pointsize", "34",
    "-annotate", `+80+120`, "SHIELDS 100%",
    "-annotate", `+${FRAME_W - 700}+${FRAME_H - 160}`, "HULL 9988",
    "-annotate", `+80+${FRAME_H - 160}`, "12345",
    path,
  ];
  execFileSync("magick", args);
  return path;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "sc-classify-"));
  try {
    const frame = renderFrame(dir);
    const ocr = await ocrImageLinux(frame);
    console.log(`frame ${FRAME_W}x${FRAME_H}, region ${JSON.stringify(REGION)}`);
    console.log(`ocr: ${ocr.lines.length} lines, page ${ocr.w}x${ocr.h}`);
    for (const l of ocr.lines) console.log(`  [${l.x},${l.y} ${l.w}x${l.h}] ${JSON.stringify(l.text)}`);

    const catalog = loadCatalog("/home/golden/Projects/sc-overlay/data");
    const result = classifyScreen(ocr, catalog, { scanRegion: REGION } as never);
    console.log(`\nclassifyScreen -> ${JSON.stringify(result)}`);

    if (!result) { console.error("\nFAIL: the reader rejected a frame containing a valid signature"); process.exit(1); }
    if (result.kind !== "mineable") { console.error(`\nFAIL: expected a mineable read, got "${result.kind}"`); process.exit(1); }
    if (result.signature !== TRUTH_SIG) {
      console.error(`\nFAIL: read ${result.signature}, frame says ${TRUTH_SIG} — a misread signature is a wrong rock`);
      process.exit(1);
    }
    console.log(`\nOK: signature ${result.signature} read exactly from a tesseract line`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
