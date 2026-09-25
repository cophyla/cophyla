import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(join(homedir(), "AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/"));
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true, executablePath: join(homedir(), "AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe") });
const mode = process.argv[3] ?? "bench";
const page = await browser.newPage();
// the bench with its log printed as it grows: for a run that may stall
//   node --experimental-strip-types watch.ts <url> [bench|nat] [seconds]
await page.goto(process.argv[2]);
void page.evaluate((m: string) => (window as any).__run(m), mode).catch(() => {});
let last = "";
const limit = Number(process.argv[4] ?? 60) / 1.5;
for (let i = 0; i < limit; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const t = await page.$eval("#out", (e: Element) => e.textContent);
  // a log that shrank was cleared for a summary: print it whole
  if (t !== last) { console.log(`[${i * 1.5}s]`, t.startsWith(last) ? t.slice(last.length) : t); last = t; }
  if (t.includes("results sent") || t.includes("saved on the device")) break;
}
await browser.close();
