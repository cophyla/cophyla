// The agent's questions as asks. Claude Code's `AskUserQuestion` reaches cophylad two ways: as
// a `PermissionRequest` hook in an attached session, and as an ACP form elicitation
// (`elicitation/create`) in a spawned one, where Codex's `request_user_input` and MCP
// servers' own forms arrive the same way; a Muse session cophylad runs asks through its host's
// `userInput/request`. All are read into one `Question` model here,
// opened as one `choice` (or `input`) Ask per question, and the answers are encoded back
// into what each side expects. Pure: no host, no store.

import { z } from "zod";
import { ASK_TEXT_OPTION } from "@cophyla/protocol";
import type { AskAnswer, AskOption, AskType } from "@cophyla/protocol";
import type { AskInput } from "../gate/asks.ts";
import { capText } from "./model.ts";

export interface QuestionOption {
  /** The ask option id: the label, deduped. */
  id: string;
  label: string;
  /** What the agent receives when the option is chosen: the enum `const`, the label for Claude and Codex. */
  value: string;
  description?: string;
}

export interface Question {
  /** The form field (ACP) or the question text verbatim (hook: the CLI reads `answers[question]`). */
  key: string;
  text: string;
  header?: string;
  options: QuestionOption[];
  multiple: boolean;
  allowsText: boolean;
  required: boolean;
  /** `choice` with options; `input` for a bare field. */
  kind: "choice" | "input";
  /** The companion field that carries free text (ACP forms). */
  customKey?: string;
  /** The field's own type, for an `input` that is not a string. */
  valueType?: "string" | "number" | "integer" | "boolean";
}

export interface ElicitationForm {
  questions: Question[];
  toolCallId?: string;
  /** Codex resolves the request itself after this many milliseconds. */
  autoResolutionMs?: number;
}

/** What goes back into the tool's input on the hook path. */
export interface HookAnswers {
  answers: Record<string, string>;
  annotations: Record<string, { notes: string }>;
}

const TITLE_CAP = 1000;
const DESCRIPTION_CAP = 500;

// --- options -----------------------------------------------------------------------------

/** Ids from labels: repeats get ` (2)`, ` (3)`…; the reserved `text` id is taken; blank labels are dropped. */
export function dedupeOptions(raw: { label: string; value?: string; description?: string }[]): QuestionOption[] {
  const taken = new Set<string>([ASK_TEXT_OPTION]);
  const out: QuestionOption[] = [];
  for (const o of raw) {
    const label = o.label;
    if (!label.trim()) continue;
    let id = label;
    for (let n = 2; taken.has(id); n++) id = `${label} (${n})`;
    taken.add(id);
    const opt: QuestionOption = { id, label, value: o.value ?? label };
    if (o.description) opt.description = o.description;
    out.push(opt);
  }
  return out;
}

// --- the hook path: AskUserQuestion's tool input ---------------------------------------------

const ToolOption = z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() });
const ToolQuestion = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.unknown()),
  multiSelect: z.boolean().optional(),
});
const ToolInput = z.object({ questions: z.array(z.unknown()) });

/**
 * The questions in an `AskUserQuestion` tool input, malformed entries dropped the way the
 * ACP adapter's own `extractAskUserQuestions` does. `undefined` when nothing survives, so
 * the caller falls back to an ordinary permission ask.
 */
export function questionsFromAskUserQuestion(toolInput: unknown): Question[] | undefined {
  const input = ToolInput.safeParse(toolInput);
  if (!input.success) return undefined;
  const out: Question[] = [];
  for (const raw of input.data.questions) {
    const q = ToolQuestion.safeParse(raw);
    if (!q.success) continue;
    const options = dedupeOptions(q.data.options.map((o) => ToolOption.safeParse(o)).filter((r) => r.success).map((r) => r.data));
    if (options.length === 0) continue;
    const question: Question = {
      key: q.data.question,
      text: q.data.question,
      options,
      multiple: q.data.multiSelect === true,
      allowsText: true,
      required: false,
      kind: "choice",
    };
    if (q.data.header) question.header = q.data.header;
    out.push(question);
  }
  return out.length > 0 ? out : undefined;
}

