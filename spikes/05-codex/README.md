# Spike 05: Codex session control and MCP caller identity

Date: 2026-09-17. Windows 11, Codex CLI 0.153.4 (desktop app 26.908 also installed and running),
Bun 1.3.14, Node 22.22.2. Covers the Codex spike plus two questions from
the agent-messaging proposal: who is calling an MCP tool, and whether a user-opened thread
accepts a queued message. Everything below was run on this machine unless marked
**unverified**. Cost: 10 tiny turns on `gpt-5.6-luna` at low effort.

## Verdict

| Question | Answer |
|---|---|
| A. Is a user-opened TUI thread on a shared daemon? | **No, not on Windows. There is no shared daemon on Windows at all.** Every `codex` process embeds its own app-server. |
| B. Does `codex queue` reach a live TUI thread? | **Yes.** Idle: starts a turn after 2–10 s. Busy: runs 20 ms after the current turn ends. |
| C. Can Bun speak the app-server protocol? | **Yes**, over stdio to an app-server we spawn ourselves. `codex app-server proxy` does not work on Windows. |
| D. Can the MCP shim identify the calling thread? | **Yes, in-band.** Every `tools/call` carries `_meta.threadId`. The process tree is the wrong tool. |
| E. Do the Codex hooks match the survey? | **No.** The event set is now Claude-shaped and includes `permissionRequest`. |

## A. Discovery: no shared daemon on Windows

```
$ codex app-server daemon version
Error: codex app-server daemon lifecycle is only supported on Unix platforms
$ codex agents
Error: `codex agents` requires `--remote` on this platform
$ echo '{"id":1,"method":"initialize",...}' | codex app-server proxy
Error: failed to connect to socket at C:\Users\me\.codex\app-server-control\app-server-control.sock
    A socket operation encountered a dead network. (os error 10050)
```

- The TUI process (`codex.exe`) owns no TCP listener and no app-server named pipe
  (`list-pipes.ps1`). The only `codex.exe app-server` on the machine is a stdio child of the
  desktop app (`ChatGPT.exe`), which is private to it.
- What the processes share is the **store under `~/.codex`**: rollout files, the state
  SQLite files and `queue_1.sqlite`. `thread/list` on any app-server sees every stored
  thread. A thread that is live in another process shows as `status: {type: "notLoaded"}`,
  so **the app-server cannot tell us whether a user-opened thread is live, idle or busy.**
- `session_meta` in the rollout distinguishes the origin: TUI `originator: codex-tui, source:
  cli`; `codex exec` gives `codex_exec / exec`; a thread started over our own app-server gives
  `source: vscode`. All carry `thread_source: user`.
- The rollout records token usage per turn (`token_count` with input, cached input, output,
  reasoning, plus `model_context_window`). That answers the token-source question in entities.md for Codex.
- **Unverified:** the Unix daemon layout, where the TUI may attach to the shared daemon.

## B. Injection with `codex queue`

```
cd spikes/05-codex/target
codex queue --thread <uuid> --message "text"
→ Queued message 01a0af79-9c94-… for thread 01a0af79-2976-…        (returns in ~1 s)
```

| Target state | Result |
|---|---|
| Live TUI, idle | Turn starts by itself. Measured pickup: 10 s, 1.7 s, 6.2 s — the TUI polls the queue store on a roughly 10 s timer. |
| Live TUI, busy | Queued behind the turn. Turn ended 13:07:10.376, queued turn started 13:07:10.396. |
| Not live anywhere (finished `exec` thread) | `queue/add` still succeeds. The item sits in the queue forever (`queue-dead-thread.ts`; deleted again afterwards). |

The TUI shows the text as an ordinary `› user message`. In the rollout it is an ordinary user
`response_item`. The one difference is on the `UserMessage` item:
`"client_id": "<clientUserMessageId>"`, absent on typed messages. With the raw method we choose
that id, so cophylad can recognise its own injections when it tails the rollout. The model sees
no provenance at all, so the envelope has to be in the text, as agent-messaging.md assumes.

Mechanism: `queue_1.sqlite`, table `queued_items(id, thread_id, payload_json, queue_order, …)`
plus `queued_thread_revisions`. `codex queue` is a thin wrapper over `thread/queue/add`.

