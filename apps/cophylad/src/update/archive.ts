// Unpacking a `.tar.gz` release artifact. Windows ships a `tar` under System32 and every
// other platform has one on PATH, so nothing is bundled for this; the caller passes the
// path from `defaultTar()`.

export interface ExtractOptions {
  tar?: string;
  /** Leading path components to strip, for an archive with one directory at its root. */
  strip?: number;
}

/** Extracts `archive` into `dest`, which must already exist. Throws with tar's own words. */
export async function extractTarGz(archive: string, dest: string, opts: ExtractOptions = {}): Promise<void> {
  return run(opts.tar ?? "tar", ["-xzf", archive, "-C", dest, ...(opts.strip ? [`--strip-components=${opts.strip}`] : [])]);
}

/**
 * Extracts a `.zip` the same way: the System32 `tar` on Windows and macOS's are bsdtar,
 * which reads zip archives; a Linux GNU tar does not, but the archives that matter there
 * are `.tar.gz`.
 */
export async function extractZip(archive: string, dest: string, opts: ExtractOptions = {}): Promise<void> {
  return run(opts.tar ?? "tar", ["-xf", archive, "-C", dest, ...(opts.strip ? [`--strip-components=${opts.strip}`] : [])]);
}

async function run(tar: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([tar, ...args], { stdout: "ignore", stderr: "pipe", windowsHide: true });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`tar exited ${code}: ${stderr.trim().slice(0, 500)}`);
}
