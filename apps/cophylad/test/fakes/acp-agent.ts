// A stand-in for an ACP agent adapter (claude-agent-acp, codex-acp): newline JSON-RPC on
// stdio, the ACP v1 methods cophylad calls, and a `session/prompt` scripted on the prompt text:
//   say hi     two message chunks, a usage_update, end_turn with usage
//   use tool   tool_call with no input, updates that fill it in and complete it, a chunk, end_turn
//   ask        tool_call, then session/request_permission; the answer is echoed in a chunk
//   approve    tool_call for ExitPlanMode with a plan, then session/request_permission with
//              the options claude-agent-acp offers for one; the answer is echoed in a chunk
//   slow       nothing until session/cancel arrives, then `cancelled`
//   plan       a plan update and a mode update, then end_turn
//   exit       the process exits mid-turn
//   question   a chunk with the elicitation capability it was given, tool_call tc3 named
//              AskUserQuestion, then an elicitation/create form with two questions the way
//              claude-agent-acp writes them; the response is echoed in a chunk. With
//              `abandon` the turn ends without waiting; with `withdraw` the agent cancels
//              its own request after a moment.
//   weird form an elicitation/create whose field is an object; the response is echoed
//   Implement this plan:   (a prompt that starts so) a chunk naming the mode the session
//              was set to, then end_turn; the rest of the text is not read
// `initialize` echoes the environment it was given under `_meta.env` and the client's
// capabilities under `_meta.clientCapabilities`, so a test can check what the adapter
// passed. `session/new` fails for a cwd with `no-session` in it. Writes synchronously, as
// the other fakes do.

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (m: unknown) => writeSync(1, JSON.stringify(m) + "\n");
const update = (sessionId: string, u: Record<string, unknown>) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

let nextId = 1;
const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
let cancelWaiter: (() => void) | undefined;
let sessions = 0;
let clientCapabilities: unknown;
let mode = "unset";

