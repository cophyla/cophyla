// The agent's questions as asks, with no host: the two parsers (AskUserQuestion's tool
// input, a form elicitation in Claude's, Codex's and a generic shape), option ids, the ask
// each question becomes, and the answer encoded back for the hook and for the form.

import { describe, expect, test } from "bun:test";
import type { AskAnswer } from "@cophyla/protocol";
import {
  answersForHook,
  askInputFromQuestion,
  contentForElicitation,
  dedupeOptions,
  hookDecision,
  joinMulti,
  questionsFromAskUserQuestion,
  questionsFromElicitation,
} from "../src/sessions/questions.ts";
import type { HookAnswers, Question } from "../src/sessions/questions.ts";

const by = { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" } as const;
const answer = (a: Partial<AskAnswer> & { option: string }): AskAnswer => ({ by, at: 1, ...a });
const fresh = (): HookAnswers => ({ answers: {}, annotations: {} });

const CACHE = {
  question: "Which cache?",
  header: "Cache",
  options: [
    { label: "Redis", description: "In-memory, persistent" },
    { label: "Memcached", description: "In-memory only" },
  ],
};
const TOOLS = {
  question: "Which tools?",
  header: "Tools",
  multiSelect: true,
  options: [{ label: "ESLint" }, { label: "Prettier" }],
};

describe("questions: option ids", () => {
  test("ids are labels; repeats and the reserved text id are numbered; blanks are dropped", () => {
    const opts = dedupeOptions([{ label: "a" }, { label: "a" }, { label: "text" }, { label: " " }, { label: "a" }, { label: "b", value: "B", description: "the b" }]);
    expect(opts).toEqual([
      { id: "a", label: "a", value: "a" },
      { id: "a (2)", label: "a", value: "a" },
      { id: "text (2)", label: "text", value: "text" },
      { id: "a (3)", label: "a", value: "a" },
      { id: "b", label: "b", value: "B", description: "the b" },
    ]);
  });
});

describe("questions: AskUserQuestion's tool input", () => {
  test("a single question with descriptions; multiSelect; a header", () => {
    const qs = questionsFromAskUserQuestion({ questions: [CACHE, TOOLS] })!;
    expect(qs).toHaveLength(2);
    expect(qs[0]).toEqual({
      key: "Which cache?",
      text: "Which cache?",
      header: "Cache",
      options: [
        { id: "Redis", label: "Redis", value: "Redis", description: "In-memory, persistent" },
        { id: "Memcached", label: "Memcached", value: "Memcached", description: "In-memory only" },
      ],
      multiple: false,
      allowsText: true,
      required: false,
      kind: "choice",
    });
    expect(qs[1]).toMatchObject({ key: "Which tools?", multiple: true, options: [{ id: "ESLint" }, { id: "Prettier" }] });
  });

  test("malformed questions and options are dropped; nothing usable is undefined", () => {
    expect(questionsFromAskUserQuestion({ questions: [{ question: "x" }] })).toBeUndefined();
    expect(questionsFromAskUserQuestion({ questions: [{ question: "x", options: [] }] })).toBeUndefined();
    expect(questionsFromAskUserQuestion({ questions: [{ question: "x", options: [{ label: 3 }, { nope: 1 }] }] })).toBeUndefined();
    expect(questionsFromAskUserQuestion({ questions: "no" })).toBeUndefined();
    expect(questionsFromAskUserQuestion(undefined)).toBeUndefined();
    expect(questionsFromAskUserQuestion("text")).toBeUndefined();
    const qs = questionsFromAskUserQuestion({ questions: [{ question: "x" }, { question: "y", options: [{ label: "ok", preview: "p" }, { label: 1 }] }] })!;
    expect(qs).toHaveLength(1);
    expect(qs[0]!.options).toEqual([{ id: "ok", label: "ok", value: "ok" }]);
  });
});

describe("questions: the ask", () => {
  const [cache, tools] = questionsFromAskUserQuestion({ questions: [CACHE, TOOLS] })!;

  test("title, detail with header and place, options with descriptions, multiple, text", () => {
    const one = askInputFromQuestion(cache!, { session: "sess_1", index: 0, count: 1, expiresAt: 99 });
    expect(one).toEqual({
      type: "choice",
      source: { kind: "harness", session: "sess_1" },
      title: "Which cache?",
      detail: "Cache",
      options: [
        { id: "Redis", label: "Redis", description: "In-memory, persistent" },
        { id: "Memcached", label: "Memcached", description: "In-memory only" },
      ],
      allowsText: true,
      answerableBy: ["user", "brain"],
      expiresAt: 99,
    });
    const two = askInputFromQuestion(tools!, { session: "sess_1", index: 1, count: 2, expiresAt: 99 });
    expect(two.detail).toBe("Tools · 2 of 2");
    expect(two.multiple).toBe(true);
    expect(two.options).toEqual([{ id: "ESLint", label: "ESLint" }, { id: "Prettier", label: "Prettier" }]);
  });

  test("no header and one question: no detail; a bare header: the header alone; long text capped", () => {
    const bare: Question = { key: "k", text: "x".repeat(2000), options: [{ id: "a", label: "a", value: "a", description: "d".repeat(600) }], multiple: false, allowsText: false, required: false, kind: "choice" };
    const input = askInputFromQuestion(bare, { session: "s", index: 0, count: 1, expiresAt: 1 });
    expect(input).not.toHaveProperty("detail");
    expect(input).not.toHaveProperty("multiple");
    expect(input).not.toHaveProperty("allowsText");
    expect(input.title).toHaveLength(1000);
    expect(input.options[0]!.description).toHaveLength(500);
    expect(askInputFromQuestion({ ...bare, header: "H" }, { session: "s", index: 0, count: 1, expiresAt: 1 }).detail).toBe("H");
    expect(askInputFromQuestion({ ...bare, kind: "input" }, { session: "s", index: 2, count: 3, expiresAt: 1 })).toMatchObject({ type: "input", detail: "3 of 3" });
  });
});

describe("questions: the hook answer", () => {
  const [cache, tools] = questionsFromAskUserQuestion({ questions: [CACHE, TOOLS] })!;

  test("single: the label; with a note: an annotation; text only: the text", () => {
    let out = fresh();
    answersForHook(cache!, answer({ option: "Redis" }), out);
    expect(out).toEqual({ answers: { "Which cache?": "Redis" }, annotations: {} });
    out = fresh();
    answersForHook(cache!, answer({ option: "Redis", text: "  managed please " }), out);
    expect(out).toEqual({ answers: { "Which cache?": "Redis" }, annotations: { "Which cache?": { notes: "managed please" } } });
    out = fresh();
    answersForHook(cache!, answer({ option: "text", text: "Valkey" }), out);
    expect(out).toEqual({ answers: { "Which cache?": "Valkey" }, annotations: {} });
    out = fresh();
    answersForHook(cache!, answer({ option: "Redis", text: "   " }), out);
    expect(out).toEqual({ answers: { "Which cache?": "Redis" }, annotations: {} });
  });

  test("multiple: the labels joined; text joins the picks; an item with the separator is quoted", () => {
    let out = fresh();
    answersForHook(tools!, answer({ option: "ESLint", options: ["ESLint", "Prettier"] }), out);
    expect(out.answers).toEqual({ "Which tools?": "ESLint, Prettier" });
    out = fresh();
    answersForHook(tools!, answer({ option: "ESLint", options: ["ESLint", "Prettier"], text: "Biome" }), out);
    expect(out.answers).toEqual({ "Which tools?": "ESLint, Prettier, Biome" });
    out = fresh();
    answersForHook(tools!, answer({ option: "text", options: ["text"], text: "Biome, not Prettier" }), out);
    expect(out.answers).toEqual({ "Which tools?": '"Biome, not Prettier"' });
    expect(out.annotations).toEqual({});
    expect(joinMulti(['say "hi"', "a", "b, c"])).toBe('"say \\"hi\\"", a, "b, c"');
  });

  test("the decision carries the tool input with the answers and only annotations that exist", () => {
    const toolInput = { questions: [CACHE] };
    expect(hookDecision(toolInput, { answers: { "Which cache?": "Redis" }, annotations: {} })).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { questions: [CACHE], answers: { "Which cache?": "Redis" } } } },
    });
    const withNote = hookDecision(toolInput, { answers: { "Which cache?": "Redis" }, annotations: { "Which cache?": { notes: "n" } } }) as { hookSpecificOutput: { decision: { updatedInput: Record<string, unknown> } } };
    expect(withNote.hookSpecificOutput.decision.updatedInput["annotations"]).toEqual({ "Which cache?": { notes: "n" } });
  });
});

