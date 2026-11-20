// Why a line was not read out, in the user's words: what the app shows beside the Listen that
// was pressed, sent with the `idle` that ends the speech (`voice.state {failed}`). The cause is
// read from the error the engine threw: an online voice that did not answer in time, refused its
// key, is over its limit, or is not set up at all; anything else is said plainly as a failure.
// The log keeps the error itself.

import { RpcError } from "@cophyla/protocol";

/** What is said when nothing of the line was heard, or when it stopped after some of it was. */
export function speechFailure(e: unknown, partway: boolean): string {
  return `${partway ? "Stopped partway" : "Not read out"}: ${why(e)}.`;
}

function why(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const codes = new Set<string>();
  if (e instanceof RpcError) {
    codes.add(e.code);
    // every route's own code, when no route could speak (`onlineTts`)
    const routes = (e.error.data as { codes?: unknown } | undefined)?.codes;
    if (Array.isArray(routes)) for (const c of routes) if (typeof c === "string") codes.add(c);
  }
  if (codes.has("timeout") || /stalled past|timed out/i.test(text)) return "the online voice did not answer in time";
  if (/the key was refused/i.test(text)) return "the online voice refused its key";
  if (codes.has("quota_exceeded")) return "the online voice is over its limit, try again in a moment";
  if (/no DeepInfra API key|not configured|no account on this node/i.test(text)) return "no online voice is set up; add a DeepInfra key in Settings, Voice, or pick a voice on this machine";
  return "the voice could not read it";
}
