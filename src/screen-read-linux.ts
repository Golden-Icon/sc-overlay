// Linux OCR backend for the screen reader.
//
// The Windows build reads the HUD through Windows OCR (WinRT) driven by PowerShell — see
// ocrImage() and OCR_PS1 in screen-read.ts. Neither WinRT nor powershell exists on Linux, and the
// mining/fabricator readers all sit downstream of a single seam: `ocrImage(path) -> OcrResult`
// with lines carrying their own bounding boxes. So this file implements that one seam on
// tesseract and nothing else has to know the platform changed.
//
// Why tesseract, and what it costs us:
//
//   * Windows OCR returns WORD boxes; tesseract's TSV also returns per-word boxes (level 5) plus
//     the block/paragraph/line ids needed to group them back into OcrLine. So the bbox contract
//     the readers depend on — `MineableRead.pin` hunting for the scan number's own box, the
//     "scan read area" outline drawn on the canvas — survives the swap intact.
//   * Windows OCR is happy with dark HUD-on-space. Tesseract wants dark text on light paper and
//     will read a bright-on-dark HUD as noise, so every image is inverted to black-on-white
//     before it sees the engine. SC's HUD is a light cyan/amber on near-black, which is exactly
//     the polarity tesseract handles worst.
//   * Windows OCR is a neural engine and is very good at this font. Tesseract is not, and a
//     signature number is 1-4 digits where a 5 misread as an 8 sends the player to the wrong
//     rock. Hence SCUAREPS/whitelist handling and the numeric conf threshold below: a low-
//     confidence number is reported as low confidence rather than silently trusted, so the
//     existing on-canvas "here is what I read" affordance can show the player the error instead
//     of the tracker confidently logging the wrong signature.
//
// Speed is the other half. Windows OCR keeps a warm process for exactly this reason; tesseract
// is started per read here, which costs ~150-400ms of model load. That is slower than the warm
// Windows worker but far faster than the 897ms one-shot Windows path it replaces, and the
// capture loop's 15s watchdog has enormous headroom.

import { execFile } from "node:child_process";

/** Mirrors OcrLine / OcrResult in screen-read.ts. Declared structurally so this module stays
 *  importable on its own (and unit-testable) without pulling the whole reader in. */
export interface OcrLine { text: string; x: number; y: number; w: number; h: number; }
export interface OcrResult { w: number; h: number; lines: OcrLine[]; }

const EMPTY: OcrResult = { w: 0, h: 0, lines: [] };

/** Liveness signals for the diagnostics panel, mirroring the Windows worker's ocrSignal so
 *  OcrHealth has one shape on both platforms.
 *
 *  🔑 These are the difference between "OCR is broken" being a 30-second fix and a support
 *  thread. A missing binary, a binary that will not start, and a binary that runs but reads
 *  nothing are three different installs needing three different fixes, and the user cannot tell
 *  them apart from "it didn't work". `spawnError === "ENOENT"` in particular is the one worth
 *  naming precisely: tesseract simply is not installed, and no amount of retrying changes that. */
export interface OcrSignal {
  spawnError: string | null;
  exitedBeforeReady: boolean;
  lastExitCode: number | null;
  everReady: boolean;
}

export const linuxSignal: OcrSignal = {
  spawnError: null,
  exitedBeforeReady: false,
  lastExitCode: null,
  everReady: false,
};

/** Reset the signals, so a self-test's verdict describes this run and not an earlier one. */
export function resetLinuxSignal(): void {
  linuxSignal.spawnError = null;
  linuxSignal.exitedBeforeReady = false;
  linuxSignal.lastExitCode = null;
  linuxSignal.everReady = false;
}

/** tesseract's own PSM modes. 6 = "a single uniform block of text", which is what a HUD panel is.
 *  11 = "sparse text", which wins when only a couple of numbers are lit in a dark frame. The
 *  reader calls us with a small crop around a scan box, so sparse is the better default and the
 *  uniform mode is the fallback if sparse returns nothing at all. */
const PSM_SPARSE = "11";
const PSM_BLOCK = "6";

