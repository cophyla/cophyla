# Spike 02: answer a terminal permission prompt from somewhere else

Date: 2026-09-17. Windows 11, Claude Code 2.1.274. `architecture.md` says a `PermissionRequest`
hook "blocks until the gate, the brain or the user has answered, which is how a phone answers a
terminal prompt". This spike held that hook open with a stub cophylad
([`cophylad-stub.mjs`](cophylad-stub.mjs)) and answered it late, early, never and from the wrong
place. Targets were interactive Haiku sessions in `manual` mode; hooks were loaded with
`--settings`, so the user's settings were not touched.

**Verdict: works, including a 12-minute wait. Two behaviours need handling: a terminal answer
leaves the hook hanging, and an unanswered hook is cut off at 600 s by default.**

## Results

| # | Test | Result |
|---|---|---|
| a | Is the terminal dialog shown while the hook is pending? | **Yes.** The normal "Do you want to create …? 1. Yes / 2. … / 3. No" is on screen the whole time, so the terminal and the phone are both live. |
| b | Answer `allow` from the stub after 96.7 s, no `timeout` set | Dialog dismissed, file written, turn continued. |
| c | Answer in the **terminal** while the hook is pending | The terminal wins at once. **Claude does not kill the hook process**: the shim (pid 89564) stayed alive and the stub still listed the request as pending. |
| c′ | Late answer from the stub to that orphaned request | Ignored, no effect on the session; the shim then exits. |
| d | Answer `deny` with a message | The tool call fails with exactly that message (`Error: Denied from the phone: SPIKE-DENY-REASON-42`, "Denied by PermissionRequest hook") and the model relayed it. |
| e | Hook `timeout: 15`, never answered | At 15 s the shim is killed. The terminal dialog stays up and works. A timeout degrades to "answer it locally", which is the right failure. |
| f | Command hook, no `timeout`, never answered | Claude hung up at **600.5 s**. The default timeout is 600 s. The terminal dialog was still there afterwards. |
| g | `type: "http"` hook with `timeout: 7200`, answered `allow` after **712.7 s** | Worked. Claude POSTs the event itself; no shim process, nothing on stdout. |

Also seen: `echo` needs no permission even in `manual` mode, so use a Write to get a prompt. A
`Notification` event (`notification_type: permission_prompt`) follows each
`PermissionRequest` by about 6 s.

## Wire shapes

Event, as POSTed by an http hook or piped to a command hook:

```
{session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name: "PermissionRequest",
 tool_name, tool_input, permission_suggestions}
```

There is **no `tool_use_id`** on it. Answer:

```
{"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow" | "deny", "message"?: "…"}}}
```

(`session-control-survey.md` says `permissionDecision`; that is the `PreToolUse` field. The
debug log reports the parsed result as `returned permissionDecision: allow`, which is probably
where the mix-up came from.)

## What this means for the design

- **Install the hook with an explicit long `timeout`** (the spike used 7200). With the default,
  an `Ask` silently stops being answerable from the phone after ten minutes while still looking
  open.
- **Set `Ask.expiresAt` from that timeout**, and mark the ask `expired` when the hook's
  connection drops unanswered (`res.on('close')` with the response not ended is the signal;
  `req.on('close')` is not).
- **cophylad must notice terminal answers itself.** Nothing tells the hook that the user answered
  locally. Close the ask when a `PostToolUse` (allowed), `PostToolUseFailure` or the next
  `Stop` for that session arrives, matched on `session_id` + `tool_name` + `tool_input`, since
  there is no `tool_use_id` to match on. Then answer the hanging request so the connection is
  released. `brain.md` already says "an item tied to an ask closes when the ask closes, whoever
  answered it"; this is the mechanism.
- **Prefer `type: "http"` hooks** for ingress (see spike 03 for why), with the command shim as
  the fallback. [`hook-shim.mjs`](hook-shim.mjs) exits 0 with no output when cophylad is down, so
  a stopped daemon never blocks or breaks a session.
- `PermissionRequest` does not fire in `-p` (print) mode; the binary has a separate "headless
  agent" path. Sessions cophylad spawns over ACP get their asks from `session/request_permission`
  instead. Not tested here.

## Unverified

- Two hooks returning conflicting decisions.
- Whether `updatedInput` works on `PermissionRequest` answers.
- The same flow on Codex, whose hooks now include `permissionRequest` (see 05-codex).

## Run it

```
cd spikes/02-permission-hook && node cophylad-stub.mjs 4810
# from spikes/
node _pty/tui-server.mjs --port 4804 --cwd 02-permission-hook/target -- claude --name spike-perm --model haiku --permission-mode manual \
  --settings C:/D/orchestrator/spikes/02-permission-hook/settings-http.json
curl -s -XPOST localhost:4804/submit -d 'Use the Write tool to create the file x.txt containing hello.'
curl -s localhost:4810/pending
curl -s -XPOST localhost:4810/answer -d '{"behavior":"allow"}'
```

`settings-cmd-default.json`, `settings-cmd-timeout15.json`, `settings-cmd-timeout7200.json`
and `settings-http.json` are the four variants tested.
