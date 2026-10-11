// Codex's questions to the user, read off its rollout. `request_user_input` holds the turn on a
// dialog in the TUI until it is answered there (in Plan mode; in Default mode the TUI lets it go
// unanswered after two minutes), and its answers come back as the call's output.
// `request_user_input_async` asks and lets the turn go on: the TUI lists the question under the
// composer until its turn ends, and an answer is a message of the user's carrying a reply
// envelope that names the question. Both are read into the one `Question` model the other
// harnesses' questions use. An answer from cophylad reaches the dialog as the keys a person
// presses in it, and the async question as the envelope Codex's own clients send. Read off
// Codex 0.162.1's source (core's handlers, the TUI's `request_user_input` overlay and async
// question editor). Pure: no host, no store.

import { ASK_TEXT_OPTION } from "@cophyla/protocol";
import type { AskAnswer } from "@cophyla/protocol";
import { rowsOf } from "../claude/screen.ts";
import type { ScreenLike } from "../claude/screen.ts";
import { dedupeOptions } from "../questions.ts";
import type { Question } from "../questions.ts";

export const ASK_TOOL = "request_user_input";
export const ASYNC_ASK_TOOL = "request_user_input_async";

/** The tools whose calls are questions to the user. */
export function isQuestionTool(name: string): name is typeof ASK_TOOL | typeof ASYNC_ASK_TOOL {
  return name === ASK_TOOL || name === ASYNC_ASK_TOOL;
}

/** A question of a call, with where its options sit in the dialog. */
export interface CodexQuestion extends Question {
  /** The dialog row of each option, in `options` order: an option with a blank label has no ask option, but keeps its row. */
  rows: number[];
  /** The "None of the above" row the dialog adds after the options, which takes notes. */
  other: number;
}

/** A question call still waiting for its answer. */
export interface CodexQuestionCall {
  callId: string;
  tool: typeof ASK_TOOL | typeof ASYNC_ASK_TOOL;
  at: number;
  questions: CodexQuestion[];
  /** The questions not answered yet, by index: a blocking call's all of them until its output comes. */
  open: number[];
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An async question's id as Codex's clients name it in a reply: the tool, the message (the call) and the index. */
export function asyncItemId(callId: string, index: number): string {
  return JSON.stringify([ASYNC_ASK_TOOL, callId, index]);
}

/**
 * A question call's questions, or `undefined` when none can be shown. Codex gives every
 * `request_user_input` question options and a "None of the above" row taking notes; an async
 * question has string options, or none for a free-text one, and always takes free text.
 */
export function questionCall(tool: string, callId: string, input: unknown, at: number): CodexQuestionCall | undefined {
  if (!isQuestionTool(tool) || !callId || !isRecord(input) || !Array.isArray(input["questions"])) return undefined;
  const questions: CodexQuestion[] = [];
  const raw = input["questions"] as unknown[];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    if (!isRecord(q)) return undefined;
    const question = tool === ASK_TOOL ? blockingQuestion(q) : asyncQuestion(q, callId, i);
    // One the TUI could not show leaves the call to the terminal: the dialog's rows would not be these.
    if (!question) return undefined;
    questions.push(question);
  }
  if (questions.length === 0) return undefined;
  return { callId, tool, at, questions, open: questions.map((_, i) => i) };
}

function blockingQuestion(q: Json): CodexQuestion | undefined {
  const text = typeof q["question"] === "string" ? q["question"] : "";
  const key = typeof q["id"] === "string" ? q["id"] : "";
  const raw = Array.isArray(q["options"]) ? (q["options"] as unknown[]) : [];
  if (!text.trim() || !key || raw.length === 0) return undefined;
  const labelled: { label: string; description?: string; row: number }[] = [];
  for (let row = 0; row < raw.length; row++) {
    const o = raw[row];
    if (!isRecord(o) || typeof o["label"] !== "string") return undefined;
    labelled.push({ label: o["label"], ...(typeof o["description"] === "string" && o["description"] ? { description: o["description"] } : {}), row });
  }
  const kept = labelled.filter((o) => o.label.trim());
  const question: CodexQuestion = {
    key,
    text,
    options: dedupeOptions(kept),
    multiple: false,
    allowsText: true,
    required: false,
    kind: "choice",
    rows: kept.map((o) => o.row),
    other: raw.length,
  };
  if (typeof q["header"] === "string" && q["header"].trim()) question.header = q["header"];
  return question;
}

function asyncQuestion(q: Json, callId: string, index: number): CodexQuestion | undefined {
  const text = typeof q["title"] === "string" ? q["title"] : "";
  if (!text.trim()) return undefined;
  const raw = Array.isArray(q["options"]) ? (q["options"] as unknown[]).filter((o): o is string => typeof o === "string") : [];
  const kept = raw.map((label, row) => ({ label, row })).filter((o) => o.label.trim());
  return {
    key: asyncItemId(callId, index),
    text,
    options: dedupeOptions(kept),
    multiple: false,
    allowsText: true,
    required: false,
    kind: kept.length > 0 ? "choice" : "input",
    rows: kept.map((o) => o.row),
    other: raw.length,
  };
}

// --- the dialog: the keys an answer is ---------------------------------------------------------