const claudeTwo = {
  mode: "form",
  sessionId: "s",
  toolCallId: "tc3",
  message: "Please answer the following questions.",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: { type: "string", title: "Cache", description: "Which cache?", oneOf: [{ const: "Redis", title: "Redis", description: "In-memory, persistent" }, { const: "Memcached", title: "Memcached" }] },
      question_0_custom: { type: "string", title: "Other", description: "Type your own answer…", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } } },
      question_1: { type: "array", title: "Tools", description: "Which tools?", items: { anyOf: [{ const: "ESLint", title: "ESLint" }, { const: "Prettier", title: "Prettier" }] } },
      question_1_custom: { type: "string", title: "Other", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_1", isCustomAnswer: true } } },
    },
  },
};

describe("questions: a form elicitation", () => {
  test("Claude, two questions: header from title, text from description, companions folded, toolCallId", () => {
    const form = questionsFromElicitation(claudeTwo)!;
    expect(form.toolCallId).toBe("tc3");
    expect(form.autoResolutionMs).toBeUndefined();
    expect(form.questions).toHaveLength(2);
    expect(form.questions[0]).toEqual({
      key: "question_0",
      text: "Which cache?",
      header: "Cache",
      options: [
        { id: "Redis", label: "Redis", value: "Redis", description: "In-memory, persistent" },
        { id: "Memcached", label: "Memcached", value: "Memcached" },
      ],
      multiple: false,
      allowsText: true,
      required: false,
      kind: "choice",
      customKey: "question_0_custom",
    });
    expect(form.questions[1]).toMatchObject({ key: "question_1", text: "Which tools?", header: "Tools", multiple: true, allowsText: true, customKey: "question_1_custom" });
  });

  test("Claude, one question: the question rides in message", () => {
    const form = questionsFromElicitation({
      mode: "form",
      message: "Which cache?",
      requestedSchema: {
        type: "object",
        properties: {
          question_0: { type: "string", title: "Cache", oneOf: [{ const: "Redis", title: "Redis" }] },
          question_0_custom: { type: "string", title: "Other", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0" } } },
        },
      },
    })!;
    expect(form.questions).toHaveLength(1);
    expect(form.questions[0]).toMatchObject({ text: "Which cache?", header: "Cache", customKey: "question_0_custom" });
  });

  test("Codex: the question in title, the header in description, a note companion, required, autoResolutionMs", () => {
    const form = questionsFromElicitation({
      mode: "form",
      toolCallId: "item-1",
      message: "Codex needs your input to continue.",
      requestedSchema: {
        type: "object",
        properties: {
          q1: { type: "string", title: "Which cache?", description: "Cache", oneOf: [{ const: "Redis", title: "Redis" }, { const: "None of the above", title: "None of the above", description: "Provide a different answer in the note field." }], _meta: { codex: { isOther: true } } },
          q1_note: { type: "string", title: "Additional answer or note", _meta: { codex: { questionId: "q1", role: "user_note" } } },
          q2: { type: "string", title: "Anything else?", _meta: { codex: { isOther: false } } },
        },
        required: ["q1", "q2"],
      },
      _meta: { codex: { autoResolutionMs: 30000 } },
    })!;
    expect(form.toolCallId).toBe("item-1");
    expect(form.autoResolutionMs).toBe(30000);
    expect(form.questions.map((q) => q.key)).toEqual(["q1", "q2"]);
    expect(form.questions[0]).toMatchObject({ text: "Which cache?", header: "Cache", allowsText: true, required: true, customKey: "q1_note", kind: "choice" });
    expect(form.questions[0]!.options.map((o) => o.id)).toEqual(["Redis", "None of the above"]);
    expect(form.questions[1]).toEqual({ key: "q2", text: "Anything else?", options: [], multiple: false, allowsText: true, required: true, kind: "input", valueType: "string" });
  });

  test("generic: const differs from title; enum with names; boolean; number; a single untitled field takes the message", () => {
    const form = questionsFromElicitation({
      mode: "form",
      message: "Retry?",
      requestedSchema: {
        type: "object",
        properties: {
          choice: { type: "string", oneOf: [{ const: "retry_fallback", title: "Retry with Opus" }, { const: "cancelled", title: "Keep the refusal", description: "You can send a new message." }] },
          colour: { type: "string", title: "Colour", enum: ["r", "g"], enumNames: ["Red", "Green"] },
          sizes: { type: "array", items: { enum: ["s", "m"] } },
          sure: { type: "boolean", title: "Sure?" },
          count: { type: "integer", title: "How many?" },
          ratio: { type: "number" },
        },
      },
    })!;
    const [choice, colour, sizes, sure, count, ratio] = form.questions;
    expect(choice).toMatchObject({ text: "choice", kind: "choice", allowsText: false });
    expect(choice!.options).toEqual([
      { id: "Retry with Opus", label: "Retry with Opus", value: "retry_fallback" },
      { id: "Keep the refusal", label: "Keep the refusal", value: "cancelled", description: "You can send a new message." },
    ]);
    expect(colour!.options).toEqual([{ id: "Red", label: "Red", value: "r" }, { id: "Green", label: "Green", value: "g" }]);
    expect(sizes).toMatchObject({ multiple: true, options: [{ id: "s", value: "s" }, { id: "m", value: "m" }] });
    expect(sure).toMatchObject({ kind: "choice", valueType: "boolean", options: [{ id: "Yes", value: "true" }, { id: "No", value: "false" }] });
    expect(count).toMatchObject({ kind: "input", valueType: "integer", allowsText: true, text: "How many?" });
    expect(ratio).toMatchObject({ kind: "input", valueType: "number", text: "ratio" });
    // One field and no title: the message is the question.
    const single = questionsFromElicitation({ mode: "form", message: "Retry?", requestedSchema: { type: "object", properties: { choice: { type: "string", oneOf: [{ const: "a" }] } } } })!;
    expect(single.questions[0]).toMatchObject({ text: "Retry?", options: [{ id: "a", label: "a", value: "a" }] });
  });

  test("not a form, no fields, or a field there is no ask for: undefined", () => {
    expect(questionsFromElicitation({ mode: "url", url: "https://x", message: "go" })).toBeUndefined();
    expect(questionsFromElicitation({ mode: "form", message: "ok?", requestedSchema: { type: "object", properties: {} } })).toBeUndefined();
    expect(questionsFromElicitation({ mode: "form", message: "ok?" })).toBeUndefined();
    expect(questionsFromElicitation({ mode: "form", requestedSchema: { type: "object", properties: { blob: { type: "object" } } } })).toBeUndefined();
    expect(questionsFromElicitation({ mode: "form", requestedSchema: { type: "object", properties: { list: { type: "array", items: { type: "string" } } } } })).toBeUndefined();
    expect(questionsFromElicitation({ mode: "form", requestedSchema: { type: "object", properties: { odd: { title: "no type" } } } })).toBeUndefined();
    expect(questionsFromElicitation({ mode: "form", requestedSchema: { type: "object", properties: { empty: { type: "string", oneOf: [] } } } })).toBeUndefined();
    // A companion with no parent is a plain field.
    const orphan = questionsFromElicitation({ mode: "form", requestedSchema: { type: "object", properties: { note: { type: "string", _meta: { _askUserQuestionCustomAnswer: { questionId: "gone" } } } } } })!;
    expect(orphan.questions).toHaveLength(1);
    expect(orphan.questions[0]).toMatchObject({ key: "note", kind: "input" });
    expect(questionsFromElicitation(null)).toBeUndefined();
  });
});

describe("questions: the form answer", () => {
  const form = questionsFromElicitation(claudeTwo)!;
  const [cache, tools] = form.questions;

  test("single: the value; a note goes to the companion; text only: the companion alone", () => {
    let content: Record<string, unknown> = {};
    contentForElicitation(cache!, answer({ option: "Redis" }), content);
    expect(content).toEqual({ question_0: "Redis" });
    content = {};
    contentForElicitation(cache!, answer({ option: "Redis", text: "managed please" }), content);
    expect(content).toEqual({ question_0: "Redis", question_0_custom: "managed please" });
    content = {};
    contentForElicitation(cache!, answer({ option: "text", text: "Valkey" }), content);
    expect(content).toEqual({ question_0_custom: "Valkey" });
  });

  test("multiple: the values as an array, text beside them", () => {
    const content: Record<string, unknown> = {};
    contentForElicitation(tools!, answer({ option: "ESLint", options: ["ESLint", "Prettier"], text: "Biome" }), content);
    expect(content).toEqual({ question_1: ["ESLint", "Prettier"], question_1_custom: "Biome" });
    const none: Record<string, unknown> = {};
    contentForElicitation(tools!, answer({ option: "text", options: ["text"], text: "Biome" }), none);
    expect(none).toEqual({ question_1: [], question_1_custom: "Biome" });
  });

  test("a value that differs from the label; boolean, number, integer and plain text fields", () => {
    const generic = questionsFromElicitation({
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          choice: { type: "string", oneOf: [{ const: "retry_fallback", title: "Retry" }] },
          sure: { type: "boolean" },
          count: { type: "integer" },
          ratio: { type: "number" },
          name: { type: "string" },
        },
      },
    })!;
    const [choice, sure, count, ratio, name] = generic.questions;
    const content: Record<string, unknown> = {};
    contentForElicitation(choice!, answer({ option: "Retry" }), content);
    contentForElicitation(sure!, answer({ option: "No" }), content);
    contentForElicitation(count!, answer({ option: "text", text: " 3 " }), content);
    contentForElicitation(ratio!, answer({ option: "text", text: "0.5" }), content);
    contentForElicitation(name!, answer({ option: "text", text: "Ada" }), content);
    expect(content).toEqual({ choice: "retry_fallback", sure: false, count: 3, ratio: 0.5, name: "Ada" });
    const bad: Record<string, unknown> = {};
    contentForElicitation(count!, answer({ option: "text", text: "3.5" }), bad);
    contentForElicitation(ratio!, answer({ option: "text", text: "lots" }), bad);
    contentForElicitation(name!, answer({ option: "text", text: "  " }), bad);
    expect(bad).toEqual({});
  });
});
