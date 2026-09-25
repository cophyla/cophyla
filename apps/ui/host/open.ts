// `host.open` in the desktop app. A desktop this machine has no route to is shown through a
// forwarder cophylad runs on this machine's loopback; the view hands that stream page here, and
// the shell opens it in a window of its own. Nothing else opens: the viewer for a desktop
// with a route is moonlight, which cophylad starts itself. When the shell says a stream's window
// closed, the node ends the session; when the link to cophylad goes, its forwarders went with
// it, and the windows close.

/** What the host needs of the shell and the link. */
export interface StreamDeps {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  request: (method: string, params: unknown) => Promise<unknown>;
  log?: (message: string) => void;
}

/** The stream page and its id from what the view handed `host.open`, or why it does not open. */
export function streamOf(params: unknown): { url: string; stream: string } | { refuse: string } {
  const p = (params ?? {}) as { url?: unknown; stream?: unknown };
  if (typeof p.url !== "string") return { refuse: "host.open needs a url" };
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    return { refuse: "that link cannot be opened" };
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "http:" || !loopback || url.port === "" || !url.pathname.startsWith("/remote/") || url.username !== "" || url.password !== "") {
    return { refuse: "this app opens only a stream page from its own node" };
  }
  if (typeof p.stream !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(p.stream)) return { refuse: "the stream did not say which it is" };
  return { url: url.href, stream: p.stream };
}

/** The stream windows the host opened, and their ends. */
export class StreamWindows {
  private deps: StreamDeps;
  private open = new Set<string>();

  constructor(deps: StreamDeps) {
    this.deps = deps;
  }

  /** Streams whose window is open. */
  get count(): number {
    return this.open.size;
  }

  /** The host's own requests a view may make: `host.open`. */
  readonly host = async (method: string, params: unknown): Promise<unknown> => {
    if (method !== "host.open") throw new Error(`no ${method}`);
    const s = streamOf(params);
    if ("refuse" in s) throw new Error(s.refuse);
    await this.deps.invoke("stream_open", { url: s.url, stream: s.stream });
    this.open.add(s.stream);
    return {};
  };

  /** The shell closed a stream's window: the node ends its session. */
  closed(stream: string): void {
    if (!this.open.delete(stream)) return;
    this.deps.request("remote.close", { stream }).catch((e: unknown) => this.deps.log?.(`the node did not hear the stream close: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The link to cophylad went, and the forwarders the windows read through with it. */
  linkLost(): void {
    for (const stream of this.open) void this.deps.invoke("stream_close", { stream }).catch(() => undefined);
  }
}
