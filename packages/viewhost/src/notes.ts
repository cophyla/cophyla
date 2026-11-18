// A note an agent left the user (`notify_user`), on an OS notification: a fresh open note that
// waits for the user's answer or is urgent is toasted once, under its own id (`note:<id>`),
// and taken down once it is read, answered or dismissed. Like asks and tags, it is toasted only
// where someone is at the machine, so a cluster's desktops do not all chime. The window in
// front shows no toast (the shell's own rule for every toast). The toast has no buttons: a click
// shows the window and goes to the note where the agent left it (`revealOf`, which the host
// hands the view as `host.reveal`). A note met first after a start or a reconnect, older than
// `NOTE_FRESH_MS`, is not toasted: the bell in the view has it. DOM-free.

import type { Note, RpcNotification, Session } from "@cophyla/protocol";
import { AWAY_MS } from "./notify.ts";
import type { NotifyAsk } from "./notify.ts";

/** A note this much older than now, met first, is not new. */
export const NOTE_FRESH_MS = 2 * 60_000;
const DETAIL_CHARS = 200;
const PREFIX = "note:";

export interface NoteNotifierDeps {
  notify: (toast: NotifyAsk) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  onError?: (message: string) => void;
  /** How long since the last keyboard or mouse input on this machine; undefined when it cannot tell. */
  idleMs?: () => Promise<number | undefined>;
  now?: () => number;
}

/** The toast's id for a note. */
export function noteToastId(note: string): string {
  return `${PREFIX}${note}`;
}

/** Whether a note is open: waiting for an answer not given yet, or else not read, and not dismissed. */
function open(n: Note): boolean {
  if (n.dismissed) return false;
  return n.needsAnswer ? !n.answered : n.read === undefined;
}

export class NoteNotifier {
  private deps: NoteNotifierDeps;
  private now: () => number;
  /** Every note met, by id, as it was last told: where a toast's click goes. */
  private notes = new Map<string, Note>();
  /** The notes toasted, so each is toasted once. */
  private toasted = new Set<string>();
  /** The toasts up now. */
  private up = new Set<string>();
  /** The sessions' names, as `session.state` says them. */
  private names = new Map<string, string>();

  constructor(deps: NoteNotifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  onNotification(n: RpcNotification): void {
    if (n.method === "session.state") {
      const s = n.params as Session;
      if (s.status === "ended") this.names.delete(s.id);
      else this.names.set(s.id, nameOf(s));
      return;
    }
    if (n.method === "note.state") void this.onNote(n.params as Note);
  }

  /** Where a note's toast goes when it is clicked: its session and the point in it; undefined for any other toast, or a note gone. */
  revealOf(toastId: string): { session: string; seq: number; note: string } | undefined {
    if (!toastId.startsWith(PREFIX)) return undefined;
    const id = toastId.slice(PREFIX.length);
    const n = this.notes.get(id);
    return n ? { session: n.session, seq: n.seq, note: n.id } : undefined;
  }

  private async onNote(n: Note): Promise<void> {
    if (n.dismissed) this.notes.delete(n.id);
    else this.notes.set(n.id, n);
    if (!open(n)) {
      this.takeDown(n.id);
      return;
    }
    if (this.toasted.has(n.id) || !(n.needsAnswer || n.urgent) || this.now() - n.at > NOTE_FRESH_MS) return;
    this.toasted.add(n.id);
    if (this.toasted.size > 500) this.toasted.delete(this.toasted.values().next().value!);
    if (!(await this.someoneHere())) return;
    const who = this.names.get(n.session) ?? "An agent";
    const why = n.needsAnswer ? "waiting for your answer" : "urgent";
    const toast: NotifyAsk = { id: noteToastId(n.id), title: n.title, detail: `${who} · ${why}${n.detail ? `\n${cut(n.detail)}` : ""}`, options: [], multiple: true };
    this.up.add(n.id);
    this.deps.notify(toast).catch((e: unknown) => this.deps.onError?.(`notification: ${messageOf(e)}`));
  }

  private takeDown(id: string): void {
    if (!this.up.delete(id)) return;
    this.deps.dismiss(noteToastId(id)).catch((e: unknown) => this.deps.onError?.(`dismiss note ${id}: ${messageOf(e)}`));
  }

  private async someoneHere(): Promise<boolean> {
    if (!this.deps.idleMs) return true;
    try {
      const idle = await this.deps.idleMs();
      return idle === undefined || idle < AWAY_MS;
    } catch (e) {
      this.deps.onError?.(`idle time: ${messageOf(e)}`);
      return true;
    }
  }
}

/** A session as a toast names it: its title, else its intent, else its folder's name. */
function nameOf(s: Session): string {
  if (s.title) return s.title;
  if (s.intent) return s.intent;
  const parts = s.cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? s.cwd;
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