/** A word below this confidence is not a reading, it is a guess. The HUD is small and
 *  anti-aliased; a 4-digit signature can land in the 40s even when correct, so this is set to
 *  admit weak-but-real reads and let the caller's own accuracy checks decide, rather than
 *  dropping text that might be the one number on screen that mattered. */
const MIN_WORD_CONF = 30;

export interface TesseractOptions {
  /** Restrict the character set. Mining signatures and percentages are digits; passing a
   *  whitelist measurably improves accuracy on them because tesseract stops offering up letters
   *  that merely resemble 0/O or 1/l. Omit for free text (chat, mission titles, item names). */
  whitelist?: string;
  psm?: string;
  /** Set false to skip polarity normalisation when the caller already knows the polarity. */
  invert?: boolean;
  /** Tesseract CLI override, for tests and unusual installs. */
  binary?: string;
}

/** Run tesseract over one image and return lines with boxes, in the caller's image coordinates.
 *
 *  tesseract is invoked twice at most: once sparse, and once as a uniform block only if sparse
 *  produced nothing. Both attempts share one process launch each, and the whole thing is bounded
 *  well inside the caller's watchdog.
 *
 *  Always resolves — a missing binary, a timeout and an unreadable image all come back as an
 *  empty OcrResult rather than rejecting, because every caller treats "no lines" as "nothing to
 *  classify" and would otherwise have to guard each call site.
 */
export function ocrImageLinux(imagePath: string, opts: TesseractOptions = {}): Promise<OcrResult> {
  const binary = opts.binary || process.env.SC_OCR_TESSERACT || "tesseract";
  const psm = opts.psm || PSM_SPARSE;
  const wantInvert = opts.invert !== false;

  // Polarity is normalised with ImageMagick when present, because it has to happen BEFORE
  // tesseract opens the file. If ImageMagick is missing the image is read as-is: still correct,
  // just markedly worse on a dark HUD, so this degrades rather than fails.
  const prepared = wantInvert ? normalizePolarity(imagePath) : Promise.resolve(imagePath);

  return prepared.then(async (file) => {
    const res = await runTesseract(binary, file, psm, opts.whitelist);
    if (res.lines.length || psm !== PSM_SPARSE) return res;
    // Sparse found nothing. Retry as one uniform block — a dense panel of HUD text defeats the
    // sparse model's layout assumptions but reads fine as a block. `file` stays in scope here so
    // the retry re-reads the already-inverted copy rather than inverting a second time.
    return runTesseract(binary, file, PSM_BLOCK, opts.whitelist);
  }).catch(() => EMPTY);
}

/** Normalise polarity so tesseract always sees dark text on a light background.
 *
 *  🔑 Polarity has to be DETECTED, not assumed. Tesseract reads dark-on-light well and
 *  bright-on-dark as noise, so a HUD crop needs inverting — but the project's own self-test
 *  image (overlay/ocr-selftest.png) is dark text on a WHITE page, and inverting that turns a
 *  clean "SC OVERLAY OCR SELF TEST 12345" into nothing at all. An unconditional invert made the
 *  self-test fail on a perfectly healthy engine, which is the worst possible failure: a red
 *  diagnostic pointing at a working install.
 *
 *  Measured against the mean of the greyscale image. 0.5 is the midpoint; a frame whose mean
 *  sits below it is predominantly dark, so light-on-dark, so invert. A light page sits above and
 *  is left alone. The threshold is deliberately not tuned tightly — the two cases in this
 *  project (a near-black HUD at ~0.2, a white self-test page at ~0.87) are nowhere near it.
 *
 *  Falls back to the original path if ImageMagick is missing: the read still works, just worse
 *  on a dark HUD, so this degrades rather than fails.
 */
