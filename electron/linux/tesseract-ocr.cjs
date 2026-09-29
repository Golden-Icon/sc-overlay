// tesseract OCR for Linux — the single implementation, shared by both consumers.
//
// This lives as .cjs rather than in src/ for one concrete reason: the mining capture loop runs in
// the ELECTRON MAIN process, which is plain CommonJS with no TS loader, while the sidecar server
// runs the TypeScript sources under tsx. Before this module the tesseract backend existed only in
// TypeScript, so the capture loop had no way to reach it — and the engine it DID reach there,
// RapidOCR via @gutenye/ocr-node, aborts the entire app on this machine:
//
//     ERROR:@img/sharp-libvips-dev/include/vips/VImage8.h:134: vips::VObject& operator=():
//     assertion failed: (!a.vobject || VIPS_IS_OBJECT(a.vobject))
//     Bail out!  electron exited with signal SIGABRT
//
// sharp@0.33.5 is a transitive dependency of @gutenye/ocr-node and it is not safe inside this
// Electron build. It took the whole overlay down — window, tray, hotkeys, server — on roughly
// every other launch, the moment the first mining tick asked it for a crop read. src/screen-read-linux.ts
// is now a thin wrapper over this file, so there is exactly one parser and the TS and CJS paths
// cannot drift apart.
//
// Why tesseract and not RapidOCR on Linux is not a preference, it is the only thing that runs.
// The accuracy was measured during the port (24/24 exact on confusable signatures), so the trade
// is a crash on every launch versus a working engine.

"use strict";

const { execFile } = require("node:child_process");

/** Mirrors OcrLine / OcrResult in src/screen-read.ts. Declared structurally so this module can be
 *  required without pulling in the TypeScript sources. */
const EMPTY = { w: 0, h: 0, lines: [] };

/** tesseract's own PSM modes. 11 = "sparse text", which wins for a HUD crop where only a couple of
 *  numbers are lit in a dark frame. 6 = "a single uniform block of text", the fallback for a
 *  dense panel that defeats the sparse model's layout assumptions. */
const PSM_SPARSE = "11";
const PSM_BLOCK = "6";

/** A word below this confidence is not a reading, it is a guess. The HUD is small and
 *  anti-aliased, so a correct 4-digit signature can land in the 40s. This admits weak-but-real
 *  reads and lets the reader's own accuracy checks decide, rather than dropping text that might
 *  be the one number on screen that mattered. */
const MIN_WORD_CONF = 30;

/** Liveness signals for the diagnostics panel, mirroring the Windows worker's ocrSignal so
 *  OcrHealth has one shape on both platforms.
 *
 *  These are the difference between "OCR is broken" being a 30-second fix and a support thread.
 *  A missing binary, a binary that will not start, and a binary that runs but reads nothing are
 *  three different installs needing three different fixes, and the user cannot tell them apart
 *  from "it didn't work". ENOENT in particular is the one worth naming precisely: tesseract simply
 *  is not installed, and no amount of retrying changes that. */
const signal = {
  spawnError: null,
  exitedBeforeReady: false,
  lastExitCode: null,
  everReady: false,
};

function resetSignal() {
  signal.spawnError = null;
  signal.exitedBeforeReady = false;
  signal.lastExitCode = null;
  signal.everReady = false;
}

/** Run tesseract over one image and return lines with boxes, in the caller's image coordinates.
 *
 *  At most two tesseract invocations: once sparse, and once as a uniform block only if sparse
 *  produced nothing.
 *
 *  Always resolves. A missing binary, a timeout and an unreadable image all come back as an empty
 *  result rather than rejecting, because every caller treats "no lines" as "nothing to
 *  classify" and would otherwise have to guard each call site. */
function ocrImage(imagePath, opts) {
  const o = opts || {};
  const binary = o.binary || process.env.SC_OCR_TESSERACT || "tesseract";
  const psm = o.psm || PSM_SPARSE;
  const wantNormalise = o.invert !== false;

  // Polarity is normalised with ImageMagick when present, because it has to happen BEFORE
  // tesseract opens the file. If ImageMagick is missing the image is read as-is: still correct,
  // just markedly worse on a dark HUD, so this degrades rather than fails.
  const prepared = wantNormalise ? normalizePolarity(imagePath) : Promise.resolve(imagePath);

  return prepared
    .then((file) => runTesseract(binary, file, psm, o.whitelist).then((res) => {
      if (res.lines.length || psm !== PSM_SPARSE) return res;
      // `file` is still the already-normalised copy, so the retry does not normalise twice.
      return runTesseract(binary, file, PSM_BLOCK, o.whitelist);
    }))
    .catch(() => EMPTY);
}

/** Normalise polarity so tesseract always sees dark text on a light background.
 *
 *  Polarity has to be DETECTED, not assumed. Tesseract reads dark-on-light well and
 *  bright-on-dark as noise, so a HUD crop needs inverting — but the project's own self-test
 *  image (overlay/ocr-selftest.png) is dark text on a WHITE page, and inverting that turns a clean
 *  "SC OVERLAY OCR SELF TEST 12345" into nothing at all. An unconditional invert made the
 *  self-test fail on a perfectly healthy engine, which is the worst possible failure: a red
 *  diagnostic pointing at a working install.
 *
 *  The mean of the greyscale image decides. 0.5 is the midpoint; a frame below it is
 *  predominantly dark (light-on-dark, so invert), a page above it is left alone. The threshold is
 *  deliberately loose — the two cases here (a near-black HUD at ~0.2, a white self-test page at
 *  ~0.87) are nowhere near it. */
