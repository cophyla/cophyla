// A Listen pressed, as the view keeps it: getting it ready until the node says its first audio
// left, Stop while it plays, Listen again once it is over; when the voice could not read it, why,
// beside the button for a while; another device's speech never moves it.

import { afterEach, describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client } from "@cophyla/protocol";
import { FAILED_MS, ListenControl, newListenUi, remember } from "../views/default/listenctl.ts";
import { apply, initialState } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ME = "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7";

function connected(): ViewState {
  const scopes = [...ACCESS_PRESETS.full.scopes];
  const client: Client = { id: ME, kind: "ui", node: DESK, scopes, via: "direct", audio: { in: true, out: true, asked: true }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.29.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  return state;
}

/** A control over a fake host: the requests it sends, and what each answers. */
function rig(answer: (method: string, params: unknown) => Promise<unknown> = async () => ({ chars: 10 })) {
  const sent: { method: string; params: unknown }[] = [];
  const rpc = { request: (method: string, params?: unknown) => (sent.push({ method, params }), answer(method, params)) };
  const ui = { listen: newListenUi() };
  let draws = 0;
  const failures: string[] = [];
  const ctl = new ListenControl({ rpc, state: connected(), ui, draw: () => draws++, fail: (what) => failures.push(what) });
  const press = (key: string) => ctl.click({ dataset: { action: "listen", key } });
  return { ctl, ui, sent, press, draws: () => draws, failures };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a Listen pressed", () => {
  afterEach(() => undefined);

  test("getting it ready until its first audio leaves, Stop while it plays, Listen again once it is over", async () => {
    remember("s/t1", "## Done\n\nThe migration ran.");
    const r = rig();
    expect(r.press("s/t1")).toBe(true);
    expect(r.ui.listen).toEqual({ key: "s/t1", phase: "starting" });
    await settle();
    expect(r.sent).toEqual([{ method: "voice.preview", params: { text: "## Done\n\nThe migration ran.", read: true } }]);
    // the line begins: still getting ready, the voice has made nothing yet
    r.ctl.voiceState({ state: "speaking", client: ME });
    expect(r.ui.listen.phase).toBe("starting");
    // another device's speech moves nothing
    r.ctl.voiceState({ state: "speaking", client: "cli_other", sounding: true });
    r.ctl.voiceState({ state: "idle", client: "cli_other", failed: "Not read out: the online voice did not answer in time." });
    expect(r.ui.listen).toEqual({ key: "s/t1", phase: "starting" });
    r.ctl.voiceState({ state: "speaking", client: ME, sounding: true });
    expect(r.ui.listen.phase).toBe("playing");
    r.ctl.voiceState({ state: "idle", client: ME });
    expect(r.ui.listen).toEqual({});
  });

  test("Stop, while getting it ready or playing, ends it at once", async () => {
    remember("s/t2", "Some words.");
    const r = rig();
    r.press("s/t2");
    await settle();
    r.press("s/t2");
    expect(r.ui.listen).toEqual({});
    await settle();
    expect(r.sent.at(-1)).toEqual({ method: "voice.preview", params: { stop: true } });
  });

  test("the voice could not read it: why, beside its button, until the time is up or another is pressed", async () => {
    remember("s/t3", "Some words.");
    remember("s/t4", "Other words.");
    const r = rig();
    r.press("s/t3");
    await settle();
    r.ctl.voiceState({ state: "speaking", client: ME });
    r.ctl.voiceState({ state: "idle", client: ME, failed: "Not read out: the online voice did not answer in time." });
    expect(r.ui.listen.key).toBeUndefined();
    expect(r.ui.listen.failed).toMatchObject({ key: "s/t3", words: "Not read out: the online voice did not answer in time." });
    // pressing again takes the words away
    r.press("s/t4");
    expect(r.ui.listen.failed).toBeUndefined();
    expect(FAILED_MS).toBeGreaterThanOrEqual(8000);
  });

  test("refused at once (the voice is off, a muted app from before): the node's words, beside the button", async () => {
    remember("s/t5", "Some words.");
    const r = rig(async () => {
      throw new Error("speech is uninstalled");
    });
    r.press("s/t5");
    await settle();
    await settle();
    expect(r.ui.listen.key).toBeUndefined();
    expect(r.ui.listen.failed).toMatchObject({ key: "s/t5", words: "Not read out: speech is uninstalled." });
  });
});
