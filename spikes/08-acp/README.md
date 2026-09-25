# Spike 08: spawning through ACP

Date: 2026-09-18. Windows 11, Claude Code 2.1.277, Codex CLI 0.153.4, Node 22.22.2, Bun 1.3.14,
`@agentclientprotocol/claude-agent-acp` 0.79.0 (wraps the Claude Agent SDK 0.3.274),
`@agentclientprotocol/codex-acp` 1.12.0. The question from milestones.md: can cophylad start a
Claude Code and a Codex session through their ACP adapters on Windows, prompt them, and read
status and asks off `session/update` and `session/request_permission`? Cost: five short turns
on `haiku` and five on `gpt-5.6-luna[low]`, all in `target/`.

```
bun install
bun run acp-spike.ts --agent claude --runtime node      # also: --runtime bun, --agent codex, --outside
```

The script spawns `node|bun node_modules/@agentclientprotocol/<pkg>/dist/index.js` the way
cophylad will, with `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` naming the installed binaries,
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` the default profile directory, and every `CLAUDE_CODE_*`
variable of the calling shell scrubbed. It runs `initialize`, `session/new`, a prompt that needs
a permission, a slow prompt cancelled after six seconds, and a short third prompt; answers
`session/request_permission`; and records every frame in `out/<agent>-<runtime>.jsonl` with a
summary beside it. A stub `/hooks/*` listener on a free port records which cophylad hooks arrive
and with what `session_id`; for Claude it is installed as project settings in
`target/.claude/settings.json`, which the SDK loads beside the user's, so nothing under
`~/.claude` was edited.

## Verdict

| Question | Answer |
|---|---|
| Does each adapter run on Windows? | **Yes**, both, under Node and under Bun. Neither binary speaks ACP natively; the adapter is the bridge. |
| ACP session id vs the harness's own id | **Equal, both harnesses.** Claude: the adapter passes its id to the SDK as `options.sessionId`, and every hook arrived with that `session_id`. Codex: the session id is the thread id (`sessionId: response.thread.id`), and the rollout under `~/.codex/sessions` carries it as `session_id`. No cwd-matching fallback is needed. |
| Which cophylad hooks fire in the spawned Claude session? | `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop`, all over http with the same id. **`PermissionRequest` does fire**, unlike spike 02's `-p` run: the SDK's stream mode loads the settings hooks. It arrived 1 ms before `session/request_permission`; a `{}` answer let the prompt fall through to ACP, as architecture.md assumes. `SessionStart` and `SessionEnd` did not reach the stub (the SDK starts the process before project settings are read, and the spike kills the child). |
| Codex hooks | Not observed by the stub: Codex hooks come from `CODEX_HOME/hooks.json` through the shim, which points at the daemon already running on this machine. The id relation above is what the adapter needs. |
| Does `session/prompt` block for the whole turn? | **Yes.** It resolves with `{stopReason, usage, _meta}` when the turn ends: 7.3 s for the Claude write turn, 20 s for Codex's. |
| Cancel | `session/cancel` (a notification) makes the in-flight `session/prompt` resolve with `stopReason: cancelled` within 15–40 ms on both. The session stays usable: the next prompt answered normally. |
| Usage | `usage_update {used, size, cost?: {amount, currency}}` on every step (Claude also sends `_meta._claude/origin`). Token counts per turn come back in the prompt result: Claude `usage {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens}`, Codex `{totalTokens, inputTokens, cachedReadTokens, outputTokens, thoughtTokens}`; both also carry `_meta.quota.model_usage[]` with the model name. **So `Session.stats.tokens` can be filled for ACP sessions** (open question 5). |
| Does the spawned Claude session show up in the session registry? | **Yes.** `~/.claude/sessions/<pid>.json` for the SDK's child carried the ACP session id (`entriesForThisSession: ["116752.json"]`). The Claude adapter's registry poll and transcript tail therefore see it; `Sessions` must treat ACP-owned native ids as taken, and the Codex adapter's `thread/list` sees the thread the same way. |

## Update shapes seen

Claude (`claude-agent-acp`):

- `agent_message_chunk {content: {type: text, text}, messageId}`: one `messageId` per assistant message, many chunks.
- `tool_call {toolCallId, name, rawInput: {}, status: pending, title: "Preparing file…", kind: edit, content: [], locations: []}` arrives **before the input is known**; the input fills in through `tool_call_update {rawInput, title, content: [{type: diff, path, oldText, newText}], locations}` (no `status`), then a `tool_call_update` carrying only `_meta.claudeCode.toolResponse`, then `tool_call_update {status: completed, rawOutput}`. An adapter that wants one `tool_call` event with the input has to write it on the first update that carries an input, or when the permission request names it.
- `session/request_permission {toolCall: {toolCallId, name, status, rawInput, title, kind, content, locations}, options: [{optionId: "allow-once", name: "Yes", kind: allow_once}, {optionId: "allow-with-updates", name: "Yes, allow all edits during this session", kind: allow_always}, {optionId: "reject", name: "No", kind: reject_once}], _meta.permission.title}`.
- `available_commands_update`, `config_option_update` (the mode picker), `session_info_update {title, updatedAt}` after the first turn, `_auth/status_update` notifications with the account.
- `session/new` answers `{sessionId, modes: {currentModeId, availableModes: [default, acceptEdits, plan, auto, bypassPermissions]}}`. The user's `permissions.defaultMode: "auto"` became the session's mode; `session/set_mode {modeId: "default"}` put it back to asking. cophylad should set `default` on every spawn so the agent's prompts reach the queue.
- `_meta.claudeCode.options.model: "haiku"` on `session/new` picked the model.

Codex (`codex-acp`):

- `session/new` answers `{sessionId, models: {availableModels: [{modelId: "gpt-6-astra[low]", …}, …27]}, modes: {availableModes: [read-only "Ask for approval", agent "Approve for me", …]}}`; `session/set_model {modelId: "gpt-5.6-luna[low]"}` and `session/set_mode {modeId: "read-only"}` work (`default` is not a Codex mode id and fails with `Invalid params`).
- `agent_thought_chunk` with reasoning summaries, then `tool_call {toolCallId: "exec-…", status: in_progress, kind: execute|edit, title, content: [{type: terminal, terminalId}] | [{type: diff, …}], rawInput: {command, cwd}}` and `tool_call_update {name: "exec_command", status: completed, rawOutput: {formatted_output, exit_code}, _meta.terminal_exit}`.
- `session_info_update {_meta: {codex: {threadStatus: {type: active, activeFlags: []} | {type: idle} | {type: active, activeFlags: ["waitingOnApproval"]}}}}` and `{title}`: a status stream of its own.
- `session/request_permission {sessionId, toolCall: {toolCallId, kind: execute, status: pending, title: "Run command", rawInput: {command, cwd}}, options: [{optionId: "allow_once", kind: allow_once}, {optionId: "accept_execpolicy_amendment", kind: allow_always}, {optionId: "cancel", kind: reject_once}], _meta.permission {title, description}}`.
- **Caveat.** With this machine's `approvals_reviewer = "auto_review"`, a write inside the workspace was approved by Codex itself in both modes and never reached ACP. A write outside the workspace (`--outside`) did need an approval, but the prompt sat for 173 s and returned `end_turn` first; the `tool_call` and the `session/request_permission` surfaced only when the next `session/prompt` went out, with `threadStatus.activeFlags: ["waitingOnApproval"]` in between. An adapter must accept `session/request_permission` at any time, not only inside a prompt, and should read `threadStatus` as a status hint.

## What the adapter takes from this

- Spawn `[runtime, <package>/dist/index.js]` with the profile's `configDir` in `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, the binary in `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`, and `CLAUDE_CODE_*` scrubbed; `node` on PATH else Bun.
- `initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}}` → `session/new {cwd, mcpServers: []}` → `session/set_mode` (Claude `default`, Codex `read-only`) → `session/prompt`. One prompt in flight per session; `session/cancel` to interrupt.
- Native id = ACP session id for both harnesses. The attached adapters skip records whose transport is `acp`, and a hook for such an id is answered `{}` so the prompt falls through to ACP.
- Events: chunks of one `messageId` fold into one `assistant_text`; a tool call's input is taken from the first update that carries one; `completed|failed` → `tool_result`; `usage_update` → `stats.context` and `stats.cost`; the prompt result's `usage` → `stats.tokens`.
- A permission ask's options are the agent's own, `allow_*` primary and `reject_*` danger; a cancelled or expired ask answers the first `reject_*` option.

## Left behind

- `out/` and `node_modules/` here are gitignored. `target/.claude/settings.json` is the stub's hook install, harmless without the stub.
- Claude transcripts for the three sessions under `~/.claude/projects/C--D-orchestrator-spikes-08-acp-target/`, and three Codex threads with cwd under `spikes/08-acp/target` in `~/.codex/sessions` (`codex delete <id>` removes them). The daemon this machine runs on port 4817 saw the same sessions through the user's own hooks and recorded them like any other.
