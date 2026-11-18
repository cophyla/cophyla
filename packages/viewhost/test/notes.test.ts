// A note an agent left the user, on an OS notification: a fresh open one that waits for an
// answer or is urgent is toasted once under its own id, with its session's name; one that only
// says something is not, nor one met first that is old (after a start or a reconnect). Read,
// answered or dismissed, its toast goes. Only where someone is at the machine. A toast's click
// goes to the note's session and point.

import { describe, expect, test } from "bun:test";
import type { Note, RpcNotification, Session } from "@cophyla/protocol";
import { NOTE_FRESH_MS, NoteNotifier, noteToastId } from "../src/notes.ts";
import type { NotifyAsk } from "../src/notify.ts";

const n = (method: string, params: unknown): RpcNotification => ({ jsonrpc: "2.0", method, params });
const NOW = 1_758_000_000_000;
const S = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";

function note(extra: Partial<Note> = {}): Note {
  return { id: "nte_01ARZ3NDEKTSV4RRFFQ69G5NT1", session: S, seq: 212, title: "Deploy to staging?", needsAnswer: true, urgent: false, at: NOW - 1000, ...extra };
}

function rig(opts: { idle?: number } = {}) {
  const shown: NotifyAsk[] = [];
  const gone: string[] = [];
  const notifier = new NoteNotifier({
    notify: async (t) => void shown.push(t),
    dismiss: async (id) => void gone.push(id),
    ...(opts.idle !== undefined ? { idleMs: async () => opts.idle } : {}),
    now: () => NOW,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { notifier, shown, gone, flush };
}

describe("notes on OS notifications", () => {
  test("one that waits for an answer is toasted once, named by its session; read and answered it goes", async () => {
    const r = rig();
    r.notifier.onNotification(n("session.state", { id: S, cwd: "C:\\work\\api", title: "api-migration", status: "busy" } as Session));
    const a = note({ detail: "Staging is free\nuntil 14:00." });
    r.notifier.onNotification(n("note.state", a));
    r.notifier.onNotification(n("note.state", { ...a, seq: 215 }));
    await r.flush();
    expect(r.shown).toEqual([{ id: noteToastId(a.id), title: "Deploy to staging?", detail: "api-migration · waiting for your answer\nStaging is free until 14:00.", options: [], multiple: true }]);
    // the click goes to where the note is now
    expect(r.notifier.revealOf(noteToastId(a.id))).toEqual({ session: S, seq: 215, note: a.id });
    expect(r.notifier.revealOf("ask_01ARZ3NDEKTSV4RRFFQ69G5FB1")).toBeUndefined();
    // read, it still waits; answered, it goes
    r.notifier.onNotification(n("note.state", { ...a, read: NOW }));
    expect(r.gone).toEqual([]);
    r.notifier.onNotification(n("note.state", { ...a, read: NOW, answered: { at: NOW, seq: 230, text: "yes" } }));
    expect(r.gone).toEqual([noteToastId(a.id)]);
  });

  test("an urgent one is toasted; one that only tells, an old one met first, or no one at the machine, not", async () => {
    const r = rig();
    r.notifier.onNotification(n("note.state", note({ id: "nte_01ARZ3NDEKTSV4RRFFQ69G5NT2", needsAnswer: false })));
    r.notifier.onNotification(n("note.state", note({ id: "nte_01ARZ3NDEKTSV4RRFFQ69G5NT3", at: NOW - NOTE_FRESH_MS - 1 })));
    r.notifier.onNotification(n("note.state", note({ id: "nte_01ARZ3NDEKTSV4RRFFQ69G5NT4", needsAnswer: false, urgent: true })));
    await r.flush();
    expect(r.shown.map((t) => [t.id, t.detail])).toEqual([[noteToastId("nte_01ARZ3NDEKTSV4RRFFQ69G5NT4"), "An agent · urgent"]]);
    // dismissed, it goes, and its click goes nowhere
    r.notifier.onNotification(n("note.state", note({ id: "nte_01ARZ3NDEKTSV4RRFFQ69G5NT4", needsAnswer: false, urgent: true, dismissed: true })));
    expect(r.gone).toEqual([noteToastId("nte_01ARZ3NDEKTSV4RRFFQ69G5NT4")]);
    expect(r.notifier.revealOf(noteToastId("nte_01ARZ3NDEKTSV4RRFFQ69G5NT4"))).toBeUndefined();
    const away = rig({ idle: 5 * 60_000 });
    away.notifier.onNotification(n("note.state", note()));
    await away.flush();
    expect(away.shown).toEqual([]);
    // not up, so nothing to take down
    away.notifier.onNotification(n("note.state", note({ dismissed: true })));
    expect(away.gone).toEqual([]);
  });
});
