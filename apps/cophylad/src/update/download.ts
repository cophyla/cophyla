// One artifact to disk: streamed into `<dest>.partial` with the size and hash checked as it
// lands, renamed to `dest` only when both match, and nothing left behind otherwise.

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export interface DownloadOptions {
  size: number;
  sha256: string;
  fetch?: typeof fetch;
  /** Sent with the request: the account's bearer for an artifact on the beta feed's origin. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Called with the fraction received, 0..1, about once per percent. */
  onProgress?: (fraction: number) => void;
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export async function download(url: string, dest: string, opts: DownloadOptions): Promise<void> {
  const partial = dest + ".partial";
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(partial, { force: true });
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { signal: opts.signal ?? null, redirect: "follow", ...(opts.headers ? { headers: opts.headers } : {}) });
  } catch (e) {
    throw new DownloadError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok || !res.body) throw new DownloadError(`${url}: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared !== opts.size) throw new DownloadError(`${url}: content-length ${declared}, expected ${opts.size}`);
  const hash = createHash("sha256");
  let received = 0;
  let lastReported = -1;
  const file = Bun.file(partial).writer();
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > opts.size) throw new DownloadError(`${url}: more than ${opts.size} bytes`);
      hash.update(value);
      file.write(value);
      if (opts.onProgress) {
        const pct = Math.floor((received / opts.size) * 100);
        if (pct !== lastReported) {
          lastReported = pct;
          opts.onProgress(received / opts.size);
        }
      }
    }
    await file.end();
  } catch (e) {
    try {
      await file.end();
    } catch {
      // already closed
    }
    rmSync(partial, { force: true });
    if (e instanceof DownloadError) throw e;
    throw new DownloadError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (received !== opts.size) {
    rmSync(partial, { force: true });
    throw new DownloadError(`${url}: ${received} bytes, expected ${opts.size}`);
  }
  const digest = hash.digest("hex");
  if (digest !== opts.sha256.toLowerCase()) {
    rmSync(partial, { force: true });
    throw new DownloadError(`${url}: sha256 ${digest}, expected ${opts.sha256}`);
  }
  rmSync(dest, { force: true, recursive: true });
  renameSync(partial, dest);
}
