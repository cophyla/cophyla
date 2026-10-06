// The controller page's content-security policy, built in one place for everything that
// serves the page over HTTP: the node's LAN listener and the page's development server. It is
// sent as a response header, on the page alone: a header can say `frame-ancestors`, which a
// `<meta>` cannot, and can name the one other origin the page frames, the node's stream
// listener, which is only known when the page is served. The page's scripts, styles, images
// and sockets are its own origin's; it frames its own origin (a view's files, the document
// frame) and the stream origin; nothing may frame it. The native app's page carries no policy:
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
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The policy as the page's source carries it in a `<meta>`, which a build takes out: a served page gets the header. */
export const CONTROLLER_META_CSP = /<meta\s+http-equiv="content-security-policy"[\s\S]*?\/>\s*/i;
