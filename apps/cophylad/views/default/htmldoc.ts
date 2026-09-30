// An HTML file the viewer draws, made whole to be written into the document frame
// (@cophyla/protocol's docframe.ts), which reaches nothing: what the page loads from its folder
// (its scripts, its style sheets and what they reach with `url()`, its images, media and icon)
// is read through what the viewer reads the file through and put in as data; a `<base>`, and a
// refresh that would take the frame elsewhere, are dropped; and first in its head goes a small
// script that hands a click on a link to the view (`{cophylaLink}`, to `parent`): a link to a
// place in the page (`#…`) stays in the frame, and the view opens anything else, a file of the
// folder in the viewer and a web page in the user's browser. At most INLINE_FILES files and
// INLINE_BYTES bytes are put in; past them the rest stay as written, and load nothing. What a
// script asks for as it runs is not put in, so a module importing another and a `fetch` of a
// file beside it are refused, as the web is. The page is read with DOMParser, which runs
// nothing and loads nothing.

import { bytesOf, resolveRel } from "./model.ts";

/** Files put into one page at most, and their bytes. */
export const INLINE_FILES = 200;
export const INLINE_BYTES = 64 * 1024 * 1024;

/** A file the page loads, as read: its bytes as base64 with their type, or its text, as an older node sends a text file. */
export type Asset = { base64: string; mime: string } | { text: string };

/** The page made whole, the files it names that could not be read, and whether the most it may take in was reached. */
export interface Inlined {
  html: string;
  missing: string[];
  capped: boolean;
}

/** Hands a click on a link to the view; one to a place in the page stays. Runs before the page's own scripts, and hears a click after them, so a page that handles its own links keeps them. */
export const LINK_SCRIPT =
  '(function(){addEventListener("click",function(ev){if(ev.defaultPrevented||ev.button!==0)return;var t=ev.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#"||/^javascript:/i.test(h))return;ev.preventDefault();parent.postMessage({cophylaLink:h},"*");});})();';

/** What loads a file by an attribute: the element and the attribute. */
const LOADS: [string, string][] = [
  ["img", "src"],
  ["input[type=image i]", "src"],
  ["video", "src"],
  ["video", "poster"],
  ["audio", "src"],
  ["source", "src"],
  ["track", "src"],
  ["link[rel~=icon i]", "href"],
];

const URL_IN_CSS = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

function textOf(asset: Asset): string {
  return "text" in asset ? asset.text : new TextDecoder().decode(bytesOf(asset.base64));
}

function dataUrl(asset: Asset, mime: string): string {
  return "base64" in asset ? `data:${asset.mime || mime};base64,${asset.base64}` : `data:${mime};charset=utf-8,${encodeURIComponent(asset.text)}`;
}

/** A type for a file read as text, by its extension, for its data URL. */
function mimeOf(rel: string): string {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  return ext === "css" ? "text/css" : ext === "js" || ext === "mjs" ? "text/javascript" : ext === "svg" ? "image/svg+xml" : ext === "json" ? "application/json" : "text/plain";
}

/** Makes `source`, the HTML file at `fileRel`, whole: every file it loads from its folder read by `read` and put in as data. */
export async function inlineDocument(source: string, fileRel: string, read: (rel: string) => Promise<Asset | undefined>): Promise<Inlined> {
  const doc = new DOMParser().parseFromString(source, "text/html");
  for (const el of Array.from(doc.querySelectorAll("base, meta[http-equiv=refresh i]"))) el.remove();
  const missing: string[] = [];
  const reads = new Map<string, Promise<Asset | undefined>>();
  let files = 0;
  let bytes = 0;
  let capped = false;

  /** A file of the folder, once however often the page names it; nothing once the most is reached, or when it cannot be read. */
  const get = (rel: string): Promise<Asset | undefined> => {
    let r = reads.get(rel);
    if (r) return r;
    if (files >= INLINE_FILES || bytes >= INLINE_BYTES) {
      capped = true;
      return Promise.resolve(undefined);
    }
    files++;
    r = read(rel).then(
      (asset) => {
        if (!asset) missing.push(rel);
        else bytes += "base64" in asset ? (asset.base64.length * 3) / 4 : asset.text.length;
        if (bytes > INLINE_BYTES) capped = true;
        return asset && bytes <= INLINE_BYTES ? asset : undefined;
      },
      () => {
        missing.push(rel);
        return undefined;
      },
    );
    reads.set(rel, r);
    return r;
  };

  /** An address in the file at `from` as data, or undefined to leave it as written (the web, `data:`, a place in the page, one not read). */
  const inline = async (href: string, from: string): Promise<string | undefined> => {
    const rel = resolveRel(from, href.trim());
    if (rel === undefined) return undefined;
    const asset = await get(rel);
    return asset ? dataUrl(asset, mimeOf(rel)) : undefined;
  };

  /** A style sheet's `url()`s, each resolved against the file the sheet is in, as data. */
  const css = async (text: string, from: string): Promise<string> => {
    const found = [...text.matchAll(URL_IN_CSS)];
    const urls = await Promise.all(found.map((m) => inline(m[2]!, from)));
    let i = 0;
    return text.replace(URL_IN_CSS, (whole) => {
      const url = urls[i++];
      return url !== undefined ? `url("${url}")` : whole;
    });
  };

  const jobs: Promise<void>[] = [];
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    jobs.push(
      inline(script.getAttribute("src") ?? "", fileRel).then((url) => {
        if (url === undefined) return;
        script.setAttribute("src", url);
        script.removeAttribute("integrity");
      }),
    );
  }
  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>("link[rel~=stylesheet i][href]"))) {
    const rel = resolveRel(fileRel, (link.getAttribute("href") ?? "").trim());
    if (rel === undefined) continue;
    jobs.push(
      get(rel).then(async (asset) => {
        if (!asset) return;
        const style = doc.createElement("style");
        const media = link.getAttribute("media");
        if (media) style.setAttribute("media", media);
        style.textContent = await css(textOf(asset), rel);
        link.replaceWith(style);
      }),
    );
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    const text = style.textContent ?? "";
    if (URL_IN_CSS.test(text)) jobs.push(css(text, fileRel).then((t) => void (style.textContent = t)));
    URL_IN_CSS.lastIndex = 0;
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style*='url(' i]"))) {
    jobs.push(css(el.getAttribute("style") ?? "", fileRel).then((t) => el.setAttribute("style", t)));
  }
  for (const [selector, attr] of LOADS) {
    for (const el of Array.from(doc.querySelectorAll(`${selector}[${attr}]`))) {
      jobs.push(
        inline(el.getAttribute(attr) ?? "", fileRel).then((url) => {
          if (url !== undefined) el.setAttribute(attr, url);
        }),
      );
    }
  }
  // A choice of sizes would name files the frame cannot load: the one in `src` stands.
  for (const el of Array.from(doc.querySelectorAll("img[srcset], source[srcset]"))) el.removeAttribute("srcset");
  await Promise.all(jobs);

  const links = doc.createElement("script");
  links.textContent = LINK_SCRIPT;
  doc.head.prepend(links);
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}${doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ""}${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ""}>\n` : "";
  return { html: doctype + doc.documentElement.outerHTML, missing, capped };
}