/** The chosen labels and the text, written the way the CLI's own `AskUserQuestion` UI writes them. */
export function answersForHook(q: Question, answer: AskAnswer, out: HookAnswers): void {
  const { labels, text } = picked(q, answer);
  if (q.multiple) {
    const items = text ? [...labels, text] : labels;
    if (items.length > 0) out.answers[q.key] = joinMulti(items);
    return;
  }
  const label = labels[0];
  if (label === undefined) {
    if (text) out.answers[q.key] = text;
    return;
  }
  out.answers[q.key] = label;
  if (text) out.annotations[q.key] = { notes: text };
}

/** The `PermissionRequest` response that releases the tool with the answers in its input. */
export function hookDecision(toolInput: Record<string, unknown>, out: HookAnswers): unknown {
  const updatedInput: Record<string, unknown> = { ...toolInput, answers: out.answers };
  if (Object.keys(out.annotations).length > 0) updatedInput["annotations"] = out.annotations;
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput } } };
}

/**
 * Comma-joined, with any item that itself contains the separator (or a double quote)
 * JSON-quoted: the rule the tool's `call()` splits on, mirrored from the ACP adapter's
 * `joinMultiSelectAnswer`.
 */
export function joinMulti(items: string[]): string {
  return items.map((item) => (item.includes(", ") || item.includes('"') ? JSON.stringify(item) : item)).join(", ");
}

// --- the ACP path: a form elicitation --------------------------------------------------------

interface EnumOption {
  const: string;
  title?: string;
  description?: string;
}

interface Field {
  type?: string;
  title?: string;
  description?: string;
  oneOf?: EnumOption[];
  enum?: unknown[];
  enumNames?: unknown[];
  items?: { anyOf?: EnumOption[]; enum?: unknown[]; enumNames?: unknown[] };
  _meta?: Record<string, unknown>;
}

const CUSTOM_ANSWER_META = "_askUserQuestionCustomAnswer";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The field a companion free-text field belongs to, by Claude's shared marker or Codex's note role. */
function companionOf(field: Field): string | undefined {
  const meta = field._meta;
  if (!isRecord(meta)) return undefined;
  const claude = meta[CUSTOM_ANSWER_META];
  if (isRecord(claude) && typeof claude["questionId"] === "string") return claude["questionId"];
  const codex = meta["codex"];
  if (isRecord(codex) && codex["role"] === "user_note" && typeof codex["questionId"] === "string") return codex["questionId"];
  return undefined;
}

function enumOptions(list: unknown): { label: string; value: string; description?: string }[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: { label: string; value: string; description?: string }[] = [];
  for (const o of list) {
    if (!isRecord(o) || typeof o["const"] !== "string") continue;
    const value = o["const"];
    const label = typeof o["title"] === "string" && o["title"] ? o["title"] : value;
    const opt: { label: string; value: string; description?: string } = { label, value };
    if (typeof o["description"] === "string" && o["description"]) opt.description = o["description"];
    out.push(opt);
  }
  return out;
}

function plainEnum(values: unknown, names: unknown): { label: string; value: string }[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const labels = Array.isArray(names) ? names : [];
  return values.map((v, i) => {
    const value = String(v);
    const name = labels[i];
    return { label: typeof name === "string" && name ? name : value, value };
  });
}

/**
 * A form elicitation as questions, or `undefined` when it cannot be shown as asks: not a
 * form, no fields, or a field there is no ask for (an object, an array of anything but an
 * enum, no type). Claude's `question_<n>` fields carry the question in `description` (or in
 * `message` when the form has one question); Codex puts it in `title`.
 */