function normalizePolarity(imagePath: string): Promise<string> {
  return new Promise((done) => {
    // Ask ImageMagick for the mean in one call, then decide. A second call does the write, so a
    // missing magick costs one failed spawn rather than a partial file.
    execFile(
      "magick",
      [imagePath, "-colorspace", "Gray", "-format", "%[fx:mean]", "info:"],
      { timeout: 5000 },
      (err, meanOut) => {
        if (err) { done(imagePath); return; }
        const mean = Number(String(meanOut).trim());
        if (!Number.isFinite(mean)) { done(imagePath); return; }
        // Light page already: hand tesseract the file as-is.
        if (mean >= 0.5) { done(imagePath); return; }
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
function runTesseract(
  binary: string, imagePath: string, psm: string, whitelist?: string,
): Promise<OcrResult> {
  return new Promise((done) => {
    const args = [
      imagePath,
      "stdout",           // no output basename -> write to stdout
      "--psm", psm,
      "-l", "eng",
      "tsv",              // tab-separated, carries per-word boxes
      "-c", "preserve_interword_spaces=1",
    ];
    if (whitelist) {
      // tesseract rejects a whitelist containing characters it considers invalid; the caller's
      // charset is ours so we trust it, but empty-after-trim means "no restriction".
      const wl = whitelist.replace(/\s+/g, "").replace(/[\\^[\]]/g, "");
      if (wl) args.push("-c", `tessedit_char_whitelist=${wl}`);
    }
    execFile(
      binary, args,
      // tesseract's TSV for a full 4K frame runs to a few MB; the crop path is far smaller but
      // the buffer has to cover either.
      { maxBuffer: 32 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        if (err) {
          // ENOENT is the one to name exactly: tesseract is not installed. Anything else (a
          // non-zero exit, a timeout) is recorded by code so the panel can distinguish "not
          // there" from "there and unhappy".
          if ((err as NodeJS.ErrnoException).code === "ENOENT") linuxSignal.spawnError = "ENOENT";
          else if ((err as NodeJS.ErrnoException).code) linuxSignal.spawnError = String((err as NodeJS.ErrnoException).code);
          if (typeof (err as { code?: unknown }).code === "number" || err.killed) {
            linuxSignal.lastExitCode = typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : null;
            if (err.killed) linuxSignal.exitedBeforeReady = true;
          }
        }
        if (err && !stdout) { done(EMPTY); return; }
        const parsed = parseTsv(stdout || "");
        // "Ready" means the engine produced a well-formed page: tesseract ran and answered. A
        // run that returned rows but no words has still proven the binary works and reads badly,
        // which is a different problem with a different fix.
        if (parsed.lines.length > 0 || parsed.w > 0) linuxSignal.everReady = true;
        done(parsed);
      },
    );
  });
}

/** Group tesseract's TSV word rows into OcrLines.
 *
 *  TSV columns (tab separated, with a header row):
 *    level page block par line word left top width height conf text
 *  `level` 5 is a word; levels 1-4 are the enclosing page/block/para/line. Words are grouped by
 *  the (block, par, line) triple, and each group's box is the union of its words' boxes — which
 *  is what the readers' `pin` rects want, since they hunt for a number's extent, not the
 *  engine's internal line box.
 */
export function parseTsv(tsv: string): OcrResult {
  const rows = tsv.split("\n");
  if (!rows.length) return EMPTY;

  let width = 0, height = 0;
  const groups = new Map<string, { words: string[]; x0: number; y0: number; x1: number; y1: number; }>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0 && row.startsWith("level")) continue;          // header
    if (!row.trim()) continue;
    // text is the last column and may itself contain tabs? No — tesseract escapes them, but it
    // can contain spaces and quotes, so split to a fixed count and rejoin the remainder.
    const cols = row.split("\t");
    if (cols.length < 12) continue;

    const level = Number(cols[0]);
    const conf = Number(cols[10]);
    const text = cols.slice(11).join("\t").trim();

    if (level === 1) {
      // The page row carries the image size. Its left/top are 0; the extent is in the width and
      // height columns (8 and 9), same as a word row — reading left/top here yields a 0x0 page,
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

  const lines: OcrLine[] = [];
  for (const g of groups.values()) {
    const text = g.words.join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({ text, x: g.x0, y: g.y0, w: g.x1 - g.x0, h: g.y1 - g.y0 });
  }
  // Top-to-bottom, then left-to-right, so downstream "find the line nearest this point" logic
  // sees a stable order regardless of TSV emission order.
  lines.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return { w: width, h: height, lines };
}
