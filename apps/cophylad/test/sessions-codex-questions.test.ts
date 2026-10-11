// Codex's questions to the user as asks. The pieces: a `request_user_input` call and an async
// one read into questions, the reply envelope Codex's clients write, the dialog read off a
// screen, and the parser keeping a question waiting until its output, its reply or its turn's
// end. The keys: a dialog (FakeCodexDialog, the TUI's overlay) answered by digits, by the
// pointer and pasted notes, from its second question with notes open, through a paste that
// arrived as keystrokes and an Enter it swallowed, and nothing pressed into a screen without
// it. Then the adapter over the fake app-server: a dialog with no terminal shown only, asked
// once a terminal is linked, one question at a time while the session needs input, typed into
// its terminal once answered, and closed when its output comes; one answered in the terminal
// closes its ask; an async question asked beside the work, answered as the reply envelope
// through thread/queue/add, and read back as a quoted answer; the turn's end lets one go.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Ask, AskAnswer, SessionEvent, TerminalRef } from "@cophyla/protocol";
import { CodexAdapter } from "../src/sessions/codex/adapter.ts";
import { typeAnswers } from "../src/sessions/codex/asking.ts";
import type { QuestionTerminal } from "../src/sessions/codex/asking.ts";
import { asyncItemId, dialogOf, questionCall, questionReply, readableReplies, repliesIn, replyAnswer, showsQuestion, typedAnswer } from "../src/sessions/codex/questions.ts";
import type { DialogScreen } from "../src/sessions/codex/questions.ts";
import { applyCodexRow, newCodexState } from "../src/sessions/codex/rollout.ts";
import { FakeCodexDialog } from "./fakes/codex-dialog.ts";
import type { FakeQuestion } from "./fakes/codex-dialog.ts";
import { FAKE_CODEX, miniSessions, tempHome, tomlString, waitFor } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const USER = { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" } as const;
const answer = (option: string, text?: string): AskAnswer => ({ option, by: USER, at: 1, ...(text !== undefined ? { text } : {}) });

const PLAN_QUESTIONS: FakeQuestion[] = [
  { id: "playback", header: "Playback", question: "How should the first version let you watch an edited animation chain?", options: [{ label: "Live UE preview (Recommended)", description: "Play and scrub in the web app." }, { label: "Rendered chain videos", description: "UE renders each chain." }] },
  { id: "nodes", header: "Graph nodes", question: "What should the main graph show as its nodes?", options: [{ label: "Pose checkpoints (Recommended)", description: "Handoff poses." }, { label: "Animation cards", description: "Segments." }, { label: "Both", description: "Toggle." }] },
];

function blockingCall(questions = PLAN_QUESTIONS, callId = "call_q1") {
  return questionCall("request_user_input", callId, { questions }, 1000)!;
}

describe("codex questions read from their calls", () => {
  test("a request_user_input's questions, with their options' rows and the None-of-the-above row after them", () => {
    const call = blockingCall();
    expect(call.tool).toBe("request_user_input");
    expect(call.open).toEqual([0, 1]);
    const q = call.questions[1]!;
    expect(q.key).toBe("nodes");
    expect(q.text).toBe("What should the main graph show as its nodes?");
    expect(q.header).toBe("Graph nodes");
    expect(q.options.map((o) => o.label)).toEqual(["Pose checkpoints (Recommended)", "Animation cards", "Both"]);
    expect(q.options[0]!.description).toBe("Handoff poses.");
    expect(q.rows).toEqual([0, 1, 2]);
    expect(q.other).toBe(3);
    expect(q.allowsText).toBe(true);
  });

  test("an option with a blank label has no ask option but keeps its row; a question without options or text is no call", () => {
    const call = questionCall("request_user_input", "c", { questions: [{ id: "a", header: "h", question: "q?", options: [{ label: " ", description: "" }, { label: "Yes", description: "" }] }] }, 1)!;
    expect(call.questions[0]!.options.map((o) => o.label)).toEqual(["Yes"]);
    expect(call.questions[0]!.rows).toEqual([1]);
    expect(call.questions[0]!.other).toBe(2);
    expect(questionCall("request_user_input", "c", { questions: [{ id: "a", header: "h", question: "q?", options: [] }] }, 1)).toBeUndefined();
    expect(questionCall("request_user_input", "c", { questions: [] }, 1)).toBeUndefined();
    expect(questionCall("exec", "c", { questions: [{ title: "x" }] }, 1)).toBeUndefined();
  });

  test("an async question names itself as Codex's clients do, takes free text, and may have no options", () => {
    const call = questionCall("request_user_input_async", "call_a", { questions: [{ title: "Free about 6 GB?", options: ["I'll free memory", "Keep going"] }, { title: "Anything else?" }] }, 1)!;
    expect(call.questions[0]!.key).toBe('["request_user_input_async","call_a",0]');
    expect(call.questions[0]!.key).toBe(asyncItemId("call_a", 0));
    expect(call.questions[0]!.kind).toBe("choice");
    expect(call.questions[1]!.kind).toBe("input");
    expect(call.questions[1]!.allowsText).toBe(true);
  });

  test("an answer is the option's row, or None of the above for text alone, with the text as one line of notes", () => {
    const q = blockingCall().questions[1]!;
    expect(typedAnswer(q, answer("Animation cards"))).toEqual({ row: 1 });
    expect(typedAnswer(q, answer("Both", "but cards first\nthen poses"))).toEqual({ row: 2, notes: "but cards first then poses" });
    expect(typedAnswer(q, answer("text", "neither, a timeline"))).toEqual({ row: 3, notes: "neither, a timeline" });
  });

  test("the reply envelope is Codex's own, and reads back", () => {
    const q = questionCall("request_user_input_async", "call_a", { questions: [{ title: "Free\nmemory?", options: ["Yes"] }] }, 1)!.questions[0]!;
    const text = questionReply(q, replyAnswer(q, answer("Yes", "in a minute")));
    expect(text).toBe('<send_user_message_question_reply>\n[{"answer":"Yes\\n\\nin a minute","question":"Free memory?","questionItemId":"[\\"request_user_input_async\\",\\"call_a\\",0]"}]\n</send_user_message_question_reply>');
    const replies = repliesIn(text)!;
    expect(replies).toEqual([{ itemId: q.key, question: "Free memory?", answer: "Yes\n\nin a minute" }]);
    expect(readableReplies(replies)).toBe("> Free memory?\n\nYes\n\nin a minute");
    expect(repliesIn("just a message")).toBeUndefined();
    // the question is cut to 512 bytes, never inside a character
    const long = { ...q, text: "é".repeat(400) };
    expect(new TextEncoder().encode(repliesIn(questionReply(long, "a"))![0]!.question).length).toBe(512);
  });
});

describe("the dialog on a screen", () => {
  test("its question, the pointer's row and whether the notes are open, under a transcript that looks like it", () => {
    const fake = new FakeCodexDialog(PLAN_QUESTIONS);
    let d = dialogOf(fake.screen()) as DialogScreen;
    expect(d).toMatchObject({ index: 1, total: 2, selected: 0, notes: false });
    const call = blockingCall();
    expect(showsQuestion(d, call.questions[0]!)).toBe(true);
    expect(showsQuestion(d, call.questions[1]!)).toBe(false);
    fake.keys(["Down", "Tab"]);
    d = dialogOf(fake.screen()) as DialogScreen;
    expect(d).toMatchObject({ selected: 1, notes: true });
    // the last answered with the first not: the confirmation
    fake.keys(["Escape", "PageDown", "1"]);
    expect(dialogOf(fake.screen())).toEqual({ confirm: true });
    fake.keys(["1", "Enter"]);
    expect(fake.done).toBe(true);
    expect(dialogOf(fake.screen())).toBeUndefined();
  });
});

describe("codex rollout keeps the questions waiting", () => {
  const row = (type: string, payload: unknown) => ({ timestamp: "2026-10-11T06:33:17.284Z", type, payload });
  const call = row("response_item", { type: "function_call", name: "request_user_input", arguments: JSON.stringify({ questions: PLAN_QUESTIONS }), call_id: "call_q1" });
  const asyncCall = row("response_item", { type: "function_call", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "Q one?", options: ["a"] }, { title: "Q two?" }] }), call_id: "call_a" });
  const output = (id: string, out: string) => row("response_item", { type: "function_call_output", call_id: id, output: out });
  const user = (text: string) => row("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "Text", text }] } });

  test("a dialog until its output; an async question until a reply names it, its acceptance aside", () => {
    const s = newCodexState();
    applyCodexRow(s, row("event_msg", { type: "task_started", turn_id: "t1" }));
    applyCodexRow(s, call);
    applyCodexRow(s, asyncCall);
    expect([...s.questions.keys()]).toEqual(["call_q1", "call_a"]);
    applyCodexRow(s, output("call_a", '{"accepted":true}'));
    expect(s.questions.has("call_a")).toBe(true);
    applyCodexRow(s, output("call_q1", '{"answers":{}}'));
    expect(s.questions.has("call_q1")).toBe(false);
    const q0 = s.questions.get("call_a")!.questions[0]!;
    const items = applyCodexRow(s, user(questionReply(q0, "a")));
    expect(items[0]).toMatchObject({ kind: "user_message", replies: [{ itemId: q0.key, answer: "a" }] });
    expect(s.questions.get("call_a")!.open).toEqual([1]);
    applyCodexRow(s, user(questionReply(s.questions.get("call_a")!.questions[1]!, "no")));
    expect(s.questions.size).toBe(0);
  });

  test("a turn's end, abort or a new turn lets every question go", () => {
    for (const end of [row("event_msg", { type: "task_complete", turn_id: "t1" }), row("event_msg", { type: "turn_aborted", turn_id: "t1", reason: "interrupted" }), row("event_msg", { type: "task_started", turn_id: "t2" })]) {
      const s = newCodexState();
      applyCodexRow(s, call);
      applyCodexRow(s, asyncCall);
      applyCodexRow(s, end);
      expect(s.questions.size).toBe(0);
    }
  });
});

