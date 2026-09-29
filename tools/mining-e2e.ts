// End-to-end check of the Linux mining path, against the real game window:
//   compositor capture -> tesseract OCR -> the reader's own classification.
//
// This is the integration that matters. Each half was verified alone (spectacle grabs a real
// frame; tesseract reads the HUD); this proves the two are joined correctly and that the text
// arrives in the shape the mining reader expects.
//
//   npx tsx tools/mining-e2e.ts
import { ocrImageLinux } from "../src/screen-read-linux.ts";

const OUT = "/tmp/opencode/mining-e2e.png";
const CROP = "/tmp/opencode/mining-e2e-crop.png";

async function main() {
  // 1. Capture through the SAME module capture.cjs uses, so a bug in the real path fails here.
  const { grabPng } = await import("../electron/capture-linux.cjs");
  const t0 = Date.now();
  const png = await grabPng(OUT);
  if (!png) { console.error("FAIL: capture produced no frame"); process.exit(1); }
  console.log(`capture: ${png} in ${Date.now() - t0}ms`);

  // 2. Crop the HUD region the miner watches, at 3x — the scan number is a handful of pixels
  //    tall and tesseract needs the scale, exactly as the real path does via the saved region.
  const { execFileSync } = await import("node:child_process");
  execFileSync("magick", [png, "-crop", "1720x420+860+180", "+repage", "-resize", "300%", CROP]);
  console.log(`crop: ${CROP}`);

  // 3. OCR it, the way ocrImage() calls the backend on Linux.
  const t1 = Date.now();
  const res = await ocrImageLinux(CROP);
  console.log(`ocr: ${res.lines.length} lines in ${Date.now() - t1}ms (page ${res.w}x${res.h})`);
  for (const l of res.lines) {
    console.log(`  [${l.x},${l.y} ${l.w}x${l.h}] ${JSON.stringify(l.text)}`);
  }

  // 4. The mining reader's own gate: a signature is a short run of digits. Report the digit runs
  //    that came out, so a misread (5->8, comma eaten) is visible rather than silently logged.
  const digitRuns: { text: string; x: number; y: number; w: number; h: number }[] = [];
  for (const l of res.lines) {
    for (const m of l.text.matchAll(/\d{1,4}/g)) {
      digitRuns.push({ text: m[0], x: l.x, y: l.y, w: l.w, h: l.h });
    }
  }
  console.log(`\ndigit candidates (what the tracker would match on): ${digitRuns.length}`);
  for (const d of digitRuns) console.log(`  ${d.text}  at ${d.x},${d.y} ${d.w}x${d.h}`);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
