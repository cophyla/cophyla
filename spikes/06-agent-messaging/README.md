# Spike 06: agent messaging, end to end

Date: 2026-09-17. Windows 11, Claude Code 2.1.274, Codex CLI 0.153.4, Bun 1.3.14. The P1 slice
of the agent-messaging proposal (same machine, across harnesses) plus
channels. The Claude inbox mechanics are in [01-claude-inbox](../01-claude-inbox/README.md)
and the Codex ones in [05-codex](../05-codex/README.md). Proxy peers were not tried.

**Verdict: the shape in the doc works.** A Claude session messaged a Codex thread and got a
reply, both legs through one MCP shim and a 150-line router, with each caller identified and
nothing changed in how either harness was started beyond adding the MCP server.

## Pieces

| File | Role |
|---|---|
| `cophyla-mcp.mjs` | the `cophyla` MCP server: stdio, no SDK, tools `agents_list` and `message_send`, `instructions` that explain the envelope. With `COPHYLA_CHANNEL=1` it also declares `claude/channel` and `claude/channel/permission`. |
| `router.ts` | a minimal `cophylad.messages` under Bun: directory, caller identity, envelope, duplicate and rate limits, delivery, one audit line per step. Owns a `codex app-server --stdio` child. |
| `mcp-cophyla.json`, `mcp-cophyla-channel.json` | per-session MCP config for the Claude side, passed with `--mcp-config` so no user settings were touched. Codex got the same server through `-c mcp_servers.cophyla.*`. |

Only sessions whose cwd is this folder are listed or addressable.

## The round trip

From `out/audit.jsonl`:

```
13:18:29.289 mcp.call       agents_list   caller=spike-msg-claude  how=claude process-tree walk
13:18:32.927 mcp.call       message_send  caller=spike-msg-claude
13:18:33.226 message.routed spike-msg-claude → codex-21d0a6dc   via thread/queue/add   queued
13:18:53.036 mcp.call       message_send  caller=codex-21d0a6dc   how=codex _meta.threadId (sandbox=read-only)
13:18:53.677 message.routed codex-21d0a6dc → spike-msg-claude   via inbox pipe         queued
```

The Claude session then received, as a peer turn with `origin.from = "codex-21d0a6dc"`:

```
<cophyla-message from="codex-21d0a6dc" harness="codex" node="this-machine" id="pmsg_95a51e2c" replyTo="pmsg_aa7c082c">
MARCO-POLO
</cophyla-message>
```

Codex filled in `replyTo` unprompted from the envelope it had been sent. The 20 s between the
two legs is Codex's pickup delay for an idle thread (up to ~10 s, see 05-codex) plus its turn.

## Findings

**Caller identity**

- **Codex:** every `tools/call` carries `_meta.threadId`, and `x-codex-turn-metadata` gives the
  sandbox mode, which is the sender's permission class for the parity rule. Resolution took
  ~300 ms, nearly all of it `thread/list`.
- **Claude:** `_meta` has only `claudecode/toolUseId` and `progressToken`. The process tree is
  short, `node.exe (shim) < claude.exe`, and the parent pid is the registry pid, so the walk in
  the doc works. But it is not needed: **Claude passes `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_PROJECT_DIR` to the MCP server's environment.**
  The shim can report its session id directly. The spike's walk shells out to PowerShell and
  costs 1–4 s per call; with the env var it is free.

**Directory**

- **A Codex thread does not exist until its first turn.** A freshly opened TUI is absent from
  `thread/list`; after one turn it appears. Until then cophylad can only know it from the
  `sessionStart` hook.
