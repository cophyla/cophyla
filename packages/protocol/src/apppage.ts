// The controller page's content-security policy, built in one place for everything that
// serves the page over HTTP: the node's LAN listener and the page's development server. It is
// sent as a response header, on the page alone: a header can say `frame-ancestors`, which a
// `<meta>` cannot, and can name the one other origin the page frames, the node's stream
// listener, which is only known when the page is served. The page's scripts, styles, images
// and sockets are its own origin's, and so is the manifest a browser installs it by; it frames
// its own origin (a view's files, the document frame) and the stream origin; nothing may frame it. The native app's page carries no policy:
// its shell serves it from an origin of its own and its link goes wherever the node is.

export interface ControllerPolicy {
  /** The origin of the node's stream listener, where a remote desktop's page is framed from. */
  stream?: string;
}

export function controllerCsp(opts: ControllerPolicy = {}): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-src 'self'${opts.stream !== undefined ? ` ${opts.stream}` : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** What a stream's claim page posts to the page that framed it once it has loaded: `{ cophyla: STREAM_CLAIMED }`. */
export const STREAM_CLAIMED = "cophyla.stream.claimed";

/**
 * A page on the stream listener that says its address is open in this browser. A browser keeps
 * a certificate it was asked to accept per port and a frame cannot ask, so a stream that never
 * loads is offered this address to open once.
 */
export const STREAM_READY_PATH = "/remote/ready";

/**
 * What the page's source says of installing it: its manifest, its icon, and what a phone's
 * home screen reads. The native app's build takes these out: a shell is installed already.
 */
export const CONTROLLER_INSTALL_TAGS = /[ \t]*<(?:link\s+rel="(?:manifest|icon|apple-touch-icon)"|meta\s+name="(?:mobile-web-app-capable|apple-mobile-web-app-title)")[^>]*\/>\r?\n?/gi;

/** The policy as the page's source carries it in a `<meta>`, which a build takes out: a served page gets the header. */
export const CONTROLLER_META_CSP = /<meta\s+http-equiv="content-security-policy"[\s\S]*?\/>\s*/i;