## C. Protocol, from Bun

`codex app-server generate-json-schema --experimental --out out/schema-exp` (155 client
methods; 99 without `--experimental`). Corrections to the docs:

| Doc says | Actual |
|---|---|
| `thread/inject` | `thread/inject_items {threadId, items}` — appends raw Responses items, starts no turn |
| `thread/queue/*` | `thread/queue/add · list · update · delete · reorder · start`, **experimental only** |
| `item/mcpToolCall` events | `item/started` and `item/completed` with `item.type: "mcpToolCall"`, plus `item/mcpToolCall/progress` |

Handshake (`appserver-client.ts`): spawn `codex app-server --stdio`, newline-delimited
JSON-RPC, then

```
→ {"id":1,"method":"initialize","params":{"clientInfo":{"name","version"},"capabilities":{"experimentalApi":true}}}
← {"id":1,"result":{"userAgent":…,"codexHome":…,"platformOs":"windows"}}
→ {"method":"initialized"}
→ {"id":2,"method":"thread/queue/add","params":{"threadId","clientUserMessageId":"cophyla-<uuid>","input":[{"type":"text","text":"…"}]}}
← {"id":2,"result":{"queuedSubmission":{"id","input","clientUserMessageId"}}}
```

Without `experimentalApi: true`: `{"code":-32600,"message":"thread/queue/list requires
experimentalApi capability"}`. Whole round trip from Bun: ~250 ms, no auth beyond the user's
existing login. `turn/steer` needs `expectedTurnId`, which we cannot learn for a thread live in
another process, so **mid-turn steering of user-opened threads is not available on Windows**.
`thread/resume` on a thread that is live elsewhere was deliberately not tried (two writers on
one rollout).

## D. MCP caller identity

`whoami-mcp.mjs` logs its parent chain and the raw `tools/call`. Registered per run with
`-c 'mcp_servers.cophylaspike.command="node"' -c 'mcp_servers.cophylaspike.args=["…/whoami-mcp.mjs"]'`.

| Host | Who spawns the shim | Processes |
|---|---|---|
| TUI | the TUI `codex.exe` | one per TUI process |
| `codex exec` | the exec `codex.exe` | one per run |
| One app-server, two threads (`appserver-two-threads.ts`) | the app-server | **one per thread**, both children of the same app-server pid |

So pid → process tree resolves to the app-server, never to the thread. It is also unnecessary.
The request carries the identity (no env vars do):

```json
"_meta": {
  "threadId": "01a0af79-2976-7752-8597-4e480c5860cd",
  "callId": "exec-672e0f01-…",            // equals item.id in item/started|completed
  "itemId": "ctc_0dc2…",
  "x-codex-turn-metadata": {
    "session_id": "…", "thread_id": "…", "turn_id": "…",
    "thread_source": "user", "sandbox": "windows_elevated", "sandbox_mode": "read-only",
    "auto_review_enabled": true, "model": "gpt-5.6-luna", "reasoning_effort": "low",
    "workspaces": {"C:\\D\\orchestrator": {"has_changes": true}}
  }
}
```

`sandbox_mode` is the sender's permission class, which is what the gate's parity rule needs.
The same object arrives for threads started over our own app-server, minus the `thread_source`
key; `threadId` was present in all four calls. The app-server events carry `threadId`, `turnId`, `item.id` and `arguments`,
so a nonce would work too, but only for threads on an app-server we own. No approval prompt
appeared for the tool (it declares `readOnlyHint: true`); a tool without the hint is
**unverified**.

## E. Hooks

Schema `HookEventName`: `preToolUse, permissionRequest, postToolUse, preCompact, postCompact,
sessionStart, sessionEnd, userPromptSubmit, subagentStart, subagentStop, stop, interrupt`.
Handler types `command | mcpTool | prompt | agent`, sync or async, default `timeoutSec: 600`.
`hooks/list` (`hooks-list.ts`) shows each hook's `source`, `sourcePath` (`hooks.json`),
`currentHash` and `trustStatus: managed | untrusted | trusted | modified`. The legacy `notify`
program in `config.toml` is a single slot and is already taken by `codex-computer-use.exe`.
Nothing was installed.

## Recipes

**Inject a message into a live Codex thread from an external process**

