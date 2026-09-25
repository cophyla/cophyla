// The loopback stream page's cookie and context, in Chromium (WebView2's and Android's
// engine) and WebKit (WKWebView's and WebKitGTK's): a ticket URL at http://127.0.0.1 sets a
// cookie without `Secure`, the page is a secure context, WebCodecs and WebRTC are there, and
// a cookie set with `Secure` over plain HTTP on loopback is kept or not.
//   bun cookie.ts                 (serves on 127.0.0.1)
//   node --experimental-strip-types cookie.ts --drive

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 4981;

if (!process.argv.includes("--drive")) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      const cookies = req.headers.get("cookie") ?? "";
      if (url.pathname === "/remote/" && url.searchParams.has("t")) {
        const secure = url.searchParams.get("secure") === "1";
        return new Response(`<!doctype html><script>location.replace("/remote/page.html")</script>`, {
          headers: { "content-type": "text/html", "set-cookie": `cophyla_remote=abc123; Path=/remote; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}` },
        });
      }
      if (url.pathname === "/remote/page.html") {
        return new Response(
          `<!doctype html><pre id="out"></pre><script>
          const r = { cookieSent: ${JSON.stringify(cookies.includes("cophyla_remote=abc123"))}, secureContext: isSecureContext, videoDecoder: typeof VideoDecoder === "function", rtc: typeof RTCPeerConnection === "function", ws: typeof WebSocket === "function" };
          document.getElementById("out").textContent = JSON.stringify(r);
          </script>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`serving on http://127.0.0.1:${PORT}`);
} else {
  const require = createRequire(join(homedir(), "AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/"));
  const { chromium, webkit } = require("playwright");
  const engines = [
    ["chromium", () => chromium.launch({ headless: true, executablePath: join(homedir(), "AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe") })],
    ["webkit", () => webkit.launch({ headless: true, executablePath: join(homedir(), "AppData/Local/ms-playwright/webkit-2336/Playwright.exe") })],
  ] as const;
  for (const [name, launch] of engines) {
    let browser;
    try {
      browser = await launch();
    } catch (e) {
      console.log(name, "did not launch:", (e as Error).message.split("\n")[0]);
      continue;
    }
    for (const secure of [false, true]) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/remote/?t=x&secure=${secure ? 1 : 0}`);
      await page.waitForURL(/page\.html/);
      const text = await page.$eval("#out", (e: Element) => e.textContent);
      console.log(name, secure ? "Secure cookie" : "plain cookie", text);
      await page.close();
    }
    await browser.close();
  }
}
