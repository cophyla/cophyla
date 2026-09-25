// `host.open`: what the view asks the page to show for the remote desktop. A stream page on
// this origin under `/remote/` goes in a full-screen layer over the view, with a bar to close
// it; a page elsewhere opens in a window of its own; an `art:` link (an invite for the
// Artemis app) is handed to the phone to open. Anything else is refused: the view is
// untrusted, and a `javascript:` or `data:` URL must never reach a navigation.

export type OpenTarget = { kind: "frame"; url: string } | { kind: "window"; url: string } | { kind: "app"; url: string };

/** Where a URL from the view goes, or why it may not; `origin` is this page's. */
export function openTarget(raw: unknown, origin: string): OpenTarget {
  if (typeof raw !== "string" || raw.length > 4096) throw new Error("host.open needs a url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("that link cannot be opened");
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (url.origin !== origin) return { kind: "window", url: url.href };
    if (url.pathname.startsWith("/remote/")) return { kind: "frame", url: url.href };
    throw new Error("only a stream page opens over the view");
  }
  if (url.protocol === "art:") return { kind: "app", url: url.href };
  throw new Error("that link cannot be opened");
}

/** The stream page over everything else, until its Close is pressed. One at a time. */
export function showStream(doc: Document, url: string): void {
  doc.getElementById("remote-layer")?.remove();
  const layer = doc.createElement("div");
  layer.id = "remote-layer";
  layer.className = "remote-layer";
  const bar = doc.createElement("div");
  bar.className = "remote-bar";
  const title = doc.createElement("span");
  title.textContent = "Remote desktop";
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => layer.remove());
  bar.append(title, close);
  const frame = doc.createElement("iframe");
  frame.src = url;
  frame.title = "Remote desktop";
  frame.setAttribute("allow", "fullscreen; gamepad; keyboard-map; autoplay; clipboard-read; clipboard-write");
  layer.append(bar, frame);
  doc.body.append(layer);
}

/** The page's answer to `host.open`. */
export async function hostOpen(params: unknown, origin: string, win: Window): Promise<Record<string, never>> {
  const target = openTarget((params as { url?: unknown } | null)?.url, origin);
  switch (target.kind) {
    case "frame":
      showStream(win.document, target.url);
      break;
    case "window":
      win.open(target.url, "_blank", "noopener,noreferrer");
      break;
    case "app":
      win.location.href = target.url;
      break;
  }
  return {};
}
