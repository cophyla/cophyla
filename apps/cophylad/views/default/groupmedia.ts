// Photos and files in a group chat, in the default view. The composer attaches photos (picked,
// pasted or dropped; shrunk here to 2048 pixels a side unless small already) and files (picked
// or dropped), each uploaded to the node a piece at a time as soon as it is attached; a file a
// desktop drop or a row of Files names by its path is attached by it and stays where it is. A
// post draws its photos, fetched a piece at a time and kept for the view's life, opens one full
// size, and lists its files with Save, which copies one into the Downloads folder of a machine
// of the user's picked from a short list.

import type { GroupFile, GroupPhoto, Transfer } from "@cophyla/protocol";
import { bytesWords, machineName } from "./model.ts";
import type { Action, ViewState } from "./model.ts";
import { actionButton, el, reconcile, setData, setHidden, setText } from "./render.ts";
import { attachParams, isImagePath, lastName, toBase64 } from "./attach.ts";
import type { Attached } from "./attach.ts";
import type { HostRpc } from "./rpc.ts";
import { ViewRpcError } from "./rpc.ts";

/** A piece of an upload or a photo: what a relayed frame takes once base64'd and sealed. */
const PIECE = 1.5 * 1024 * 1024;
/** The longest side a photo is shrunk to, and the most of a PNG, WebP or GIF kept as it is. */
const PHOTO_SIDE = 2048;
const PHOTO_KEEP = 1.5 * 1024 * 1024;
/** What a photo may hold once made, as the node takes it. */
const PHOTO_MAX = 3.5 * 1024 * 1024;
const FILE_MAX = 1024 ** 3;
const ATTACH_MAX = 4;
/** How long a photo that did not come waits before it is asked for again. */
const PHOTO_RETRY_MS = 10_000;

/** Photos and files' part of the view's own state. */
export interface MediaUi {
  /** Each group's composer's attachments. */
  attached: Map<string, Attached[]>;
  /** Each photo drawn, by id: its data URL once come, a fetch on its way, or when one failed. */
  photos: Map<string, { url?: string; loading?: boolean; failedAt?: number }>;
  /** A post's file being saved: the machines offered, and the request on its way or why it failed. */
  save?: { group: string; post: string; file: string; busy?: boolean; error?: string; confirm?: { node: string; bytes: number } };
  /** A photo shown full size over the pane. */
  viewing?: { group: string; photo: string };
}

export function newMediaUi(): MediaUi {
  return { attached: new Map(), photos: new Map() };
}

/** A photo made ready to upload: small ones as they are, the rest drawn again as a JPEG no wider than PHOTO_SIDE. */
async function shrink(file: File): Promise<{ bytes: Uint8Array; name: string; preview: string }> {
  const keep = (file.type === "image/png" || file.type === "image/webp" || file.type === "image/gif") && file.size <= PHOTO_KEEP;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error("this kind of image cannot be read here: attach it as a file");
  }
  const scale = Math.min(1, PHOTO_SIDE / Math.max(bmp.width, bmp.height));
  if (keep && scale === 1) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    bmp.close();
    return { bytes, name: file.name || "photo.png", preview: `data:${file.type};base64,${toBase64(bytes)}` };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const g = canvas.getContext("2d");
  if (!g) throw new Error("this view cannot draw images");
  // a JPEG has no transparency: what was clear is white
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const url = canvas.toDataURL("image/jpeg", 0.85);
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  if (bytes.length > PHOTO_MAX) throw new Error("too big even shrunk: attach it as a file");
  return { bytes, name: `${(file.name || "photo").replace(/\.[^.]*$/, "")}.jpg`, preview: url };
}

export interface MediaDeps {
  rpc: HostRpc;
  state: ViewState;
  media: MediaUi;
  draw: () => void;
  dispatch: (action: Action) => void;
  /** A refusal in words the user can act on. */
  words: (e: unknown) => string;
}

/** The control the group's pane draws photos through: the one the team's controller made. */
let current: MediaControl | undefined;

export class MediaControl {
  private d: MediaDeps;
  private n = 0;

  constructor(deps: MediaDeps) {
    this.d = deps;
    current = this;
  }

