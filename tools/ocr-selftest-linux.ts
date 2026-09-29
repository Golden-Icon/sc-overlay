// Drives the real ocrSelfTest() over the real ocrImage() seam, so the diagnostics panel's
// verdict is produced by the same code path the capture loop uses.
//
// The point is not that tesseract works — tools/ocr-digits-accuracy.ts proves that. It is that
// the SELF-TEST reports honestly on Linux. That panel is what a user looks at first when mining
// "does nothing", and on this box it was reporting "Windows PowerShell could not be found" for a
// machine that has no PowerShell and never needed one. A green engine with a red diagnostic is
// worse than no diagnostic, because it sends the fix in the wrong direction.
//
//   npx tsx tools/ocr-selftest-linux.ts
import { ocrSelfTest } from "../src/screen-read.ts";

async function main() {
  const t0 = Date.now();
  const h = await ocrSelfTest();
  console.log(`platform      ${process.platform}`);
  console.log(`ok            ${h.ok}`);
  console.log(`matched       ${h.matched}`);
  console.log(`lines         ${h.lines}`);
  console.log(`ms            ${h.ms} (wall ${Date.now() - t0}ms)`);
  console.log(`text          ${JSON.stringify(h.text)}`);
  console.log(`reason        ${h.reason === null ? "(none)" : h.reason}`);
  console.log(`signal        ${JSON.stringify(h.signal)}`);

  // The regression this guards: on Linux, a healthy engine must not produce a Windows-flavoured
  // reason. If PowerShell is ever named here again, the platform branch has been lost.
  if (process.platform === "linux" && /powershell|winrt/i.test(h.reason || "")) {
    console.error("\nFAIL: Linux self-test blamed a Windows component");
    process.exit(1);
  }
  if (!h.ok) { console.error("\nFAIL: self-test did not go green"); process.exit(1); }
  console.log("\nOK");
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
