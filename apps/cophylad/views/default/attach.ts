// What a group chat's composer attaches, as the view keeps it, with no page around it: what a
// post names of it once all is there, which paths are photos, and bytes as base64.

const IMAGE_PATH = /\.(png|jpe?g|webp|gif|heic|heif|tiff?)$/i;

/** A photo or a file attached in a composer, on its way or there. */
export interface Attached {
  key: string;
  kind: "photo" | "file";
  name: string;
  bytes?: number;
  /** The upload it went as, and how much of it went. */
  upload?: string;
  sent?: number;
  done?: boolean;
  /** A file on one of the user's machines, by its path: nothing is uploaded, it stays there. */
  node?: string;
  path?: string;
  /** A photo's look in the composer. */
  preview?: string;
  error?: string;
}

/** Bytes as base64, a slice at a time so a big piece never overflows the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Whether a dropped path is a photo by its name: what the node makes a photo of. */
export function isImagePath(path: string): boolean {
  return IMAGE_PATH.test(path);
}

/** The last name of a path, whichever machine's separators it has. */
export function lastName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** What the composer may post now: the attachments as the post names them, or why it must wait. */
export function attachParams(list: readonly Attached[]): { photos: object[]; files: object[] } | { wait: string } {
  const photos: object[] = [];
  const files: object[] = [];
  for (const a of list) {
    if (a.error) return { wait: `${a.name}: ${a.error}. Take it off to post.` };
    const ref = a.path !== undefined && a.node !== undefined ? { node: a.node, path: a.path } : a.done && a.upload ? { upload: a.upload } : undefined;
    if (!ref) return { wait: `${a.name} is still uploading` };
    (a.kind === "photo" ? photos : files).push(ref);
  }
  return { photos, files };
}