export function questionsFromElicitation(params: unknown): ElicitationForm | undefined {
  if (!isRecord(params) || params["mode"] !== "form") return undefined;
  const schema = params["requestedSchema"];
  if (!isRecord(schema) || !isRecord(schema["properties"])) return undefined;
  const properties = schema["properties"] as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (keys.length === 0) return undefined;
  const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).filter((k): k is string => typeof k === "string") : []);
  const message = typeof params["message"] === "string" ? params["message"] : undefined;

  // Pass 1: companions fold into their parent.
  const companions = new Map<string, string>();
  for (const key of keys) {
    const field = properties[key];
    if (!isRecord(field)) continue;
    const parent = companionOf(field as Field);
    if (parent !== undefined && parent !== key && keys.includes(parent) && !companions.has(parent)) companions.set(parent, key);
  }
  const isCompanion = new Set(companions.values());

  // Pass 2: one question per remaining field, in key order.
  const questions: Question[] = [];
  const single = keys.length - isCompanion.size === 1;
  for (const key of keys) {
    if (isCompanion.has(key)) continue;
    const field = properties[key];
    if (!isRecord(field)) return undefined;
    const f = field as Field;
    const customKey = companions.get(key);
    const claudeStyle = /^question_\d+$/.test(key) && customKey !== undefined;
    const q: Question = {
      key,
      text: "",
      options: [],
      multiple: false,
      allowsText: customKey !== undefined,
      required: required.has(key),
      kind: "choice",
    };
    if (claudeStyle) {
      q.text = f.description ?? (single ? message : undefined) ?? f.title ?? key;
      if (f.title) q.header = f.title;
    } else {
      q.text = f.title ?? (single ? message : undefined) ?? key;
      if (f.description) q.header = f.description;
    }
    if (customKey !== undefined) q.customKey = customKey;

    const type = f.type;
    if (type === "string" && f.oneOf) {
      const opts = enumOptions(f.oneOf);
      if (!opts || opts.length === 0) return undefined;
      q.options = dedupeOptions(opts);
    } else if (type === "string" && f.enum) {
      const opts = plainEnum(f.enum, f.enumNames);
      if (!opts || opts.length === 0) return undefined;
      q.options = dedupeOptions(opts);
    } else if (type === "string") {
      q.kind = "input";
      q.allowsText = true;
      q.valueType = "string";
    } else if (type === "array") {
      const items = f.items;
      const opts = items?.anyOf ? enumOptions(items.anyOf) : items?.enum ? plainEnum(items.enum, items.enumNames) : undefined;
      if (!opts || opts.length === 0) return undefined;
      q.options = dedupeOptions(opts);
      q.multiple = true;
    } else if (type === "boolean") {
      q.options = dedupeOptions([
        { label: "Yes", value: "true" },
        { label: "No", value: "false" },
      ]);
      q.valueType = "boolean";
    } else if (type === "number" || type === "integer") {
      q.kind = "input";
      q.allowsText = true;
      q.valueType = type;
    } else {
      return undefined;
    }
    if (q.options.length === 0 && q.kind === "choice") return undefined;
    questions.push(q);
  }
  if (questions.length === 0) return undefined;

  const form: ElicitationForm = { questions };
  if (typeof params["toolCallId"] === "string" && params["toolCallId"]) form.toolCallId = params["toolCallId"];
  const meta = params["_meta"];
  if (isRecord(meta) && isRecord(meta["codex"])) {
    const ms = (meta["codex"] as Record<string, unknown>)["autoResolutionMs"];
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) form.autoResolutionMs = ms;
  }
  return form;
}

/** The answer's field values, written into the elicitation's `content`. */
export function contentForElicitation(q: Question, answer: AskAnswer, content: Record<string, unknown>): void {
  const { values, text } = picked(q, answer);
  if (q.valueType === "boolean") {
    if (values[0] !== undefined) content[q.key] = values[0] === "true";
  } else if (q.valueType === "number" || q.valueType === "integer") {
    if (text) {
      const n = Number(text);
      if (Number.isFinite(n) && (q.valueType === "number" || Number.isInteger(n))) content[q.key] = n;
    }
  } else if (q.kind === "input") {
    if (text !== undefined) content[q.key] = text;
  } else if (q.multiple) {
    content[q.key] = values;
  } else if (values[0] !== undefined) {
    content[q.key] = values[0];
  }
  if (text && q.customKey !== undefined) content[q.customKey] = text;
}

