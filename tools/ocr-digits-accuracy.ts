// Digit-accuracy check for the tesseract backend.
//
// 🔑 WHY THIS FILE EXISTS. The mining reader's output is a 1-4 digit signature that is looked up
// EXACTLY against the catalog — there is no fuzzy match. So the only question that decides
// whether the Linux port works is: does the engine read those digits right? A signature is also
// the hardest possible case: a few dozen pixels tall, bright-on-dark, next to other numbers, on
// an anti-aliased game HUD. 5/8, 1/7 and 0/6 are the classic confusions and a single 5 read as
// an 8 sends the player to the wrong rock with total confidence.
//
// It renders a grid of signatures in an SC-like scan box and reports the exact-match rate, so a
// regression in the charset, the inversion or the line grouping shows up as a number rather than
// as a player's wasted trip. The digits are the contract; the surrounding text is not scored.
//
//   npx tsx tools/ocr-digits-accuracy.ts

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrImageLinux } from "../src/screen-read-linux.ts";

/** Deliberately loaded with the confusable pairs. Every 5/8, 1/7, 0/6, 3/9 and 2/7 pair a
 *  classic tesseract confusion, because an easy set of digits like 1111/8888 would report a
 *  healthy rate and prove nothing. */
const SIGNATURES = [
  7514, 5182, 8080, 1717, 6160, 3939, 2727, 5050,
  1234, 4321, 9999, 1000, 8086, 5175, 1818, 6060,
  3141, 2718, 8500, 7621, 9510, 4096, 8008, 1357,
];

const GRID_COLS = 4;
const CELL_W = 320;
const CELL_H = 90;
const FONT_SIZE = 54;

function render(signatures: number[], fontFile: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sc-digits-"));
  const path = join(dir, "grid.png");
  // Near-black panel, bright digits — SC's HUD polarity, which tesseract reads worst until inverted.
  const rows = Math.ceil(signatures.length / GRID_COLS);
  const args: string[] = [
    "-size", `${CELL_W * GRID_COLS}x${CELL_H * rows}`,
    "xc:rgb(12,14,16)",
    "-font", fontFile, "-pointsize", String(FONT_SIZE),
    "-fill", "rgb(240,246,250)",
  ];
  signatures.forEach((s, i) => {
    args.push("-annotate", `+${(i % GRID_COLS) * CELL_W + 40}+${Math.floor(i / GRID_COLS) * CELL_H + 62}`,
      String(s));
  });
  args.push(path);
  execFileSync("magick", args);
  return { path, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

async function main() {
  const fontFile = execFileSync("fc-match", ["-f", "%{file}", "DejaVu Sans Condensed:bold"], { encoding: "utf8" }).trim();
  const { path, cleanup } = render(SIGNATURES, fontFile);
  try {
    const t0 = Date.now();
    const res = await ocrImageLinux(path);
    const ms = Date.now() - t0;

    // Every digit run the engine produced, as a set. The grid has no other numbers in it, so a
    // run is either a signature or a misread of one.
    const found = new Set<string>();
    for (const l of res.lines) for (const m of l.text.matchAll(/\d+/g)) found.add(m[0]);

    const missing: number[] = [];
    const wrong: { want: number; got: string }[] = [];
    for (const s of SIGNATURES) {
      const want = String(s);
      if (found.has(want)) continue;
      // A read is "wrong" if the engine produced a same-length run that isn't the truth.
      const near = [...found].find((f) => f.length === want.length);
      if (near) wrong.push({ want: s, got: near }); else missing.push(s);
    }

    const exact = SIGNATURES.length - wrong.length - missing.length;
    const rate = Math.round((exact / SIGNATURES.length) * 100);
    console.log(`font: ${fontFile.split("/").pop()}`);
    console.log(`image ${res.w}x${res.h}, ${res.lines.length} lines, ${ms}ms`);
    console.log(`exact signature reads: ${exact}/${SIGNATURES.length} (${rate}%)`);
    if (wrong.length) {
      console.log("misread:");
      for (const w of wrong) console.log(`  wanted ${w.want}, read ${w.got}`);
    }
    if (missing.length) console.log(`not read at all: ${missing.join(", ")}`);

    // 100% is the bar, not a target: the lookup is exact, so a single misread is a wrong rock.
    // Below it, this is not ready to drive the tracker and the caller should treat it as such.
    if (exact !== SIGNATURES.length) process.exitCode = 1;
  } finally {
    cleanup();
  }
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
