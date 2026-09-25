# Spike 03: cophylad's hooks next to another tool's hooks

Date: 2026-09-17. Windows 11, Claude Code 2.1.274. emdash has already written hooks into
`~/.claude/settings.json` on this machine (`UserPromptSubmit`, `Notification`, `Stop`), so the
question was whether cophylad can add its own without either tool breaking the other. The user's
settings file was read, never written; test hooks were loaded with `--settings`.

**Verdict: coexistence is fine. The real finding is that emdash's hooks are broken on this
machine, in a way cophylad's installer must not repeat.**

## Results

| Test | Result |
|---|---|
| Hooks from two sources (user settings + `--settings`) on the same event | Both run. Every spike session showed `running Stop hooks… 0/2` and the stub received the event. |
| Two tools' entries in the **same** event array (`settings-same-array.json`, user settings excluded with `--setting-sources project,local`) | Both run: `out/other-tool.log` has `UserPromptSubmit` and `PermissionRequest`, and the stub got the same events. |
| A passive hook (no output, exit 0) beside one that blocks on `PermissionRequest` | The passive one returns at once and does not settle the prompt; the blocking one still decides. |
| Does emdash overwrite other tools' entries? | No. `packages/core/src/services/agent-plugins/api/plugins/helpers/hooks.ts` filters out only entries whose text contains its marker (`EMDASH_HOOK_PORT`) and keeps the rest. |

## emdash's hook is broken under Claude Code on Windows

Its command is `cmd.exe /d /c set EMDASH_HOOK_MARKER=…&&powershell.exe … -EncodedCommand …`.
Claude Code runs hook commands through Git Bash here, and MSYS path conversion rewrites the
`/d` and `/c` switches into paths. `cmd.exe` then starts as an interactive shell, reads the
hook's stdin (the event JSON) as commands, and prints its banner and the JSON to stdout.
Reproduced outside Claude:

```
$ echo '{"probe":1}' | cmd.exe /d /c set X=1\&\&echo ran-ok
Microsoft Windows [Version 10.0.26200.9168] …
C:\…>{"probe":1}
'{"probe":1}' is not recognized as an internal or external command
$ echo '{"probe":1}' | MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c "set X=1&&echo ran-ok"
ran-ok
```

Two consequences, both live in every Claude session on this machine right now:

1. emdash receives no hook events from Claude Code.
2. Stdout of a `UserPromptSubmit` hook is added to the model's context, so **every prompt in
   every session carries ~700 characters of `cmd.exe` banner plus the event JSON**. It shows in
   each spike transcript as a `hook_success` attachment, and in the session that ran these
   spikes.

This is emdash's bug, not cophylad's, and fixing it means editing the user's settings, so it was
left alone. Removing the three emdash entries from `~/.claude/settings.json`, or reinstalling
them from a fixed emdash, clears it.

## What cophylad's hook installer should do

- **Prefer `type: "http"` hooks.** Claude Code POSTs the event to a URL itself: no process per
  event, no shell, no quoting, nothing on stdout. Verified for `PermissionRequest`, including
  the blocking answer (spike 02). Note the managed setting `allowedHttpHookUrls` can forbid
  them in an enterprise install, so keep a command fallback.
- **If a command hook is needed, make it shell-proof:** one executable and one forward-slash
  path (`node C:/…/hook-shim.mjs` worked everywhere). No `cmd /c`, no switches that start with
  `/`, no `&&`.
- **Print nothing unless it is a decision.** Stdout is either parsed as the hook's JSON answer
  or, for some events, injected into context. [`hook-shim.mjs`](../02-permission-hook/hook-shim.mjs)
  exits 0 silently when cophylad is not running, so a stopped daemon never breaks a session.
- **Own a marker and touch only entries that carry it**, the way emdash does. A distinctive URL
  path or script path is enough.
- **Expect its own injected messages back** through `UserPromptSubmit` (spike 01).

## Unverified

- Precedence when two hooks return conflicting `PermissionRequest` decisions.
- Codex hook coexistence. Codex hooks also carry a hash-based trust status (see 05-codex), so
  installing them has a trust step Claude's do not.
