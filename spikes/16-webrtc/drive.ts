// Runs the page in headless Chromium (the engine of the Android web view the app runs in)
// against a node already listening, and prints the result the page reports.
//   node --experimental-strip-types drive.ts [--url http://127.0.0.1:4961/] [--mode bench|nat] [--runs 1] [--only any]

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:4961/" },
    mode: { type: "string", default: "bench" },
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    mb: { type: "string" },
  },
});
const require = createRequire(join(homedir(), "AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/"));
const { chromium } = require("playwright");

// the npx cache moved to a newer Playwright than the browsers installed here: use the one that is
const browser = await chromium.launch({ headless: true, executablePath: join(homedir(), "AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe") });
try {
  for (let i = 0; i < Number(values.runs); i++) {
    const page = await browser.newPage();
    page.on("console", (m: { text(): string }) => console.log("page:", m.text()));
    const url = new URL(values.url!);
    if (values.only) url.searchParams.set("only", values.only);
    if (values.mb) url.searchParams.set("mb", values.mb);
    await page.goto(url.href);
    const t0 = Date.now();
    await page.evaluate((mode: string) => (window as unknown as { __run(m: string): Promise<void> }).__run(mode), values.mode);
    const text = await page.$eval("#out", (e: Element) => e.textContent);
    console.log(`--- run ${i + 1} (${Date.now() - t0} ms)\n${text}`);
    await page.close();
  }
} finally {
  await browser.close();
}