  private list(group: string): Attached[] {
    let l = this.d.media.attached.get(group);
    if (!l) this.d.media.attached.set(group, (l = []));
    return l;
  }

  private room(group: string, kind: Attached["kind"]): boolean {
    return this.list(group).filter((a) => a.kind === kind).length < ATTACH_MAX;
  }

  /** Files the user picked, pasted or dropped from this device: photos shrunk, each uploaded at once. */
  pick(group: string, files: readonly File[], photos: boolean): void {
    for (const file of files) {
      const kind = photos && file.type.startsWith("image/") ? "photo" : "file";
      if (!this.room(group, kind)) break;
      const a: Attached = { key: `a${++this.n}`, kind, name: file.name || (kind === "photo" ? "photo" : "file"), bytes: file.size };
      this.list(group).push(a);
      void this.upload(group, a, file);
    }
    this.d.draw();
  }

  /** Paths on one of the user's machines, from a desktop drop or a row of Files: attached by them, nothing uploaded. */
  paths(group: string, node: string, paths: readonly string[]): void {
    for (const path of paths) {
      const kind = isImagePath(path) ? "photo" : "file";
      if (!this.room(group, kind)) break;
      this.list(group).push({ key: `a${++this.n}`, kind, name: lastName(path), node, path });
    }
    this.d.draw();
  }

  private async upload(group: string, a: Attached, file: File): Promise<void> {
    try {
      let bytes: Uint8Array | undefined;
      if (a.kind === "photo") {
        const made = await shrink(file);
        bytes = made.bytes;
        a.name = made.name;
        a.preview = made.preview;
        a.bytes = bytes.length;
        this.d.draw();
      } else if (file.size > FILE_MAX) throw new Error("over 1 GB: drop it from your desktop app instead, so it stays where it is");
      const size = bytes?.length ?? file.size;
      if (size === 0) throw new Error("it is empty");
      let sent = 0;
      a.sent = 0;
      while (sent < size) {
        // taken off meanwhile: nothing more goes
        if (!this.list(group).includes(a)) return;
        const end = Math.min(size, sent + PIECE);
        const piece = bytes ? bytes.subarray(sent, end) : new Uint8Array(await file.slice(sent, end).arrayBuffer());
        const r: { upload: string; received: number } = await this.d.rpc.request("group.upload", { group, ...(a.upload ? { upload: a.upload } : {}), name: a.name, size, at: sent, data: toBase64(piece), ...(a.kind === "photo" ? { photo: true } : {}) });
        a.upload = r.upload;
        a.sent = sent = r.received;
        this.d.draw();
      }
      a.done = true;
    } catch (e) {
      a.error = e instanceof ViewRpcError ? this.d.words(e) : e instanceof Error ? e.message : String(e);
    }
    this.d.draw();
  }

  remove(group: string, key: string): void {
    const l = this.list(group);
    const i = l.findIndex((a) => a.key === key);
    if (i >= 0) l.splice(i, 1);
    this.d.draw();
  }

  /** What a post from the composer carries, or why it waits; cleared once it went. */
  forPost(group: string): ReturnType<typeof attachParams> {
    return attachParams(this.list(group));
  }

  posted(group: string): void {
    this.d.media.attached.delete(group);
  }

  /** A photo's data URL once it came; asked for when it has not, a piece at a time. */
  photo(group: string, ph: GroupPhoto): string | undefined {
    const m = this.d.media.photos;
    const kept = m.get(ph.id);
    if (kept?.url) return kept.url;
    if (kept?.loading || (kept?.failedAt !== undefined && Date.now() - kept.failedAt < PHOTO_RETRY_MS) || !this.d.state.connected) return undefined;
    m.set(ph.id, { loading: true });
    void (async () => {
      try {
        // pieces are whole thirds of bytes, so their base64 joins as it is
        let data = "";
        let at = 0;
        let total = ph.bytes;
        while (at < total) {
          const r = await this.d.rpc.request<{ type: string; data: string; at: number; total: number }>("group.photo", { group, photo: ph.id, ...(at > 0 ? { at } : {}) });
          if (r.at !== at || r.data === "") throw new Error("the photo came short");
          data += r.data;
          at += Math.floor((r.data.length * 3) / 4) - (r.data.endsWith("==") ? 2 : r.data.endsWith("=") ? 1 : 0);
          total = r.total;
        }
        m.set(ph.id, { url: `data:${ph.type};base64,${data}` });
      } catch {
        m.set(ph.id, { failedAt: Date.now() });
      }
      this.d.draw();
    })();
    return undefined;
  }