/** One question's answer as the dialog takes it: the row to choose, and the notes to add under it. */
export interface TypedAnswer {
  row: number;
  notes?: string;
}

/**
 * An answer as the dialog's keys take it: the chosen option's row, or "None of the above" for
 * text alone, with the text as notes. Notes are one line: a line break would submit them.
 */
export function typedAnswer(q: CodexQuestion, answer: AskAnswer): TypedAnswer {
  const id = (answer.options ?? [answer.option]).find((o) => o !== ASK_TEXT_OPTION);
  const at = id === undefined ? -1 : q.options.findIndex((o) => o.id === id);
  const notes = answer.text?.replace(/\s+/g, " ").trim();
  return { row: at >= 0 ? q.rows[at]! : q.other, ...(notes ? { notes } : {}) };
}

// --- the async question: the reply envelope ------------------------------------------------------

const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";
const QUESTION_BYTES = 512;

/** The longest start of `text` that fits in `bytes` of UTF-8. */
function prefixBytes(text: string, bytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= bytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (used + n > bytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/** What an async question's answer is said as: the text of the option chosen, or the free text, or both. */
export function replyAnswer(q: CodexQuestion, answer: AskAnswer): string {
  const label = (answer.options ?? [answer.option]).map((id) => q.options.find((o) => o.id === id)?.label).find((l) => l !== undefined);
  const text = answer.text?.trim();
  return label && text ? `${label}\n\n${text}` : (label ?? text ?? "");
}

/**
 * The user's message that answers an async question, written as Codex's own clients write it
 * (`AnsweredQuestion`): the question cut to 512 bytes on one line, in an envelope that names it.
 */
export function questionReply(q: CodexQuestion, answer: string): string {
  const question = prefixBytes(q.text, QUESTION_BYTES).replace(/[\r\n]/g, " ");
  if (q.key.length > QUESTION_BYTES) return `> ${question}\n\n${answer}`;
  return `${REPLY_OPEN}\n${JSON.stringify([{ answer, question, questionItemId: q.key }])}\n${REPLY_CLOSE}`;
}

export interface QuestionReply {
  itemId: string;
  question: string;
  answer: string;
}

/** The replies a user's message carries; `undefined` when it is not a reply envelope. */
export function repliesIn(text: string): QuestionReply[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(REPLY_OPEN) || !trimmed.endsWith(REPLY_CLOSE)) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(trimmed.slice(REPLY_OPEN.length, trimmed.length - REPLY_CLOSE.length));
  } catch {
    return undefined;
  }
  if (!Array.isArray(body)) return undefined;
  const out: QuestionReply[] = [];
  for (const r of body) {
    if (!isRecord(r) || typeof r["questionItemId"] !== "string") continue;
    out.push({ itemId: r["questionItemId"], question: typeof r["question"] === "string" ? r["question"] : "", answer: typeof r["answer"] === "string" ? r["answer"] : "" });
  }
  return out;
}

/** A reply envelope as a person reads it: each question quoted, its answer under it. */
export function readableReplies(replies: QuestionReply[]): string {
  return replies.map((r) => `> ${r.question}\n\n${r.answer}`).join("\n\n");
}

// --- the dialog on the screen ---------------------------------------------------------------------

/** What the screen shows of the `request_user_input` dialog. */
export interface DialogScreen {
  /** The question shown, from 1, and how many the dialog holds. */
  index: number;
  total: number;
  /** The option row the pointer is on, from 0. */
  selected?: number;
  /** The notes field is open: Esc clears it, where with it shut Esc would interrupt the turn. */
  notes: boolean;
  /** The dialog's rows from its progress line down, as one line of text. */
  text: string;
}

const PROGRESS = /\bQuestion (\d+)\/(\d+)\b/;
const OPTION_ROW = /^\s*([›>])?\s*(\d+)\.\s/;

/**
 * The dialog as the screen shows it, read from its progress line ("Question 2/3") down;
 * `undefined` when it is not on the screen. `confirm` when it asks whether to submit with
 * questions unanswered, which it shows in place of the questions.
 */
export function dialogOf(s: ScreenLike): DialogScreen | { confirm: true } | undefined {
  const rows = rowsOf(s).map((r) => r.replace(/ /g, " "));
  let at = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PROGRESS.test(rows[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return rows.some((r) => /Submit with unanswered questions\?/.test(r)) ? { confirm: true } : undefined;
  const m = PROGRESS.exec(rows[at]!)!;
  const below = rows.slice(at);
  let selected: number | undefined;
  for (const row of below.slice(1)) {
    const o = OPTION_ROW.exec(row);
    if (o && o[1] !== undefined) {
      selected = Number(o[2]) - 1;
      break;
    }
  }
  const out: DialogScreen = { index: Number(m[1]), total: Number(m[2]), notes: below.some((r) => /\bto clear notes\b/.test(r)), text: below.join(" ").replace(/\s+/g, " ") };
  if (selected !== undefined) out.selected = selected;
  return out;
}

/** Letters and digits alone: a question wrapped over rows, padded or drawn with wide characters reads the same. */
function letters(text: string): string {
  return text.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/** Whether the dialog on the screen is showing this question: the start of its words. */
export function showsQuestion(d: DialogScreen, q: CodexQuestion): boolean {
  return letters(d.text).includes(letters(q.text).slice(0, 32));
}
