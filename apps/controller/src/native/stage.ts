// Views staged on the phone: the native app cannot fetch a ticket URL from a node it
// reaches through the relay, so it asks for the files (`view.get`) and writes them under
// its own storage, one directory per view version, and loads the frame from there (the app
// serves those files itself, `ViewFiles.kt`, since Capacitor's server would not). A
// content-security policy is put into the entry page so the view can reach nothing but
// its own files: the frame stays sandboxed, and its only way out is the bridge. Older
// versions are pruned once a new one is written. A version is a hash of the view's files,
// so one already written whole is loaded from storage without asking for it again: the
// mark written after its last file says it is whole, and names the platform that served it,
// since a new platform may turn the same sources into other files. Beside each version the
// document frame is written too (@cophyla/protocol's docframe.ts), its policy in its head since
// these files come with no headers, for the view to run an HTML file's scripts in: the view's
// own policy lets it frame its siblings.

import { DOC_FRAME_FILE, docFramePage } from "@cophyla/protocol";
import type { ViewContent, ViewManifest } from "@cophyla/protocol";
import type { Staged } from "@cophyla/viewhost";

/** The slice of `@capacitor/filesystem` this needs, so a test can play it. */
export interface FsLike {
  writeFile(options: { path: string; data: string; directory: string; encoding?: "utf8"; recursive?: boolean }): Promise<unknown>;
  /** Rejects when the file is not there. */
  readFile(options: { path: string; directory: string; encoding: "utf8" }): Promise<{ data: unknown }>;
  readdir(options: { path: string; directory: string }): Promise<{ files: { name: string; type: string }[] }>;
  rmdir(options: { path: string; directory: string; recursive?: boolean }): Promise<void>;
  getUri(options: { path: string; directory: string }): Promise<{ uri: string }>;
}

export const VIEWS_DIRECTORY = "DATA";
export const VIEWS_ROOT = "views";
/** Written into a version's directory after its last file. */
export const STAGED_MARK = ".staged";

/** What the entry page may load: itself and its siblings, nothing over the network, and a form submits nowhere. */
export const VIEW_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

/** A directory name a version may use. */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");

/** The entry page with the policy in its head, once. */
export function withCsp(html: string): string {
  if (/http-equiv=["']?content-security-policy/i.test(html)) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  return meta + html;
}

export interface StageDeps {
  fs: FsLike;
  /** A file path under the app's storage as a URL the web view loads. */
  fileUrl: (path: string) => string;
  get: (id: string) => Promise<ViewContent>;
  /** The platform version of the node serving the view, from its hello. */
  platform?: string;
}

const versionDir = (id: string, version: string): string => `${VIEWS_ROOT}/${safe(id)}/${safe(version)}`;

/** Writes the view's files, unless this version is written already, and answers where the frame loads them from. */
export async function stageLocally(deps: StageDeps, manifest: ViewManifest): Promise<Staged> {
  const stamp = deps.platform ?? "";
  if (manifest.version !== undefined) {
    const dir = versionDir(manifest.id, manifest.version);
    if ((await readMark(deps.fs, dir)) === stamp) return located(deps, dir, manifest.version);
  }
  const content = await deps.get(manifest.id);
  const dir = versionDir(content.id, content.version);
  for (const file of content.files) {
    const path = `${dir}/${file.path.replace(/^\/+/, "")}`;
    if (file.text !== undefined) {
      const isEntry = file.path.replace(/^\/+/, "") === manifest.entry;
      await deps.fs.writeFile({ path, data: isEntry ? withCsp(file.text) : file.text, directory: VIEWS_DIRECTORY, encoding: "utf8", recursive: true });
    } else if (file.base64 !== undefined) {
      await deps.fs.writeFile({ path, data: file.base64, directory: VIEWS_DIRECTORY, recursive: true });
    }
  }
  await deps.fs.writeFile({ path: `${dir}/${STAGED_MARK}`, data: stamp, directory: VIEWS_DIRECTORY, encoding: "utf8", recursive: true });
  await prune(deps.fs, safe(content.id), safe(content.version));
  return located(deps, dir, content.version);
}

/** Where the frame loads a written version from, the document frame written beside it (a version written by an older app has none). */
async function located(deps: StageDeps, dir: string, version: string): Promise<Staged> {
  await deps.fs.writeFile({ path: `${dir}/${DOC_FRAME_FILE}`, data: docFramePage(), directory: VIEWS_DIRECTORY, encoding: "utf8", recursive: true });
  const { uri } = await deps.fs.getUri({ path: dir, directory: VIEWS_DIRECTORY });
  const base = `${deps.fileUrl(uri)}/`;
  return { base, version, docFrame: `${base}${DOC_FRAME_FILE}` };
}

/** The platform a version's mark names; undefined when the version is not written whole. */
async function readMark(fs: FsLike, dir: string): Promise<string | undefined> {
  try {
    const { data } = await fs.readFile({ path: `${dir}/${STAGED_MARK}`, directory: VIEWS_DIRECTORY, encoding: "utf8" });
    return typeof data === "string" ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Removes every version of the view but `keep`. */
async function prune(fs: FsLike, id: string, keep: string): Promise<void> {
  let entries: { name: string; type: string }[];
  try {
    entries = (await fs.readdir({ path: `${VIEWS_ROOT}/${id}`, directory: VIEWS_DIRECTORY })).files;
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === keep) continue;
    try {
      await fs.rmdir({ path: `${VIEWS_ROOT}/${id}/${e.name}`, directory: VIEWS_DIRECTORY, recursive: true });
    } catch {
      // a version in use by an older frame; it goes next time
    }
  }
}
