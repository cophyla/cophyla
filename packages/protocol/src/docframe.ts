// The document frame: where a view draws an HTML file the user opened, its scripts running. A
// frame of the view's own making (`srcdoc`, a `data:` page) takes the view's policy, whose
// `script-src` is the view's origin alone, so a page's scripts could never run there. Each host
// serves this small page itself instead, on an origin the view may frame (the desktop app's
// `doc` scheme, the node's controller listener, the phone's staged files), with a policy of its
// own: the page's scripts run, and nothing reaches the network, submits a form, opens a window,
// navigates the top or frames anything. It says it is ready to the frame that framed it
// (`{cophylaDocReady}`), waits for the HTML from that frame alone (`{cophylaDoc}`, from
// `parent`), and writes it in place of itself, once: writing a document drops every listener
// the page had, this one with them. A page opened on its own, outside any frame, is still
// sandboxed by the policy.

/** Where a host that serves pages over HTTP serves the frame: the node's controller listener, the desktop app's `doc` scheme. */
export const DOC_FRAME_PATH = "/doc/frame.html";
/** Its name beside a view's staged files, on a host that stages them (the phone). */
export const DOC_FRAME_FILE = "docframe.html";

/** What the page and the HTML written in it may do. */
export const DOC_FRAME_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The same policy as a page's own `<meta>` carries it, for a host that sends no headers (the
 * phone's staged files): a meta policy cannot sandbox, so the frame's own `sandbox` attribute
 * is what does there.
 */
export const DOC_FRAME_META_CSP = DOC_FRAME_CSP.replace(/^sandbox [^;]*; /, "");

/** The page. */
export const DOC_FRAME_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Document</title></head>
<body>
<script>
addEventListener("message", function (ev) {
  if (ev.source !== parent || !ev.data || typeof ev.data.cophylaDoc !== "string") return;
  document.open();
  document.write(ev.data.cophylaDoc);
  document.close();
});
parent.postMessage({ cophylaDocReady: true }, "*");
</script>
</body>
</html>
`;

/** The page with its policy in its head, for a host that sends no headers. */
export function docFramePage(): string {
  return DOC_FRAME_HTML.replace("<meta charset=\"utf-8\">", `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${DOC_FRAME_META_CSP}">`);
}

/** The headers the page is served with, over HTTP. */
export function docFrameHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": DOC_FRAME_CSP,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}