function normalizePolarity(imagePath) {
  return new Promise((done) => {
    execFile(
      "magick",
      [imagePath, "-colorspace", "Gray", "-format", "%[fx:mean]", "info:"],
      { timeout: 5000 },
      (err, meanOut) => {
        if (err) { done(imagePath); return; }
        const mean = Number(String(meanOut).trim());
        if (!Number.isFinite(mean) || mean >= 0.5) { done(imagePath); return; }
        const out = `${imagePath}.norm.png`;
        execFile(
          "magick",
          [imagePath, "-colorspace", "Gray", "-negate", out],
          { timeout: 5000 },
          (werr) => done(werr ? imagePath : out),
        );
      },
    );
  });
}

/** One tesseract invocation, parsed from TSV. Resolves EMPTY on any failure. */
function runTesseract(binary, imagePath, psm, whitelist) {
  return new Promise((done) => {
    const args = [
      imagePath,
      "stdout",          // no output basename -> write to stdout
      "--psm", psm,
      "-l", "eng",
      "tsv",              // tab-separated, carries per-word boxes
      "-c", "preserve_interword_spaces=1",
    ];
    if (whitelist) {
      // tesseract rejects a whitelist containing characters it considers invalid; the caller's
      // charset is ours so we trust it, but empty-after-trim means "no restriction".
      const wl = String(whitelist).replace(/\s+/g, "").replace(/[\\^[\]]/g, "");
      if (wl) args.push("-c", `tessedit_char_whitelist=${wl}`);
    }
    execFile(
      binary, args,
      // TSV for a full 4K frame runs to a few MB; the crop path is far smaller but the buffer
      // must cover either.
      { maxBuffer: 32 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        if (err) {
          // ENOENT is the one to name exactly: tesseract is not installed.
          const code = err.code;
          if (code === "ENOENT") signal.spawnError = "ENOENT";
          else if (code) signal.spawnError = String(code);
          if (err.killed) signal.exitedBeforeReady = true;
          if (typeof code === "number") signal.lastExitCode = code;
        }
        if (err && !stdout) { done(EMPTY); return; }
        const parsed = parseTsv(stdout || "");
        // "Ready" means the engine produced a well-formed page: it ran and answered. Rows but no
        // words still proves the binary works and reads badly, which is a different problem with
        // a different fix.
        if (parsed.lines.length > 0 || parsed.w > 0) signal.everReady = true;
        done(parsed);
      },
    );
  });
}

/** Group tesseract's TSV word rows into lines with boxes.
 *
 *  TSV columns (tab separated, with a header row):
 *    level page block par line word left top width height conf text
 *  level 5 is a word; levels 1-4 are the enclosing page/block/para/line. Words are grouped by the
 *  (block, par, line) triple, and each group's box is the union of its words' boxes — which is what
 *  the readers' `pin` rects want, since they hunt a number's extent, not the engine's line box. */
function parseTsv(tsv) {
  const rows = String(tsv).split("\n");
  if (!rows.length) return EMPTY;

  let width = 0, height = 0;
  const groups = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0 && row.startsWith("level")) continue;           // header
    if (!row.trim()) continue;
    // text is the last column and may contain spaces, so split to a fixed count and rejoin the
    // remainder rather than trusting a plain split's tail.
    const cols = row.split("\t");
    if (cols.length < 12) continue;

    const level = Number(cols[0]);
    const conf = Number(cols[10]);
    const text = cols.slice(11).join("\t").trim();

    if (level === 1) {
      // The page row carries the image size. Its left/top are 0; the extent is in the width and
      // height columns (8 and 9), same as a word row. Reading left/top here yields a 0x0 page,
      // which silently breaks every caller that scales boxes by the page size.
      width = Number(cols[8]) || 0;
      height = Number(cols[9]) || 0;
      continue;
    }
    if (level !== 5 || !text) continue;
    if (Number.isFinite(conf) && conf < MIN_WORD_CONF) continue;

    const key = `${cols[2]}/${cols[3]}/${cols[4]}`;
    const x = Number(cols[6]), y = Number(cols[7]);
    const w = Number(cols[8]), h = Number(cols[9]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) continue;

    let g = groups.get(key);
    if (!g) {
      g = { words: [], x0: x, y0: y, x1: x + w, y1: y + h };
      groups.set(key, g);
    } else {
      if (x < g.x0) g.x0 = x;
      if (y < g.y0) g.y0 = y;
      if (x + w > g.x1) g.x1 = x + w;
      if (y + h > g.y1) g.y1 = y + h;
    }
    g.words.push(text);
  }

  const lines = [];
  for (const g of groups.values()) {
    const text = g.words.join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({ text, x: g.x0, y: g.y0, w: g.x1 - g.x0, h: g.y1 - g.y0 });
  }
  // Top-to-bottom, then left-to-right, so downstream "nearest line to this point" logic sees a
  // stable order regardless of TSV emission order.
  lines.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return { w: width, h: height, lines };
}

module.exports = {
  ocrImage,
  parseTsv,
  normalizePolarity,
  resetSignal,
  signal,
  PSM_SPARSE,
  PSM_BLOCK,
  MIN_WORD_CONF,
};