  /** Save on a post's file: the machines to put it on are offered under it. */
  openSave(group: string, post: string, file: string): void {
    const s = this.d.media.save;
    this.d.media.save = s?.post === post && s.file === file ? undefined : { group, post, file };
    this.d.draw();
  }

  /** A copy of the file into the Downloads folder of `node`; over 1 GB through the relay, asked first in place. */
  async save(node: string, relayOk = false): Promise<void> {
    const s = this.d.media.save;
    if (!s || s.busy) return;
    s.busy = true;
    s.error = undefined;
    this.d.draw();
    try {
      const r = await this.d.rpc.request<{ transfer?: Transfer; confirm?: { bytes: number } }>("group.file.save", { group: s.group, post: s.post, file: s.file, to: { node }, ...(relayOk ? { relayOk: true } : {}) });
      if (r.confirm) s.confirm = { node, bytes: r.confirm.bytes };
      else {
        if (r.transfer) this.d.dispatch({ type: "transfer.state", params: r.transfer });
        this.d.media.save = undefined;
      }
    } catch (e) {
      s.error = this.d.words(e);
    } finally {
      s.busy = false;
      this.d.draw();
    }
  }

  /** A press on these parts' buttons; false for any other. */
  click(target: HTMLElement, group: string | undefined): boolean {
    const data = target.dataset;
    const media = this.d.media;
    switch (data["action"]) {
      case "group-attach":
        target.closest(".group-composer")?.querySelector<HTMLInputElement>(data["photo"] === "true" ? ".group-pick-photo" : ".group-pick-file")?.click();
        return true;
      case "group-attach-remove":
        if (group !== undefined && data["key"]) this.remove(group, data["key"]);
        return true;
      case "group-photo-open":
        if (group !== undefined && data["photo"]) media.viewing = { group, photo: data["photo"] };
        this.d.draw();
        return true;
      case "group-photo-close":
        media.viewing = undefined;
        this.d.draw();
        return true;
      case "group-file-save":
        if (group !== undefined && data["post"] && data["file"]) this.openSave(group, data["post"], data["file"]);
        return true;
      case "group-file-save-to":
        if (data["node"]) void this.save(data["node"], data["relay"] === "true");
        return true;
      case "group-file-save-cancel":
        media.save = undefined;
        this.d.draw();
        return true;
      default:
        return false;
    }
  }

  /** A file input changed: what it picked is attached. */
  change(target: HTMLElement, group: string | undefined): boolean {
    if (!target.matches(".group-pick-photo, .group-pick-file")) return false;
    const input = target as HTMLInputElement;
    if (group !== undefined && input.files) this.pick(group, Array.from(input.files), input.classList.contains("group-pick-photo"));
    input.value = "";
    return true;
  }

  /** Escape: the photo shown full size, then the machines offered for a file. */
  escape(): boolean {
    if (this.d.media.viewing) {
      this.d.media.viewing = undefined;
      this.d.draw();
      return true;
    }
    if (this.d.media.save) {
      this.d.media.save = undefined;
      this.d.draw();
      return true;
    }
    return false;
  }
}

// --- drawn ---------------------------------------------------------------------------------------------