1. Spawn `codex app-server --stdio`; send `initialize` with `capabilities.experimentalApi: true`,
   then `initialized`.
2. `thread/queue/add {threadId, clientUserMessageId: "cophyla-<uuid>", input: [{type:"text", text}]}`.
   (`codex queue --thread <id> --message <text>` is the same thing without the chosen id.)
3. Confirm delivery by tailing the thread's rollout for `item_completed` →
   `item.type == "UserMessage" && item.client_id == "cophyla-<uuid>"`. Expect 0–10 s when idle.
4. Not delivered in time → `thread/queue/delete {threadId, queuedSubmissionId}`.

**Resolve the calling thread of an MCP tool call**

Read `params._meta.threadId` on `tools/call` (fall back to
`_meta["x-codex-turn-metadata"].thread_id`). Take `sandbox_mode` from the same object.

## Doc corrections from this spike

Applied to the design docs; kept here as the reasoning behind them.

**session-control-survey.md §3.** "`codex app-server daemon` is a shared local daemon" holds on
Unix only. On Windows discovery is the thread store (`thread/list` over our own app-server)
plus hooks for liveness, and `codex agents` is unusable. Replace "hooks: notification, stop,
session" with the event list above.

**architecture.md, sessions table, Codex row.** Discover: `thread/list` on a cophylad-owned
app-server child, liveness from `sessionStart`/`sessionEnd`/`stop` hooks. Send:
`thread/queue/add` (experimental API). Status and asks: hooks including `permissionRequest`;
the app-server reports `notLoaded` for threads it does not host. Spawn: either the ACP adapter
or our own app-server, which gives full events (`thread/status/changed`, `turn/completed`,
items). Adapters can fill Codex token counts from the rollout. The config installer has to
handle hook trust: a hook cophylad writes starts `untrusted`, and editing it later makes it
`modified`. How trust is granted is **unverified**.

**agent-messaging.md.** Caller identity: drop "cophylad resolves the owning session from the
process tree" for Codex and use `_meta.threadId` (Claude's equivalent is in 06). User-opened
threads accept `thread/queue/add`, with a caveat:
with up to ~10 s latency when idle, no mid-turn `turn/steer`, and a silent black hole when the
thread is not live. `PeerMessage.status` should move to `delivered` only on the rollout
receipt, and `expired` should call `thread/queue/delete`. Fix the method names per section C.
In the harness table, Codex provenance can use `client_id` for cophylad's own bookkeeping.

## Files

| File | Purpose |
|---|---|
| `whoami-mcp.mjs` | stdio MCP server, logs spawn chain and `tools/call` to `out/whoami.jsonl` |
| `appserver-client.ts` | Bun: initialize, list, read, `thread/queue/add` into a live TUI thread (`NO_EXP=1` shows the capability gate) |
| `appserver-two-threads.ts` | Bun: two threads on one app-server, MCP process count and events |
| `queue-dead-thread.ts` | queue to a finished thread, confirm it never drains, delete it |
| `hooks-list.ts` | read-only `hooks/list` |
| `inspect-queue-db.py`, `list-pipes.ps1` | read-only look at the queue store and at pipes/listeners |

TUI target used for A, B and D (from `spikes/`):

```
node _pty/tui-server.mjs --port 4820 --cwd 05-codex/target -- codex --no-alt-screen \
  -m gpt-5.6-luna -c 'model_reasoning_effort="low"' -s read-only \
  -c check_for_update_on_startup=false \
  -c 'projects.c:\d\orchestrator.trust_level="trusted"' \
  -c 'mcp_servers.cophylaspike.command="node"' \
  -c 'mcp_servers.cophylaspike.args=["C:/D/orchestrator/spikes/05-codex/whoami-mcp.mjs"]'
```

The trust override must be written unquoted as above; the quoted-key TOML form is ignored and
the TUI then offers to write the trust entry into `~/.codex/config.toml`.

## Left behind

Nothing under `~/.codex` was edited and no process is left running. The spike did create four
threads in the Codex history, all with cwd `spikes\05-codex\target`:
`01a0af79-2976-…` (TUI), `01a0af7c-5939-…` (exec), `01a0af7d-4a67-…` and `01a0af7d-7e57-…`
(app-server). They were not archived or deleted; `codex delete <id>` removes them.