// --- the ask ---------------------------------------------------------------------------------

export interface AskPlace {
  session: string;
  /** Zero-based, of `count`. */
  index: number;
  count: number;
  expiresAt: number;
}

/** One question as an ask: the question is the title, the header and the place go in `detail`. */
export function askInputFromQuestion(q: Question, place: AskPlace): AskInput {
  const type: AskType = q.kind;
  const detailParts = [q.header, place.count > 1 ? `${place.index + 1} of ${place.count}` : undefined].filter((p): p is string => !!p);
  const options: AskOption[] = q.options.map((o) => {
    const opt: AskOption = { id: o.id, label: o.label };
    if (o.description) opt.description = capText(o.description, DESCRIPTION_CAP);
    return opt;
  });
  const input: AskInput = {
    type,
    source: { kind: "harness", session: place.session },
    title: capText(q.text, TITLE_CAP),
    options,
    answerableBy: ["user", "brain"],
    expiresAt: place.expiresAt,
  };
  if (detailParts.length > 0) input.detail = detailParts.join(" · ");
  if (q.multiple) input.multiple = true;
  if (q.allowsText) input.allowsText = true;
  return input;
}

/** The chosen options (the reserved `text` id is never one: `dedupeOptions` keeps it) and the trimmed text. */
function picked(q: Question, answer: AskAnswer): { labels: string[]; values: string[]; text?: string } {
  const ids = (answer.options ?? [answer.option]).filter((id) => id !== ASK_TEXT_OPTION);
  const chosen = ids.map((id) => q.options.find((o) => o.id === id)).filter((o): o is QuestionOption => o !== undefined);
  const text = answer.text?.trim();
  return { labels: chosen.map((o) => o.label), values: chosen.map((o) => o.value), ...(text ? { text } : {}) };
}

// --- Muse: `userInput/request` -------------------------------------------------------------------

const MuseOption = z.object({ label: z.string() });
const MuseQuestion = z.object({
  id: z.string(),
  header: z.string().optional(),
  question: z.string(),
  options: z.array(z.unknown()),
  selection: z.object({ mode: z.enum(["single", "multiple"]) }).optional(),
});

/** The questions of a Muse `userInput/request`; `undefined` when none survives. Free text is always allowed. */
export function questionsFromMuse(params: unknown): Question[] | undefined {
  const list = isRecord(params) && Array.isArray(params["questions"]) ? params["questions"] : [];
  const out: Question[] = [];
  for (const raw of list) {
    const q = MuseQuestion.safeParse(raw);
    if (!q.success) continue;
    const options = dedupeOptions(q.data.options.map((o) => MuseOption.safeParse(o)).filter((r) => r.success).map((r) => r.data));
    const question: Question = {
      key: q.data.id,
      text: q.data.question,
      options,
      multiple: q.data.selection?.mode === "multiple",
      allowsText: true,
      required: false,
      kind: options.length > 0 ? "choice" : "input",
    };
    if (q.data.header) question.header = q.data.header;
    out.push(question);
  }
  return out.length > 0 ? out : undefined;
}

/** A Muse question's answer as `userInput/answer` takes it. */
export interface MuseAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
}

/** One question's answer as `userInput/answer` takes it: the chosen label or labels, and the text. */
export function museAnswer(q: Question, answer: AskAnswer): MuseAnswer {
  const { labels, text } = picked(q, answer);
  const out: MuseAnswer = { questionId: q.key };
  if (q.multiple) {
    if (labels.length > 0) out.selectedLabels = labels;
  } else if (labels[0] !== undefined) out.selectedLabel = labels[0];
  if (text) out.freeText = text;
  return out;
}