/** The composer's attach buttons and their inputs, and the strip of what is attached. */
export function createAttach(): { buttons: HTMLElement; strip: HTMLElement } {
  const buttons = el("div", "group-attach");
  const photo = actionButton("group-attach-button", "", "group-attach");
  photo.dataset["photo"] = "true";
  photo.title = "Add photos";
  photo.setAttribute("aria-label", "Add photos");
  photo.append(el("span", "group-attach-photo-mark"));
  const file = actionButton("group-attach-button", "", "group-attach");
  file.title = "Attach files";
  file.setAttribute("aria-label", "Attach files");
  file.append(el("span", "group-attach-file-mark"));
  const pickPhoto = el("input", "group-pick-photo");
  pickPhoto.type = "file";
  pickPhoto.accept = "image/*";
  pickPhoto.multiple = true;
  pickPhoto.hidden = true;
  const pickFile = el("input", "group-pick-file");
  pickFile.type = "file";
  pickFile.multiple = true;
  pickFile.hidden = true;
  buttons.append(photo, file, pickPhoto, pickFile);
  return { buttons, strip: el("ul", "group-attached") };
}

export function renderAttach(form: HTMLElement, list: readonly Attached[], mayPost: boolean): void {
  for (const b of Array.from(form.querySelectorAll<HTMLButtonElement>(".group-attach-button"))) b.disabled = !mayPost;
  const strip = form.querySelector<HTMLElement>(".group-attached")!;
  setHidden(strip, list.length === 0);
  reconcile(strip, [...list], (a) => a.key, createAttached, updateAttached);
}

function createAttached(): HTMLElement {
  const li = el("li", "group-attached-item");
  const look = el("img", "group-attached-look");
  look.alt = "";
  const x = actionButton("group-attached-x", "×", "group-attach-remove");
  li.append(look, el("span", "group-attached-name"), el("span", "group-attached-words"), x);
  return li;
}

function updateAttached(li: HTMLElement, a: Attached): void {
  setData(li, "kind", a.kind);
  setData(li, "error", String(a.error !== undefined));
  const look = li.querySelector<HTMLImageElement>(".group-attached-look")!;
  if (a.preview && look.src !== a.preview) look.src = a.preview;
  setHidden(look, a.preview === undefined);
  setText(li.querySelector(".group-attached-name")!, a.name);
  const size = a.bytes !== undefined ? bytesWords(a.bytes) : "";
  const words = a.error ?? (a.path !== undefined ? "stays where it is" : a.done ? size : a.sent !== undefined && a.bytes ? `${Math.floor((a.sent / a.bytes) * 100)}% of ${size}` : "getting ready…");
  setText(li.querySelector(".group-attached-words")!, words);
  const x = li.querySelector<HTMLButtonElement>(".group-attached-x")!;
  setData(x, "key", a.key);
  x.setAttribute("aria-label", `Take ${a.name} off`);
  x.title = `Take ${a.name} off`;
  li.title = a.path ?? a.name;
}

/** A post's photos and files, built once into the post. */
export function createPostMedia(): HTMLElement[] {
  return [el("div", "group-post-photos"), el("ul", "group-post-files")];
}

export function renderPostMedia(li: HTMLElement, group: string, post: string, photos: readonly GroupPhoto[], files: readonly GroupFile[], state: ViewState, media: MediaUi): void {
  const grid = li.querySelector<HTMLElement>(".group-post-photos")!;
  setHidden(grid, photos.length === 0);
  setData(grid, "count", String(photos.length));
  reconcile(grid, [...photos], (p) => p.id, createPhoto, (n, p) => updatePhoto(n, p, current?.photo(group, p) ?? media.photos.get(p.id)?.url));
  const list = li.querySelector<HTMLElement>(".group-post-files")!;
  setHidden(list, files.length === 0);
  reconcile(list, [...files], (f) => f.id, createFile, (n, f) => updateFile(n, f, post, state, media));
}

function createPhoto(): HTMLElement {
  const b = actionButton("group-photo", "", "group-photo-open");
  const img = el("img", "group-photo-img");
  b.append(img);
  return b;
}

function updatePhoto(b: HTMLElement, p: GroupPhoto, url: string | undefined): void {
  setData(b, "photo", p.id);
  setData(b, "loaded", String(url !== undefined));
  b.style.setProperty("--ratio", `${p.width} / ${p.height}`);
  const img = b.querySelector<HTMLImageElement>(".group-photo-img")!;
  if (url && img.src !== url) img.src = url;
  setHidden(img, url === undefined);
  img.alt = p.name ?? "photo";
  b.title = `${p.name ?? "Photo"} · ${p.width}×${p.height} · press to see it whole`;
  b.setAttribute("aria-label", `Photo ${p.name ?? ""}: see it whole`);
}

