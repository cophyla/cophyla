// The host's microphone recording, as the bridge tells a view: `host.recording` at each start
// and stop, `host.levels` only in between, both only to a view holding the voice scope, and
// `host.recording` again after `host.ready` for a view that loads while it records.

import { describe, expect, test } from "bun:test";
import type { RpcMessage, Scope, ViewManifest } from "@cophyla/protocol";
import { Bridge } from "../src/bridge.ts";
import type { HelloResult } from "../src/connection.ts";

const SCOPES: Scope[] = ["sessions:read", "chat", "voice"];
const MANIFEST: ViewManifest = { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin", scopes: SCOPES };
const HELLO: HelloResult = {
  client: { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", scopes: SCOPES, via: "direct", audio: { in: true, out: true }, connectedAt: 1 },
  node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  protocolVersion: 1,
  platformVersion: "0.1.0",
};

function make(scopes: Scope[] = SCOPES) {
  const toView: RpcMessage[] = [];
  const bridge = new Bridge({ manifest: { ...MANIFEST, scopes }, clientScopes: SCOPES, instance: 1 }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
  const heard = (method: string) => toView.filter((f) => (f as { method?: string }).method === method).map((f) => (f as { params: unknown }).params);
  return { bridge, toView, heard };
}

describe("recording, as a view hears it", () => {
  test("a start and a stop each once, and the levels only between them", () => {
    const { bridge, heard } = make();
    bridge.levels([0.5, 0.5]);
    bridge.recording(true);
    bridge.recording(true);
    bridge.levels([0.2, 0.9]);
    bridge.recording(false);
    bridge.levels([0.4, 0.4]);
    expect(heard("host.recording")).toEqual([{ active: true }, { active: false }]);
    expect(heard("host.levels")).toEqual([{ levels: [0.2, 0.9] }]);
  });

  test("a view loaded while the microphone records hears so after its ready, and not once it stopped", () => {
    const { bridge, toView, heard } = make();
    bridge.recording(true);
    bridge.ready(HELLO);
    expect(toView.at(-1)).toEqual({ jsonrpc: "2.0", method: "host.recording", params: { active: true } });
    bridge.recording(false);
    bridge.ready(HELLO);
    expect(heard("host.recording")).toEqual([{ active: true }, { active: true }, { active: false }]);
  });

  test("a view without the voice scope hears nothing of the microphone", () => {
    const { bridge, toView } = make(["sessions:read", "chat"]);
    bridge.recording(true);
    bridge.levels([0.3, 0.3]);
    bridge.ready(HELLO);
    bridge.recording(false);
    expect(toView.map((f) => (f as { method?: string }).method)).toEqual(["host.ready", "host.state"]);
  });
});