describe("answers typed into the dialog", () => {
  const timing = { showMs: 300, stepMs: 300, pollMs: 2, pasteMs: 2 };
  const call = blockingCall();
  const keys = (fake: FakeCodexDialog) => ({ screen: async () => fake.screen(), keys: async (k: string[]) => fake.keys(k), paste: async (t: string) => fake.paste(t) });

  test("options alone are their digits", async () => {
    const fake = new FakeCodexDialog(PLAN_QUESTIONS);
    await typeAnswers(keys(fake), call.questions, [{ row: 1 }, { row: 0 }], timing);
    expect(fake.keysLog).toEqual(["2", "1"]);
    expect(fake.submitted).toEqual({ playback: { answers: ["Rendered chain videos"] }, nodes: { answers: ["Pose checkpoints (Recommended)"] } });
  });

  test("notes go under the option pointed at; text alone under None of the above", async () => {
    const fake = new FakeCodexDialog(PLAN_QUESTIONS);
    await typeAnswers(keys(fake), call.questions, [{ row: 1, notes: "720p is enough" }, { row: 3, notes: "a timeline" }], timing);
    expect(fake.submitted).toEqual({ playback: { answers: ["Rendered chain videos", "user_note: 720p is enough"] }, nodes: { answers: ["None of the above", "user_note: a timeline"] } });
    expect(fake.interrupted).toBe(false);
  });

  test("from the second question, with notes open there and the pointer moved: back to the first, the notes cleared, never interrupting", async () => {
    const fake = new FakeCodexDialog(PLAN_QUESTIONS);
    fake.keys(["Down", "Down", "PageDown", "Tab", "x", "y"]);
    expect(fake.idx).toBe(1);
    await typeAnswers(keys(fake), call.questions, [{ row: 0 }, { row: 2 }], timing);
    expect(fake.interrupted).toBe(false);
    expect(fake.submitted).toEqual({ playback: { answers: ["Live UE preview (Recommended)"] }, nodes: { answers: ["Both"] } });
  });

  test("a paste that arrives as keystrokes lands in the notes, and an Enter swallowed with it is pressed again", async () => {
    const fake = new FakeCodexDialog(PLAN_QUESTIONS);
    fake.pasteAsKeys = true;
    fake.swallowEnterAfterPaste = true;
    await typeAnswers(keys(fake), call.questions, [{ row: 0, notes: "pick 2 later" }, { row: 1 }], timing);
    expect(fake.submitted).toEqual({ playback: { answers: ["Live UE preview (Recommended)", "user_note: pick 2 later"] }, nodes: { answers: ["Animation cards"] } });
  });

  test("nothing is pressed into a screen without the dialog, or with another question on it", async () => {
    const gone = new FakeCodexDialog(PLAN_QUESTIONS);
    gone.done = true;
    await expect(typeAnswers(keys(gone), call.questions, [{ row: 0 }, { row: 0 }], timing)).rejects.toThrow(/not on the terminal's screen/);
    const other = new FakeCodexDialog([{ id: "x", question: "Something else entirely, is it?", options: [{ label: "Yes" }] }, PLAN_QUESTIONS[1]!]);
    await expect(typeAnswers(keys(other), call.questions, [{ row: 0 }, { row: 0 }], timing)).rejects.toThrow(/another question/);
    expect(gone.keysLog).toEqual([]);
    expect(other.keysLog).toEqual([]);
  });
});

// --- the adapter ----------------------------------------------------------------------------------

const THREAD = "01a1299d-4e91-76b3-b0c4-d97daee96c2b";

describe("codex questions as asks, over the fake app-server", () => {
  let mini: Mini;
  let home: string;
  let rollout: string;
  let dialog: FakeCodexDialog | undefined;
  const term: TerminalRef = { host: "local", id: "term-1" };
  const terminal: QuestionTerminal & { typedInto: string[] } = {
    available: true,
    typedInto: [],
    async screen(ref) {
      this.typedInto.push(ref.id);
      return dialog ? dialog.screen() : { lines: ["› ", "  ? for shortcuts"] };
    },
    async keys(_ref, k) {
      dialog?.keys(k);
    },
    async paste(_ref, text) {
      dialog?.paste(text);
    },
  };
  const ts = () => new Date().toISOString();
  const append = (type: string, payload: unknown) => appendFileSync(rollout, JSON.stringify({ timestamp: ts(), type, payload }) + "\n");
  const session = () => mini.sessions.list().find((s) => s.native.id === THREAD)!;
  const openAsks = (): Ask[] => mini.asks.listOpen().filter((a) => a.source.kind === "harness" && a.source.session === session().id);
  const events = (): SessionEvent[] => mini.store.sessionEvents.history(session().id, { limit: 500 });
  /** Ticks, then waits for `check`: a tick the file watcher started may be the one that reads. */
  const settle = async <T>(check: () => T | undefined | false): Promise<T> => {
    await mini.sessions.tick();
    return waitFor(async () => {
      await mini.sessions.tick();
      return check();
    });
  };
  const queueLog = () => (existsSync(join(home, "queue.json")) ? (JSON.parse(readFileSync(join(home, "queue.json"), "utf8")) as { op: string; input?: { text: string }[]; clientUserMessageId?: string }[]) : []);

  beforeAll(async () => {
    const scratch = tempHome();
    home = join(scratch, "codex-home");
    const cwd = join(scratch, "work");
    mkdirSync(cwd, { recursive: true });
    const dir = join(home, "sessions", "2026", "10", "11");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    rollout = join(dir, `rollout-2026-10-11T08-18-57-${THREAD}.jsonl`);
    writeFileSync(rollout, "");
    append("session_meta", { id: THREAD, session_id: THREAD, cwd, originator: "codex-tui", cli_version: "0.162.1" });
    append("event_msg", { type: "task_started", turn_id: "turn-1" });
    append("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "Text", text: "plan the review tool" }] } });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(home, "threads.json"), JSON.stringify([{ id: THREAD, sessionId: THREAD, cwd, name: "Build animation review system", preview: "plan the review tool", path: rollout, createdAt: now - 60, updatedAt: now, status: { type: "active" } }]));
    mini = await miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\ncodex_list_ms = 1\ncodex_recent_ms = 600000\n\n[[profiles]]\nharness = "codex"\nname = "fake"\nconfig_dir = ${tomlString(home)}\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(FAKE_CODEX)}]\n`,
      (host, log, asks) => [new CodexAdapter({ host, log, version: "0.1.0", asks, askTimeoutS: 600, terminal, dialogTiming: { showMs: 500, stepMs: 500, pollMs: 2, pasteMs: 2 } })],
    );
    await mini.sessions.tick();
  });
  afterAll(() => mini.stop());

  test("a dialog in a session with no terminal is shown, for its own window to answer, and the session needs input", async () => {
    append("response_item", { type: "function_call", name: "request_user_input", arguments: JSON.stringify({ questions: PLAN_QUESTIONS }), call_id: "call_q1" });
    const ask = await settle(() => openAsks()[0]);
    expect(ask.answerableBy).toEqual([]);
    expect(ask.title).toBe(PLAN_QUESTIONS[0]!.question);
    expect(session().status).toBe("needs_input");
    expect(session().ask).toBe(ask.id);
  });

  test("a terminal linked, it is asked instead, one question at a time, and the listing reading the thread active changes nothing", async () => {
    const shown = openAsks()[0]!;
    dialog = new FakeCodexDialog(PLAN_QUESTIONS);
    mini.sessions.find("codex", THREAD)!.session.native.terminal = term;
    await settle(() => mini.asks.getAny(shown.id)?.status === "cancelled" && openAsks().length > 0);
    const asks = openAsks();
    expect(asks).toHaveLength(1);
    const q1 = asks[0]!;
    // what a notification is raised for: the user may answer it, with its options as buttons
    expect(q1.answerableBy).toEqual(["user", "brain"]);
    expect(q1.options.map((o) => o.label)).toEqual(["Live UE preview (Recommended)", "Rendered chain videos"]);
    expect(q1.allowsText).toBe(true);
    expect(q1.detail).toBe("Playback · 1 of 2");
    await mini.sessions.tick();
    expect(session().status).toBe("needs_input");
    expect(session().ask).toBe(q1.id);
  });

  test("answered, the next is asked; the last answered, the answers are typed into the dialog in its terminal", async () => {
    const q1 = openAsks()[0]!;
    mini.asks.answer(q1.id, { option: "Rendered chain videos" }, USER);
    const q2 = await waitFor(() => openAsks()[0]);
    expect(q2.id).not.toBe(q1.id);
    expect(q2.title).toBe(PLAN_QUESTIONS[1]!.question);
    mini.asks.answer(q2.id, { option: "text", text: "a timeline of poses" }, USER);
    await waitFor(() => dialog!.done);
    expect(dialog!.submitted).toEqual({ playback: { answers: ["Rendered chain videos"] }, nodes: { answers: ["None of the above", "user_note: a timeline of poses"] } });
    expect(terminal.typedInto.every((id) => id === term.id)).toBe(true);
    await waitFor(() => session().status === "busy");
    expect(session().ask).toBeUndefined();
    const askEvents = events().filter((e) => e.kind === "ask").map((e) => (e.payload as { phase: string }).phase);
    expect(askEvents).toEqual(["opened", "closed", "opened", "answered", "opened", "answered"]);
  });

  test("its output closes it with nothing left open", async () => {
    append("response_item", { type: "function_call_output", call_id: "call_q1", output: JSON.stringify({ answers: { playback: { answers: ["Rendered chain videos"] } } }) });
    await settle(() => (mini.sessions.find("codex", THREAD)!.parser as { questions: Map<string, unknown> }).questions.size === 0);
    expect(openAsks()).toHaveLength(0);
    expect(session().status).toBe("busy");
  });

  test("one answered in the terminal takes its ask down", async () => {
    dialog = new FakeCodexDialog([PLAN_QUESTIONS[0]!]);
    append("response_item", { type: "function_call", name: "request_user_input", arguments: JSON.stringify({ questions: [PLAN_QUESTIONS[0]] }), call_id: "call_q2" });
    const ask = await settle(() => openAsks()[0]);
    expect(session().status).toBe("needs_input");
    append("response_item", { type: "function_call_output", call_id: "call_q2", output: JSON.stringify({ answers: { playback: { answers: ["Live UE preview (Recommended)"] } } }) });
    await settle(() => mini.asks.getAny(ask.id)?.status === "cancelled");
    expect(session().status).toBe("busy");
    expect(dialog.keysLog).toEqual([]);
  });

  test("an async question is asked beside the work; its answer goes in as Codex's reply, which closes it and reads as a quoted answer", async () => {
    append("response_item", { type: "function_call", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "Could you free about 6 GB?", options: ["I'll free memory", "Keep going"] }] }), call_id: "call_a" });
    append("response_item", { type: "function_call_output", call_id: "call_a", output: '{"accepted":true}' });
    const ask = await settle(() => openAsks()[0]);
    expect(ask.answerableBy).toEqual(["user", "brain"]);
    expect(ask.title).toBe("Could you free about 6 GB?");
    expect(session().status).toBe("busy");
    expect(session().ask).toBeUndefined();
    mini.asks.answer(ask.id, { option: "Keep going" }, USER);
    const sent = await waitFor(() => queueLog().find((q) => q.op === "add" && q.clientUserMessageId === `cophylad-answer-${ask.id}`));
    const text = sent.input![0]!.text;
    expect(repliesIn(text)).toEqual([{ itemId: asyncItemId("call_a", 0), question: "Could you free about 6 GB?", answer: "Keep going" }]);
    appendFileSync(rollout, JSON.stringify({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", client_id: sent.clientUserMessageId, content: [{ type: "Text", text }] } } }) + "\n");
    await settle(() => openAsks().length === 0);
    const turn = events().filter((e) => e.kind === "user_turn").at(-1)!;
    expect((turn.payload as { text: string }).text).toBe("> Could you free about 6 GB?\n\nKeep going");
    expect(openAsks()).toHaveLength(0);
  });

  test("the turn's end lets an unanswered async question go", async () => {
    append("response_item", { type: "function_call", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "Include the other packs?" }] }), call_id: "call_b" });
    const ask = await settle(() => openAsks()[0]);
    expect(ask.type).toBe("input");
    append("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" });
    await settle(() => mini.asks.getAny(ask.id)?.status === "cancelled");
    expect(openAsks()).toHaveLength(0);
  });
});

