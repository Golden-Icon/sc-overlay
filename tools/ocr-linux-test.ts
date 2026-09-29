// Exercises the tesseract backend against a real captured frame.
//   npx tsx tools/ocr-linux-test.ts [image]
import { ocrImageLinux } from "../src/screen-read-linux.ts";

const img = process.argv[2] || "/tmp/opencode/hud-test.png";

async function main() {
  const t0 = Date.now();
  const res = await ocrImageLinux(img, { whitelist: "0123456789%ABCDEFGHIJKLMNOPQRSTUVWXYZ .:-+" });
  const ms = Date.now() - t0;
  console.log(`image ${img}`);
  console.log(`page ${res.w}x${res.h}  lines ${res.lines.length}  in ${ms}ms`);
  for (const l of res.lines) {
    console.log(`  [${l.x},${l.y} ${l.w}x${l.h}] ${JSON.stringify(l.text)}`);
  }
  if (!res.lines.length) process.exitCode = 1;
}
main();
