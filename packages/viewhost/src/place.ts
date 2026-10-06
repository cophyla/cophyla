// Where a stream page goes when a host lays it over the view: the view names a rectangle in
// its own frame's coordinates (`host.place`), and the host puts the page there in its own,
// kept inside the frame. Shared by the hosts that lay a page over the view: the desktop app,
// whose shell places a web view, and the controller page in a desktop browser, which places
// a frame of its own. DOM-free.

/** A rectangle, in CSS pixels. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A place as the view gives it: its own frame's coordinates. */
export interface Place {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A stream's id, as `remote.open` names it. */
export const STREAM_ID = /^[A-Za-z0-9_]{1,64}$/;

/** What a `host.place` asks: which stream, and where in the view's frame, or `null` to hide it. */
export function placeOf(params: unknown): { stream: string; rect: Place | null } | { refuse: string } {
  const p = (params ?? {}) as { stream?: unknown; rect?: unknown };
  if (typeof p.stream !== "string" || !STREAM_ID.test(p.stream)) return { refuse: "host.place needs a stream" };
  if (p.rect === null) return { stream: p.stream, rect: null };
  const r = (p.rect ?? {}) as Record<string, unknown>;
  const n = [r["x"], r["y"], r["width"], r["height"]];
  if (!n.every((v) => typeof v === "number" && Number.isFinite(v))) return { refuse: "host.place needs a rect, or null" };
  const [x, y, width, height] = n as number[];
  return { stream: p.stream, rect: { x: x!, y: y!, width: width!, height: height! } };
}

/**
 * Where a place is in the window: the frame's offset added, cut to the frame, rounded to whole
 * pixels; nothing when too little of it is left to show.
 */
export function windowPlace(rect: Place, frame: Box): Place | undefined {
  const left = Math.max(frame.left, frame.left + rect.x);
  const top = Math.max(frame.top, frame.top + rect.y);
  const right = Math.min(frame.left + frame.width, frame.left + rect.x + rect.width);
  const bottom = Math.min(frame.top + frame.height, frame.top + rect.y + rect.height);
  const x = Math.round(left);
  const y = Math.round(top);
  const width = Math.round(right) - x;
  const height = Math.round(bottom) - y;
  if (width < 8 || height < 8) return undefined;
  return { x, y, width, height };
}
