// Linux OCR backend for the screen reader — a thin wrapper over the shared implementation.
//
// The implementation lives in electron/linux/tesseract-ocr.cjs, not here, because it has to serve
// two processes with different module systems: this sidecar runs TypeScript under tsx, while the
// mining capture loop runs in the Electron main process, which is plain CommonJS with no TS
// loader. Keeping the parser in one .cjs means the two paths cannot drift apart — which is not a
// theoretical concern, because when the parser existed only in TypeScript the capture loop had no
// way to reach it and fell back to RapidOCR, whose sharp dependency aborts the whole app on this
// machine. See the header of tesseract-ocr.cjs for that crash in full.
//
// The platform seam itself is in screen-read.ts's ocrImage(): Windows keeps its warm WinRT worker,
// Linux shells to tesseract. Both return per-line bounding boxes, which is what the mining,
// fabricator, mission and refinery readers actually depend on — the mining reader hunts for the
// scan number's own box to confirm a read came off a real scan, and that contract has to survive
// the engine swap.
//
// Accuracy is measured, not assumed: tools/ocr-digits-accuracy.ts reads 24/24 confusable
// signatures exactly. That bar is 100% because the signature lookup is exact — one 5 read as an 8
// is a player at the wrong rock with total confidence.

import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const tesseract = require_("../electron/linux/tesseract-ocr.cjs");

/** Mirrors OcrLine / OcrResult in screen-read.ts. */
export interface OcrLine { text: string; x: number; y: number; w: number; h: number; }
export interface OcrResult { w: number; h: number; lines: OcrLine[]; }

export interface TesseractOptions {
  /** Restrict the character set. Mining signatures and percentages are digits; a whitelist
   *  measurably improves accuracy on them because tesseract stops offering up letters that merely
   *  resemble 0/O or 1/l. Omit for free text (chat, mission titles, item names). */
  whitelist?: string;
  psm?: string;
  /** Set false to skip polarity normalisation when the caller already knows the polarity. */
  invert?: boolean;
  /** Tesseract CLI override, for tests and unusual installs. */
  binary?: string;
}

export interface OcrSignal {
  spawnError: string | null;
  exitedBeforeReady: boolean;
  lastExitCode: number | null;
  everReady: boolean;
}

/** Run tesseract over one image, returning lines with boxes in the caller's image coordinates. */
export function ocrImageLinux(imagePath: string, opts: TesseractOptions = {}): Promise<OcrResult> {
  return tesseract.ocrImage(imagePath, opts) as Promise<OcrResult>;
}

/** Group tesseract TSV into lines. Exported for tests. */
export function parseTsv(tsv: string): OcrResult {
  return tesseract.parseTsv(tsv) as OcrResult;
}

/** Liveness signals for the diagnostics panel, so "tesseract is missing" is distinguishable from
 *  "tesseract read nothing" — three different installs needing three different fixes. */
export const linuxSignal: OcrSignal = tesseract.signal;

/** Reset the signals, so a self-test's verdict describes this run and not an earlier one. */
export function resetLinuxSignal(): void {
  tesseract.resetSignal();
}