- **`thread.name` defaults to the text of the first prompt** ("Reply with the single word
  ok."). It cannot be the address. The spike uses `codex-<last 8 of the id>`; the real thing
  wants a short stable alias that cophylad assigns and shows in `agents_list`.

**Provenance.** Claude's wrapper says "Another Claude session sent a message" whatever the
source, and Codex shows the text as if the user typed it. The body envelope is the only
provenance on both sides, so it is not optional, and the MCP `instructions` field is the right
place to explain it: both models followed it without being told in the prompt.

**Delivery status.** Neither leg acknowledges. `queued` is all the router can say at send
time. `delivered` needs evidence: the `UserPromptSubmit` hook on the Claude side, a rollout
`UserMessage` with a matching `client_id` on the Codex side.

**No approval prompt** appeared in Codex for the MCP tool call under `-s read-only`. Claude
needed the two tools in `--allowedTools`, or it asks each time in `manual` mode; the installer
should add a permission rule next to the MCP entry.

## Channels

| Test | Result |
|---|---|
| Launch with `--dangerously-load-development-channels server:cophyla` | Works, but **every launch shows a blocking dialog** ("WARNING: Loading development channels … 1. I am using this for local development / 2. Exit"). A person or a PTY has to press Enter. Whether a headless or ACP launch can pass it is untested. |
| Push `notifications/claude/channel {content, meta}` | Arrived as `← cophyla: …`, started a turn, the session answered. Debug log: `Channel notifications registered`. |
| Permission relay | With `claude/channel/permission` declared, a Write prompt produced `notifications/claude/channel/permission_request {request_id, tool_name, description, input_preview}` at the shim. The router answered `notifications/claude/channel/permission {request_id, behavior: "allow"}` and the write went through with nobody touching the terminal. |

So the mapping onto `Ask` is real. Against that: it is a research preview, the flag name says
what Anthropic thinks of it, and the dialog means cophylad cannot spawn such a session unattended
today. The `PermissionRequest` hook (spike 02) does the same job on sessions the user opened
themselves, with no flag. **Hooks stay the primary ask path; channels are P4 polish.**

## Corrections to agent-messaging.md from this spike

Applied to the agent-messaging proposal; kept here as the reasoning behind them.

1. Identity: Codex by `_meta.threadId`; Claude by `CLAUDE_CODE_SESSION_ID` from the shim's
   environment, with the process-tree walk only as a fallback. Drop "cophylad resolves the owning
   session from the process tree" as the general mechanism.
2. `PeerMessage.status`: `queued` on send, `delivered` only on a hook or rollout receipt.
3. Addressing: cophylad assigns Codex aliases; thread names are not usable.
4. Directory: Codex threads appear at first turn or at `sessionStart`, whichever cophylad sees
   first.
5. Channels: work, with the launch dialog as the blocker for unattended spawn.
6. The hold on bypass sessions (spike 01, T3) applies to every message cophylad routes into a
   bypass Claude session. Open question 3 is therefore a launch-blocking product decision for
   users who run in bypass, not a detail.

## Run it

```
cd spikes/06-agent-messaging && bun router.ts            # port 4811
# from spikes/, the two agents:
node _pty/tui-server.mjs --port 4808 --cwd 06-agent-messaging/target -- claude --name spike-msg-claude --model haiku --permission-mode manual \
  --mcp-config C:/D/orchestrator/spikes/06-agent-messaging/mcp-cophyla.json --strict-mcp-config --allowedTools "mcp__cophyla__agents_list mcp__cophyla__message_send"
node _pty/tui-server.mjs --port 4809 --cwd 06-agent-messaging/target -- codex --no-alt-screen -m gpt-5.6-luna -c 'model_reasoning_effort="low"' -s read-only \
  -c 'projects.c:\d\orchestrator.trust_level="trusted"' -c 'mcp_servers.cophyla.command="node"' -c 'mcp_servers.cophyla.args=["C:/D/orchestrator/spikes/06-agent-messaging/cophyla-mcp.mjs"]'
curl -s -XPOST localhost:4809/submit -d 'Reply with the single word ok.'      # gives the Codex thread an id
curl -s -XPOST localhost:4808/submit -d 'Call cophyla agents_list, then message_send the codex agent: "reply MARCO-POLO with message_send".'
```

Left behind: one more Codex thread in the history with cwd `spikes\06-agent-messaging\target`.