function request(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> & { id: number } {
  const id = nextId++;
  const p = new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
  return Object.assign(p, { id });
}

const QUESTIONS = {
  type: "object",
  properties: {
    question_0: { type: "string", title: "Cache", description: "Which cache?", oneOf: [{ const: "Redis", title: "Redis", description: "In-memory, persistent" }, { const: "Memcached", title: "Memcached" }] },
    question_0_custom: { type: "string", title: "Other", description: "Type your own answer, or add a note to the option you chose above (optional).", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } } },
    question_1: { type: "array", title: "Tools", description: "Which tools?", items: { anyOf: [{ const: "ESLint", title: "ESLint" }, { const: "Prettier", title: "Prettier" }] } },
    question_1_custom: { type: "string", title: "Other", description: "Type your own answer to add to your selection above (optional).", _meta: { _askUserQuestionCustomAnswer: { questionId: "question_1", isCustomAnswer: true } } },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function prompt(id: unknown, params: { sessionId: string; prompt: { type: string; text?: string }[] }): Promise<void> {
  const sessionId = params.sessionId;
  const text = params.prompt.map((p) => p.text ?? "").join("");
  const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, cachedWriteTokens: 7, totalTokens: 122 };
  const done = (stopReason: string) => send({ jsonrpc: "2.0", id, result: { stopReason, usage } });
  // Before the keywords: a plan's text holds any of them.
  if (text.startsWith("Implement this plan:")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mode=${mode}` }, messageId: "m7" });
    done("end_turn");
    return;
  }
  if (text.includes("exit")) {
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (text.includes("slow")) {
    await new Promise<void>((r) => (cancelWaiter = r));
    cancelWaiter = undefined;
    done("cancelled");
    return;
  }
  update(sessionId, { sessionUpdate: "usage_update", used: 1000, size: 200000 });
  if (text.includes("use tool")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc1", name: "Write", rawInput: {}, status: "pending", title: "Preparing file…", kind: "edit", content: [], locations: [] });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc1", rawInput: { file_path: "x.txt", content: "hello" }, title: "Write x.txt", kind: "edit" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", rawOutput: "File created successfully at: x.txt" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." }, messageId: "m1" });
    done("end_turn");
    return;
  }
  if (text.includes("approve")) {
    const plan = "## Plan\n\n1. Read the file\n2. Write the file";
    const toolCall = { toolCallId: "tc4", name: "ExitPlanMode", status: "pending", rawInput: { plan }, title: "Approve Plan", kind: "switch_mode" };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const answer = await request("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "exit_plan_accept_edits", name: "Yes, auto-accept edits", kind: "allow_always" },
        { optionId: "exit_plan_default", name: "Yes, manually approve edits", kind: "allow_once" },
        { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
      ],
    });
    const outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `you chose ${outcome?.optionId ?? "nothing"}` }, messageId: "m6" });
    done("end_turn");
    return;
  }
  if (text.includes("ask")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc2", name: "Bash", rawInput: { command: "rm -rf build" }, status: "pending", title: "Run rm -rf build", kind: "execute" });
    const answer = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc2", name: "Bash", status: "pending", rawInput: { command: "rm -rf build" }, title: "Run rm -rf build", kind: "execute" },
      options: [
        { optionId: "allow-once", name: "Yes", kind: "allow_once" },
        { optionId: "allow-always", name: "Yes, always", kind: "allow_always" },
        { optionId: "reject", name: "No", kind: "reject_once" },
      ],
    });
    const outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    const word = outcome?.outcome === "selected" ? `you chose ${outcome.optionId}` : "cancelled";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc2", status: outcome?.optionId?.startsWith("allow") ? "completed" : "failed", rawOutput: word });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: word }, messageId: "m2" });
    done("end_turn");
    return;
  }
  if (text.includes("question")) {
    const caps = (clientCapabilities as { elicitation?: unknown } | undefined)?.elicitation;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `caps=${JSON.stringify(caps ?? null)}` }, messageId: "m3" });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc3", title: "Asking the user", kind: "other", status: "pending", rawInput: { questions: [{ question: "Which cache?" }, { question: "Which tools?" }] }, _meta: { claudeCode: { toolName: "AskUserQuestion" } } });
    const form = request("elicitation/create", { sessionId, toolCallId: "tc3", mode: "form", message: "Please answer the following questions.", requestedSchema: QUESTIONS });
    if (text.includes("abandon")) {
      void form;
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc3", status: "failed", rawOutput: "abandoned" });
      done("end_turn");
      return;
    }
    if (text.includes("withdraw")) {
      await sleep(50);
      send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: form.id } });
    }
    const answer = await form;
    const word = `answer=${JSON.stringify(answer.result ?? answer.error)}`;
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc3", status: "completed", rawOutput: word });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: word }, messageId: "m4" });
    done("end_turn");
    return;
  }
  if (text.includes("weird form")) {
    const answer = await request("elicitation/create", { sessionId, mode: "form", message: "Give me a blob", requestedSchema: { type: "object", properties: { blob: { type: "object" } } } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer=${JSON.stringify(answer.result ?? answer.error)}` }, messageId: "m5" });
    done("end_turn");
    return;
  }
  if (text.includes("plan")) {
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Read the code", status: "completed", priority: "high" }, { content: "Fix it", status: "in_progress", priority: "medium" }] });
    update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" });
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" }, messageId: "t1" });
    update(sessionId, { sessionUpdate: "session_info_update", title: "A plan" });
    done("end_turn");
    return;
  }
  if (text.includes("say hi")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " }, messageId: "m0" });
    await sleep(5);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there." }, messageId: "m0" });
    update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.01, currency: "USD" } });
    done("end_turn");
    return;
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" }, messageId: "m9" });
  done("end_turn");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = m["id"];
  const method = m["method"];
  const params = (m["params"] ?? {}) as Record<string, unknown>;
  if (typeof method !== "string") {
    const p = pending.get(id as number);
    if (p) {
      pending.delete(id as number);
      p({ result: m["result"], error: m["error"] });
    }
    return;
  }
  if (id === undefined || id === null) {
    if (method === "session/cancel" && cancelWaiter) cancelWaiter();
    return;
  }
  switch (method) {
    case "initialize": {
      const env = process.env;
      clientCapabilities = params["clientCapabilities"];
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp", version: "0.0.1" },
          agentCapabilities: { loadSession: false },
          authMethods: [],
          _meta: {
            clientCapabilities: clientCapabilities ?? null,
            env: {
              CLAUDE_CONFIG_DIR: env["CLAUDE_CONFIG_DIR"] ?? null,
              CLAUDE_CODE_EXECUTABLE: env["CLAUDE_CODE_EXECUTABLE"] ?? null,
              CODEX_HOME: env["CODEX_HOME"] ?? null,
              CODEX_PATH: env["CODEX_PATH"] ?? null,
              TEST_PROFILE_VAR: env["TEST_PROFILE_VAR"] ?? null,
              leaked: Object.keys(env).filter((k) => /^CLAUDE_CODE_/.test(k) && k !== "CLAUDE_CODE_EXECUTABLE"),
              cwd: process.cwd(),
            },
          },
        },
      });
      return;
    }
    case "session/new": {
      if (String(params["cwd"] ?? "").includes("no-session")) {
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: "fake agent: no session here" } });
        return;
      }
      const sessionId = `fake-${process.pid}-${++sessions}`;
      send({ jsonrpc: "2.0", id, result: { sessionId, modes: { currentModeId: "auto", availableModes: [{ id: "default", name: "Manual" }, { id: "acceptEdits", name: "Accept Edits" }, { id: "plan", name: "Plan Mode" }, { id: "bypassPermissions", name: "Bypass Permissions" }] }, models: { availableModels: [{ modelId: "gpt-fake[low]" }] } } });
      return;
    }
    case "session/set_mode":
      mode = String(params["modeId"] ?? "unset");
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/set_model":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/prompt":
      void prompt(id, params as { sessionId: string; prompt: { type: string; text?: string }[] });
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake agent: unknown ${method}` } });
  }
});