function createFile(): HTMLElement {
  const li = el("li", "group-file");
  const head = el("div", "group-file-head");
  const save = actionButton("group-file-save", "Save", "group-file-save");
  save.title = "Copy it into a Downloads folder of one of your machines";
  head.append(el("span", "group-file-mark"), el("span", "group-file-name"), el("span", "group-file-words"), save);
  const to = el("div", "group-file-to");
  to.append(el("span", "group-file-to-words"), el("div", "group-file-to-list"), actionButton("group-file-to-cancel", "Cancel", "group-file-save-cancel"));
  li.append(head, to, el("p", "group-file-error"));
  return li;
}

function updateFile(li: HTMLElement, f: GroupFile, post: string, state: ViewState, media: MediaUi): void {
  setData(li, "kind", f.kind);
  setText(li.querySelector(".group-file-name")!, f.kind === "folder" ? `${f.name}/` : f.name);
  setText(li.querySelector(".group-file-words")!, [f.kind === "folder" && f.files !== undefined ? `${f.files} ${f.files === 1 ? "file" : "files"}` : "", bytesWords(f.bytes), f.machine ? `on ${f.machine}` : ""].filter(Boolean).join(" · "));
  const save = li.querySelector<HTMLButtonElement>(".group-file-save")!;
  setData(save, "post", post);
  setData(save, "file", f.id);
  save.disabled = !state.connected || !state.scopes.includes("terminal");
  const open = media.save?.post === post && media.save.file === f.id ? media.save : undefined;
  const to = li.querySelector<HTMLElement>(".group-file-to")!;
  setHidden(to, open === undefined);
  const error = li.querySelector<HTMLElement>(".group-file-error")!;
  setText(error, open?.error ?? "");
  setHidden(error, open?.error === undefined);
  if (!open) return;
  const machines = [...state.nodes.values()].filter((n) => n.status === "online" && n.capabilities.files === true && n.scope.kind !== "workspaces");
  const here = state.client?.node;
  machines.sort((a, b) => Number(b.id === here) - Number(a.id === here) || a.name.localeCompare(b.name));
  setText(
    li.querySelector(".group-file-to-words")!,
    open.confirm ? `It is ${bytesWords(open.confirm.bytes)} and comes through the Cophyla server's relay, which counts what it carries. Save it on ${machineName(state, open.confirm.node)} anyway?` : machines.length === 0 ? "None of your machines that take files is online." : "Into the Downloads folder of:",
  );
  const choices = open.confirm ? [{ id: open.confirm.node, name: "Save it", relay: true }] : machines.map((n) => ({ id: n.id, name: n.id === here ? `${n.name} (this computer)` : n.name, relay: false }));
  reconcile(
    li.querySelector<HTMLElement>(".group-file-to-list")!,
    choices,
    (c) => `${c.id}${c.relay}`,
    () => actionButton("group-file-to-machine", "", "group-file-save-to"),
    (b, c) => {
      setText(b, c.name);
      setData(b, "node", c.id);
      setData(b, "relay", String(c.relay));
      (b as HTMLButtonElement).disabled = open.busy === true;
    },
  );
}

/** A photo shown whole over the group's pane. */
export function renderViewer(root: HTMLElement, media: MediaUi, group: string | undefined): void {
  let box = root.querySelector<HTMLElement>(":scope > .group-viewer");
  const v = media.viewing?.group === group ? media.viewing : undefined;
  const url = v ? media.photos.get(v.photo)?.url : undefined;
  if (!box) {
    if (!url) return;
    box = el("div", "group-viewer");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Photo");
    const close = actionButton("group-viewer-close", "×", "group-photo-close");
    close.setAttribute("aria-label", "Close");
    const shade = actionButton("group-viewer-shade", "", "group-photo-close");
    shade.tabIndex = -1;
    box.append(shade, el("img", "group-viewer-img"), close);
    root.append(box);
  }
  setHidden(box, url === undefined);
  const img = box.querySelector<HTMLImageElement>(".group-viewer-img")!;
  if (url && img.src !== url) img.src = url;
}
