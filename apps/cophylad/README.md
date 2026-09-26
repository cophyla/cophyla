# cophylad

The daemon. Runs once per user per machine; every install is the same daemon, with the brain
on when the node is the primary.

```
bun run apps/cophylad/src/main.ts [--home <dir>] [--port <n>]
bun run apps/cophylad/src/main.ts invite [--name N] [--role hands|full] [--expires 1d] [--invite-expires 1h]
bun run apps/cophylad/src/main.ts invite --phone [--name N] [--access full|sessions|view] [--expires 1d] [--invite-expires 15m]
bun run apps/cophylad/src/main.ts join [--file F|-] [--workspace P]... [--answer-here]
bun run apps/cophylad/src/main.ts leave
```

`invite`, `join` and `leave` are thin clients of the running daemon on its loopback listener,
authenticated with `data/client.token` like the desktop app, and take `--home` and `--port`
as the daemon does. `invite` asks the primary for a node's invite (hands unless `--role
full`) and prints its text on stdout, for the new machine's `cophylad join`; with `--phone` it
is a phone's, with the access preset named (everything by default), and on a terminal its QR
code is printed beside it on stderr for the phone's camera. `--expires` ends the grant
itself, `--invite-expires` the invite (an hour for a node's, fifteen minutes for a phone's);
durations are `90s`, `30m`, `12h`, `1d`, `2w`. `join` reads the invite from a file or stdin,
never the command line, so it stays out of the process list and the shell's history; each
`--workspace` is a folder the primary may use here, and none shares the machine; `--answer-here`
keeps the asks raised here to this machine's own clients. `leave` leaves the cluster, and the
machine runs alone.

`--home` defaults to `$COPHYLA_HOME`, then `~/.cophyla`. On first start the daemon writes a
commented `config.toml` there, creates `data/cophyla.sqlite`, and generates `data/client.token`,
the token a client presents in `hello` on `ws://127.0.0.1:4817/ws/client`. It also generates
`data/hook.token`, the bearer token the harness hooks present at `/hooks/*`, and writes the
hook shim and `data/hook.json` beside it. A node's membership of a cluster is
`data/link.json`: the first primary writes it for itself when it mints the cluster, and any
other machine when it redeems an invite (`cophylad join`). A `data/node.token` left from an
install that shared one token between nodes is removed at start with a line in the log, and
`[nodes] token` is ignored with a warning: each node holds a grant of its own and is invited
again.

## Modules

| Directory | Milestone | Role |
|---|---|---|
| `config/` | 0 | `config.toml` schema with defaults, the user data directory layout |
| `store/` | 0, 6 | SQLite: the tables from architecture.md, migrations, row ↔ entity mapping; `index/` is the recall index: chunks written with every message and session event and on each memory change, FTS5 over their text, int8 vectors for prose from the embedding model under `models/` (`embed.ts`, `queue.ts`), both legs fused in `recall.ts`, the pre-index rows swept by `backfill.ts` |
| `gate/` | 0 | policy per risk class with remembered answers, asks, the audit table |
| `api/` | 0, 1, 6, 8, 12 | WebSocket server, token auth on `hello`, JSON-RPC dispatch through the gate, the `/hooks/*` ingress; `server.ts` serves one listener and a node runs one or two, both registering into one `clients.ts` registry, and accepts a relay tunnel as a socket of the `cloud` kind (`acceptTunnel`); `tls.ts` makes the node's own certificate and keeps its key across re-makes, `pairing.ts` the six-digit code, `tickets.ts` a view's files under the frame policy, `static.ts` the built controller app; a limited client's welcome, broadcasts and lists cut by the protocol's filter tables, and `invite.redeem` answered before `hello` on the LAN listener or an invite's tunnel |
| `grants/` | 17 | every credential that reaches this node from outside, a phone's or a node's, with its own key and access (`store.ts`, over the `kv` namespaces in `namespaces.ts`, the paired phones of an older install moved in place), the one timer that ends what runs out (`clock.ts`), `data/link.json` (`link-file.ts`), phone invites and their redemption (`phones.ts`), and `grant.invite`, `grant.list`, `grant.revoke`, `node.join` and `node.leave` (`methods.ts`) |
| `sessions/` | 1, 3, 18 | every live Claude Code, Codex and Muse session in one model: discovery, tailing, injection, the ask lifecycle, profiles, focus; `acp/` spawns a harness through its ACP adapter and owns the session it made; `muse/` reads and runs Muse sessions through `muse serve` |
| `workspaces/` | 1 | the registry of directories where work happens, from the node's scope and discovered sessions |
| `views/` | 2 | `view.list`, `view.get` and `view.setDefault` over the built-in views in `../views/`, `.ts` type-stripped on serve |
| `rpc/` | 3, 9 | JSON-RPC over any transport (`peer.ts`): a child process's stdio for the brain and the ACP adapters (`stdio.ts`), a WebSocket for the node link (`ws.ts`) |
| `chat/` | 3 | the chat stream: threads and messages, `chat.send` as `user.message` for the brain, `ui.say` stored and streamed, `ui.ask`, typing as `user.activity` |
| `tasks/` | 3 | the task table and the blockers the platform clears itself (an answered ask, a done task, a session gone idle or ended) with `task.ready` on each; a blocker on something already settled settles at once, and a harness ask answered while its agent runs hands the task back to the session |
| `tools/` | 3 | the built-in tools behind `tool.run`: `fs.read`, `fs.grep`, `fs.glob`, `fs.outline`, `http.get`, paths relative to a workspace, caps from `[tools]` |
| `editable/` | 3, 6 | prompts and memory as markdown files with frontmatter under `~/.cophyla/prompts` and `~/.cophyla/memory`; a memory write or delete reaches the index through `onChange` |
| `llm/` | 3, 11 | `llm.complete` walked along the `[providers] llm` route list: a tier or a `vendor/model` to a provider (`gemini.ts`, the cloud module's `server`), streamed as `llm.delta`; `unavailable` and `quota_exceeded` pass a call to the next route |
| `cloud/` | 11, 12 | the account: the device-code login (`login.ts`) with the browser opened by `opener.ts`, the token file (`account.ts`), the outbound server link with `auth` first and backoff (`link.ts`), the entitlement verified against `keys.ts` (`entitlement.ts`), local usage counters (`usage.ts`), the hosted `server` route for the model and for speech (`hosted-llm.ts`, `hosted-stt.ts`, `hosted-tts.ts`), the beta feed with its bearer, the relay tunnels this daemon ends (`tunnels.ts`, over `@cophyla/relay`'s `SealedSocket`: a phone's served by `api`, a node's or a node invite's by `nodes`, a phone invite's by `api` for `invite.redeem` alone), the registry client the role machine asks (`registry.ts`), and `account.login`/`account.logout`/`account.state`, `relay.grant`/`relay.revoke` for any grant, with its kind and end, and the push requests (`index.ts`) |
| `push/` | 12 | an ask that opens with no connection from a controller that registered a push device goes to the server as `push.send` once, trimmed to a title, a detail and three options, and is dismissed when the ask leaves `open`; `push.register` forwarded or kept until the link is up |
| `brain-link/` | 3 | spawns the brain, the `hello` handshake, every brain request through the gate with the brain as principal, the event feed, the outbox while the brain is down, restart with backoff, quote expansion from the audit body, a `reply` completion's `llm.delta` as `chat.delta` with `chat.retract` for a placeholder nothing takes (`stream.ts`) |
| `update/` | 4, 8 | the public release feed read on a schedule (`feed.ts`: signed, this OS/arch/channel, inside our protocol version), downloads checked by size and hash (`download.ts`), platform versions staged behind the `staged` pointer (`platform.ts`), brain releases under `data/brain/` verified before every spawn (`brain.ts`), voice models unpacked under `data/models/<name>/<version>/` and checked against their own manifest (`models.ts`), and `update.check`/`update.apply`/`update.state` (`index.ts`); the release keys' public halves in `keys.ts` |
| `voice/` | 8, 14 | the three stages behind engine interfaces (`engines.ts`) with the local ones beside them — `openwakeword.ts` (the sessions; the streaming pipeline is `@cophyla/wake`'s, which the phone runs too), `silero.ts` (on onnxruntime-node, which ships), `nemotron.ts`, `sherpa-tts.ts` (Piper, Kokoro and Supertonic, with `pieces.ts` cutting a reply into what each makes whole), `chatterbox.ts` — assembled by `local.ts` and `fake.ts`; `catalog.ts` names what each local engine needs, where it comes from and its licences, and `install.ts` installs one when asked; `prefs.ts` keeps the engines and voice the app picked; `runtime.ts` fixes the ONNX load order, `affinity.ts` finds the performance cores, `models.ts` and `manifest.ts` resolve and check a model directory, `conversation.ts` is the per-controller state machine, `compose.ts` turns blocks into speakable text with a lead-in for each quote, and `index.ts` is the module the daemon holds |
| `sidecars/` | 8 | an external process supervised: a free loopback port, a health poll, restart with backoff, a rotated log under `data/sidecars/`, the daemon's own CPU mask (`index.ts`); `tts-py.ts` builds what ships as sources — `uv`, the environment, the locked requirements, the weights — each step marked so an interrupted run resumes, each reported as `voice.setup` |
| `metrics/` | 9 | the machine sampled without a shell: the engines behind one interface (`windows.ts` through `bun:ffi` and `NtQuerySystemInformation`, `linux.ts` over `/proc`, `macos.ts` over libproc, `nvml.ts` for the GPU, `fake.ts` for tests), owners from the process tree (`owners.ts`), the sample built from two raw readings (`sampler.ts`), pressure with hysteresis (`pressure.ts`), per-minute rollups (`rollup.ts`), the price table and the token counters (`prices.ts`, `tokens.ts`), each login's plan limits from Claude's usage endpoint, Codex's rollouts or Muse's host (`limits.ts`), each subscriber's share of the samples with the counts it skipped carried on and the rows summed per owner (`delivery.ts`), and the module with its ring, its subscribers, its adaptive rate and a range's spend (`index.ts`) |
| `remote/` | 10 | the remote desktop: the host found or installed with the package manager (`install.ts`), its API with the cookie login, the blind PIN and the viewer grant (`host.ts`), the Windows service or a spawned host (`service.ts`), moonlight-qt driven by its CLI (`moonlight.ts`), the moonlight-web sidecar fetched from its pinned release (`manifest.ts`, `web.ts`), the tickets and the reverse proxy under `/remote` (`proxy.ts`), the OS screenshot (`screenshot.ts`), and the module with `remote.state` and the viewers (`index.ts`) |
| `nodes/` | 0, 9, 12, 17 | this node's identity (`self.ts`); the sealed sockets every link runs in (`sealed-link.ts`) and redeeming an invite (`enroll.ts`); confinement to the folders a join shares (`confine.ts`); the registry in the `nodes` table (`registry.ts`), the mirrors of remote sessions, asks and workspaces (`mirror.ts`), the link's peer (`peer.ts`), the primary's side of the link with the relay host and the fan-out (`inbound.ts`), the secondary's side with reconnect, heartbeat and the upward stream over a direct socket or a relay tunnel (`outbound.ts`), the requests a secondary serves as principal `node` (`served.ts`), forwarding over both method tables (`forward.ts`), UDP discovery (`discovery.ts`), replication to a backup (`replication.ts`), the role machine with its epoch (`role.ts`), and the module with the server registry's grants folded into the role (`index.ts`) |

`bus.ts` carries `ask.state`, `audit.entry`, `session.state`, `session.event`,
`workspace.state`, `chat.message`, `chat.delta`, `chat.retract`, `task.state`, `task.ready`, `thread.state`,
`user.message`, `user.activity`, `voice.state`, `voice.transcript`, `voice.setup` and
`update.state`, `node.state`, `node.joined`, `node.left`, `node.pressure`, `remote.state`, `account.state` and `entitlement.updated` from the modules
that raise them to the api and brain-link in-process; on a secondary the same bus feeds the
node link upward, and on the primary what a link reports is re-emitted here; `session.event`
goes out per stored event, undebounced, so a timeline in a view grows as the harness works,
to the clients watching that session alone (`api/clients.ts` keeps who watches what, holds
back a `session.state` that only moved its counters from everyone else, and a
`workspace.state` that only moved its activity from everyone, and hands a client every
session, workspace and thread row without the archive's summary and tags, which are the
brain's, and sends no row again whose only change is to those);
`thread.state` reaches clients with `chat` as the notification of the same name, and a
`session.state` whose row alone changed reaches the brain as a `session.updated` without an
`event`. `daemon.ts` composes the modules and is what
the tests start against a temporary home; the brain is started last and stopped first; the
index starts after the sessions and never holds startup up (recall is full-text only until
the model is loaded), and stops before the store closes. `restart.ts` serves `node.restart`:
refused while busy unless forced, then the stop, and a successor started by the daemon itself
unless the desktop app on this machine is attached to start one; `main.ts` holds a successor
back until its predecessor's pid is gone.

## Sessions

`sessions/` attaches to the Claude Code, Codex and Muse sessions the user already runs and
drives them from outside the terminal, and spawns sessions of its own for the brain. Each
harness has an adapter under `claude/`, `codex/` and `muse/`; `Sessions` owns the records keyed by cophylad id
with an index on the harness's native id, so a Claude session resumed under a new pid keeps
its id. `acp/` runs `@agentclientprotocol/claude-agent-acp` or `codex-acp` as a child under
`[acp].runtime` for `session.spawn`; the ACP session id is the harness's own, so the spawned
session's hooks are answered under the record the adapter made, and the attached adapters
skip ACP-owned records; when the harness's registry entry appears before `session/new`
returns and an attached adapter makes the record first, the ACP adapter claims it. A spawned
session carries `origin: orchestrator` and its `task`;
`session.stop` ends one and is `unsupported` on an attached session, unless a client asks:
the user's `session.stop` ends an attached session's process and leaves its terminal.

- **Discovery.** Claude from each profile's `sessions/*.json` registry and its sibling key
  file; Codex from `thread/list` on a `codex app-server` child cophylad runs per profile, which
  sees a thread from its first turn; Muse from the hooks of cophylad's plugin, since Muse lists a
  session only once it is closed (so one `session/list` shows ends), read on a `muse serve`
  child cophylad runs per profile (`muse/host.ts`, on the binary `muse/locate.ts` finds: the
  profile's command, else the launcher's active `muse-bin-<version>`, else `muse`). Before
  its first prompt a Codex or Muse CLI is known only by its tether terminal: a terminal no
  session holds that retitles itself is looked for a `codex`, `claude` or `muse-bin` below
  its program, in one read of the process table shared by every terminal waiting and spaced
  at least 2 s apart, and its row carries `harness` until a session holds it
  (`sessions/tether/cli.ts`). The profiles are rebuilt when a login file changes, looked at
  every five seconds by `stat` alone: a harness installed or signed in after start gets its
  hooks and its host then, and a new Codex or Muse login restarts that profile's app-server
  or `muse serve`.
- **Ending and resuming.** An ended session is resumed under its id only on evidence that it
  ran again: a pid other than the one it ended with, a complete line in its transcript past
  where it was recorded to, or any hook but `SessionEnd`. A registry entry still naming the
  process it ended in, or a thread list still showing it, leaves it ended, and no status read
  un-ends one. A Claude session known only from its hooks (its profile's registry does not
  list it) has its pid looked up through a command-mode hook's shim ancestors; with none
  known, the registry sweep keeps it for `claude_hook_grace_ms` after its last hook and then
  ends it `inactive`.
- **History once.** A transcript or rollout is parsed whole whenever a tail opens (a daemon
  start, a resume), but only lines past the offset the last tail recorded to become events;
  the offset is kept per session in the store's `transcript_tails`, never on the `Session`.
  A file no tail has recorded gives its last 256 KB. A session that ends gets one more tail
  pass first, so its last lines land before `ended`. A Muse session is read through its view
  instead (`view/page`, folded by `muse/view.ts`), from the cursor kept in the same row, and
  whenever its log is written; one never read gives its last 200 events.
- **Status and asks** come from hooks at `/hooks/claude`, `/hooks/codex` and `/hooks/muse`,
  installed under cophylad's marker beside other tools' hooks; Muse's through a plugin cophylad
  writes per profile, installs and approves (`muse/plugin.ts`), each hook running its own copy
  of the shim, told where `hook.json` is. A Muse hook under a child's id is answered `{}` at
  once, and the view's turns settle a turn cancelled in the TUI, which sends no Stop. A held `PermissionRequest` becomes an `Ask` a
  client answers from anywhere; a terminal answer closes it on the next `PostToolUse` or
  `Stop`. An `AskUserQuestion` is held the same way as one `choice` Ask per question
  (`sessions/questions.ts`), and the answers are released into the tool's input; in a spawned
  session the same questions arrive as an ACP form elicitation. See "Hook ingress" in
  architecture.md.
- **Injection** with receipts: `session.send` returns `queued` (or `held` for a bypass Claude
  session), and delivery is confirmed by the `UserPromptSubmit` hook or the rollout's
  `UserMessage` carrying cophylad's `client_id`. Codex withdraws a message no thread picked up.
  A Claude session in a tether terminal is typed into instead, for the user (below), and a
  Muse session in one is typed into for everyone (`muse/screen.ts` reads its prompt); Muse
  takes nothing else. A Muse session cophylad runs headless is prompted on its host.
- **tether.** `sessions/tether/` runs Claude sessions in tether, the pseudo-terminal host
  under `tether/` at the repository root: `locate.ts` finds the binary (`[tether].command`,
  `COPHYLA_TETHER`, the version folder's `bin/`, a checkout's `tether/target/release` then
  `debug`) and copies it under `data/tether/<version>-<hash>/` before running it; `index.ts`
  adopts the hosts already running, starts one on demand through `@tether-pty/client`, and
  knows every terminal by host, id and pid. A session cophylad starts is spawned there under
  its profile's directory (Claude's own `~/.claude` by leaving `CLAUDE_CONFIG_DIR` unset),
  with the profile's launch and one `--settings <data>/claude/settings-<profile>.json` that
  folds in the launch's own (`claude/start.ts`, `claude/launch-args.ts`), shows in the apps
  with no window of its own (`[tether].window_on_start` opens one at once; `session.focus`
  does when asked), and has its first prompt typed once it registers.
  A client's `session.send` is typed with no prefix, waiting while an ask is open or the
  prompt holds half-typed text (`claude/screen.ts` reads Claude's screen); the brain's sends
  stay on the pipe unless `[sessions].brain_sends = "typed"`. A new session id in the same
  process (`/clear`, the clear-context row) re-keys the record (`Sessions.rekey`), and a
  plan's "Yes, clear context" is pressed by key in the terminal. `entry.ts` writes the
  Windows Terminal profile that starts the user's own `claude` in tether, and
  `<home>/editors/tether.json`, the tether command the VS Code extension's terminal runs.
  `command.ts` gives an installed platform's user a `tether` command: a copy of the staged
  binary in the root's `bin/`, that folder added once to the user's PATH on Windows (the
  registry value keeps its kind; running programs are told) and linked as `~/.local/bin/tether`
  elsewhere, never over another tether. A copy a host still runs is renamed aside, since
  Windows will not overwrite it, and removed at a later start.
  `streams.ts` serves terminals to clients (`terminal.*`): one subscription per terminal,
  output batched per connection, a repaint for a client that fell behind. Without tether,
  sessions start in a terminal window of their own as before. A Muse session cophylad starts
  runs `muse` in tether as the user does, and the adapter claims the session whose
  SessionStart comes from below the terminal's process; with `launch = "acp"` or no tether,
  it runs headless on its host, its approvals and questions as asks.
- **Token counts, `model` and `intent`** come from the transcript (Claude), rollout (Codex)
  or view (Muse); `cost` is priced by `metrics` from the model each delta was counted under, when
  the adapter states none itself.
- **Focus.** `session.focus` on a session in tether raises the window used on it most
  recently, walking up from its `tether attach`, and opens one with `tether open` when none
  is attached. Otherwise it raises the terminal that runs a session by walking the process
  tree up from its pid (`sessions/focus.ts`): PowerShell and `SetForegroundWindow` on
  Windows; `ps` and System Events on macOS, which asks for the Automation permission the
  first time (denied, focus is `unsupported` and the log names System Settings › Privacy &
  Security › Automation; the prompt appears only for cophylad run under the installed app,
  whose bundle declares the usage); `/proc` and `xdotool` (or `wmctrl`) on Linux, over X11
  and XWayland windows, `unsupported` without a display. Under WSL a terminal is not an X
  window, so a session there is `not_found` unless it runs in an `xterm` under WSLg. Codex's
  and Muse's pids are learned from the same walk, wherever raising works or not.
- **Paths and platforms.** One code path on Windows, macOS and Linux: paths compare
  case-folded on the two case-insensitive platforms (`sessions/paths.ts`), the Codex hook
  file carries the sh and the PowerShell command forms, and a macOS Claude login is found in
  the Keychain (`Claude Code-credentials`).

**Codex liveness caveat.** With trusted hooks and the thread's process found, a Codex
thread's state is exact. Without them, a thread that predates the daemon is listed while it
changed within `codex_recent_ms` and its status is inferred from the last
`task_started`/`task_complete`; it goes `ended` after that window with no rollout growth and
no hook. Only lines written since a tail opened count as growth: the history a fresh tail
reads counts by the file's mtime. An ended thread is listed again while it stays recent, and
resumed only when its rollout grew past where it was recorded to; a stale row stops the
paging unless its thread is live. A thread the shared app-server daemon runs
(`--managed-daemon`) has its hooks run below the daemon, whose pid is no session's: its process
is the CLI marked in the one terminal that fits it (its folder, or a title of its folder's
name), and until one fits it is judged by the window too. The README of a shipped build says
so.

`[sessions]` in `config.toml` tunes it: `poll_ms`, `codex_list_ms`, `hook_timeout_s`,
`receipt_timeout_ms`, `codex_recent_ms`, `claude_hook_grace_ms`, `install_hooks`,
`discover`, `launch`, `brain_sends`, and a repeatable `[[profiles]]` block for an
installation beyond the discovered one. `[tether]` names the binary (`command`), tether's state folder (`dir`), a
host's idle exit (`idle_exit_s`, 600), where a window opens (`window`: `auto`, `wt`,
`console`, `conhost` or `none`), whether a session cophylad starts gets one at once
(`window_on_start`, off), whether the entry points are written (`profiles`), and
whether an installed platform keeps the `tether` command on the user's PATH (`on_path`).

**Profiles: the usual account and the launch** (`sessions/profiles.ts`). Each harness's
usual account on the node, the profile a spawn that names none runs under, is the one picked
in the app's settings (kv `profiles.usual`), else `default = true`, else the profile of the
user's own latest session of that harness, else the discovered one. A Claude profile's
launch is what the app set (kv `profiles.launch`), else `[[profiles]].args` — applied to
Claude launches now, with or without `command` — else the allow-listed flags of the user's
own last session under it, read once off its command line when it registers (kv
`profiles.mirror`). So a second account needs `config_dir` and, if it wants them, `args`;
a wrapper script that sets the directory and adds flags hides the account from cophylad and is
not needed. `profile.update` sets both from the app; `profile.limits` reads the plan limits
now (`metrics/limits.ts`, `fresh`). A profile whose Claude global config never went through
the first run (`~/.claude.json`, or `<dir>/.claude.json`) is `unauthenticated`, since Claude
will ask to log in. These kv namespaces are the node's own and never replicated.

## The brain

`[brain]` in `config.toml` turns it on (the default on a primary node) and may name its
`command`; otherwise brain-link looks at `COPHYLA_BRAIN`, then `<home>/data/brain/current/`
(a release the update module installed), then `<install>/brain/` (the brain bundled with an
installed platform), then, in a checkout only, `../../brain/src/main.ts` under Bun. The
lookup runs again before every spawn, after a staged release is promoted. An installed or
bundled brain is verified first: the signed `release.json` beside it must check against a
release key and the binary must hash to what the entry says; one that fails is refused,
removed, and the previous release (or the bundled seed) runs. The brain gets a scrubbed
environment (`COPHYLA_*` passes through) and the brain directory as its cwd. `[providers]`
routes `llm.complete`: `llm` is a route or an ordered list of them, `["server", "byok:gemini"]`
by default, `byok:gemini` with `[providers.gemini] api_key` (or `GEMINI_API_KEY`) and
`[providers.tiers.fast|smart] model, thinking`; `server` is the hosted model behind the
account and never serves the `local` tier. `[cloud]` names that server (`url`, `enabled`,
`refresh_interval_ms`, `reconnect_ms` and `reconnect_max_ms`, `request_timeout_ms`,
`hello_timeout_ms` — how long a signed-in node waits for the link before it claims the
primary role on its own — and `allow_insecure` for an `http:` server while testing).
`[push] enabled` turns the push for asks off without signing out. `[acp]` names the
runtime and, per harness, a command to run instead of the package. `[tools]` caps what the
built-in tools read and fetch. `[store]` runs the recall index: `embedding = "local" | "off"`,
`embedding_model` (a directory with `manifest.json`, `model.onnx` and the tokenizer files;
the platform's own under `apps/cophylad/models/` when absent, fetched once by
`scripts/fetch-models.ts` with pinned hashes), `embed_batch`, `embed_max_chars`,
`vector_max_rows` (vectors kept in memory, newest first) and `backfill_batch`. Every brain
request is a gate action under the `brain`
principal, so `[gate.rules] "brain:session.spawn" = "ask"` puts an agent start in front of
the user.

## Updates

`[update]` names the feed (`feed`, a URL whose only request is `<feed>/<channel>/<os>-<arch>.json`:
no query, no header of ours), the `channel`, `check_interval_ms` and `first_check_delay_ms`,
`auto_apply` and `allow_insecure_feed` (`http:` off loopback, for a LAN feed while testing;
logged loudly). Every entry is checked against `RELEASE_KEYS` (Ed25519 over the entry
without `url` and `signature`), its OS, architecture and channel, and its protocol range;
drops are logged with their reason. The newest platform and brain above what runs are
downloaded (size and hash checked, `data/downloads/`) and staged: the platform into
`<install>/versions/<v>/` with its `release.json`, then the `staged` pointer; the brain
into `data/brain/staged/<v>/`. A staged brain is applied by restarting brain-link (promoted
to `data/brain/current`, the old one to `previous`) when the daemon is idle; a staged
platform by stopping the daemon when idle and, on the automatic path, no desktop app is
attached (the tray offers the restart otherwise); the launcher rotates the pointers at the
next start. Idle means no open ask, no held hook response, no agent prompt in flight or
queued, the brain not starting and no brain request in flight, no download running.
`update.apply` needs only idle and answers `conflict` with the reasons otherwise. On
`channel = "beta"` the feed is the account's server, `<cloud url>/releases`, read with the
account token as a bearer that goes to that origin alone; signed out, or on a plan without
the channel, the daemon warns and reads the stable feed. A daemon
whose `current` pointer names another version is stale and stops the same way. The
platform is only updated when the daemon runs from an install (`COPHYLA_INSTALL_DIR` and
`COPHYLA_PLATFORM_DIR` from the shell, else its own place under `versions/<v>/`); a checkout
updates with git. Versions the launcher marked `.broken` are remembered in the store and
never staged again.

## Voice and the controller

`[controller]` opens a second listener on the LAN over TLS, and `[voice]` turns the pipeline
on; both are off by default, so a fresh node neither opens a port nor fetches a model. The
certificate is the node's own, written to `data/tls` with every LAN address in its SAN and
re-made when those change. A phone cannot read the shared token, so it pairs: `pair.start`
on the desktop opens one six-digit code for five minutes and one use, `pair.claim` before
`hello` spends it for a token of that controller's own, and `controller.revoke` (or
`grant.revoke`) drops the row and closes the socket. Or the desktop makes it an invite
(`grant.invite {kind: controller}`, Invite a phone in the default view, `cophylad invite
--phone`) with the access the phone gets, no wider than the minter's own, and the phone
redeems it with `invite.redeem` before `hello`, on this listener pinned to its key or through
the invite's own relay peer (`grants/phones.ts`). A phone is held to its grant's access: its
scopes, and the nodes, workspaces or paths it is kept to. The shared token is refused off
loopback; a controller token works on either listener. `view.stage` hands a controller an unguessable base URL its sandboxed frame
loads a view from, with the same content-security policy the desktop shell applies.

A signed-in node on a plan with the relay also hands the phone relay access at `pair.claim`
or `invite.redeem` (`relay.info` later, on the LAN): a token the server holds hashed and the
grant's key, which only the phone and this node share. A phone off the LAN then opens a tunnel through the server
(`cloud/tunnels.ts` is this end of it) that `api` serves like a socket on the LAN listener,
`hello` by the controller token, with `pair.claim`, `view.stage`, `remote.open` and
`relay.info` refused on it; a native phone app stages views itself from `view.get`. The
server forwards records by peer and cannot open one. `controller.revoke` also revokes the
relay token and the push device. A phone that registered a device (`push.register`) is sent
an ask as a push when it has no connection here (`push/`), and the notification's buttons
answer it.

The stages load in the background at start, so a daemon with voice on is up as fast as one
without; each reports itself in the node's capabilities as it comes up. The wake word's and
the VAD's models are fetched from the feed the first time; they run on onnxruntime-node,
which the platform ships. A local speech or transcription engine is not Cophyla's to ship:
it runs on sherpa-onnx, whose native library carries espeak-ng (GPL-3.0), with a model under
its own licence, so its stage stays `uninstalled` until the user asks for it in Settings,
which shows those licences first; `voice.install` then fetches the runtime from the npm
registry and the model from its makers, each held to the hash `voice/catalog.ts` pins,
into `data/voice/`, told as `voice.setup`, and the stage loads. With `models_dir` set (a
checkout developing against local folders) the checkout's own sherpa-onnx and those folders
stand in. `stt = "server"` and `tts = "server"` put those two
stages on the account's server over the server link, with no model to fetch: the utterance
goes whole when the VAD closes it and speech comes back in 24 kHz chunks; the wake word and
the VAD stay local. `onnxruntime-node` is imported before
`sherpa-onnx-node` (`voice/runtime.ts`): both load a native ONNX Runtime and the first one in
wins, and sherpa ships the older. Each engine runs on two threads with spinning off, and on a
hybrid CPU the threads are pinned to the performance cores. Audio arrives as base64 int16
inside `voice.audio` and belongs to one controller at a time: speech goes back to that phone
alone, while `voice.state` — which names the controller — reaches every client.

Replies are read out by Piper unless `tts` names another: Piper, a VITS voice, starts about a
tenth of a second after the reply on two threads; Kokoro sounds more natural and runs at about
half real time; Supertonic speaks 31 languages at about a tenth; all three through sherpa-onnx,
their speech resampled to 24 kHz so Opus carries it. Each makes a piece of text whole before
any of it plays, so a reply is cut first (`voice/pieces.ts`): the first sentence alone, or the
first clause of a long one, then pieces that grow with the speech already queued, so a long
sentence after a short one does not leave a silence mid-reply. The app's Settings picks the
engine and its voice (`voice.settings`, `voice.configure`, both with the `voice` scope), kept
in the store over config.toml as this node's own (the `voice` kv namespace, never
replicated), `null` handing either back; a new engine loads behind the answer while the one
before it goes on speaking, a new voice needs no load, and `voice.preview` speaks a line to
the client that asked. The transcription engine is picked the same way (`stt`), and a
hosted one needs nothing installed.

The wake word listens for several phrases at once, one keyword head each: `wake_model` names
them (by default "Cophyla" and "Hey Phyla"), each at its own threshold and input
scale from the model's manifest (`head_params`) unless `wake_threshold` or `wake_scale` says
otherwise, and a head the model folder lacks is skipped with a warning. It is heard on the
client — the phone or the desktop app — when the client carries every one of them. A client
names the heads it carries with `voice.wakeword`; when they cover the node's the answer is
`phone` with `heads`, each with its threshold, scale and phrase (and the first again as
`head`, `threshold` and `scale` for an older app), the node runs no wake word over that
client's frames, and the client sends `voice.wake` and then the audio once it heard a word.
The answer waits up to ten seconds for a wake stage still loading. Otherwise the answer is
`node` and the client streams while it listens, as does a controller that never asks; `off`
means voice or the wake word is off here. A word fires a moment after it ends, often inside the
next word, so the recogniser also hears the 160 ms before it fired: the node keeps them for a
client it listens for, and a client sends them after `voice.wake` and counts them in its
`lead`; the VAD does not hear them, so a false accept is still abandoned untranscribed. Each
utterance's recogniser hears 200 ms of silence first: Nemotron, started on audio that begins
mid-word, can give nothing back for the whole utterance. An empty list,
a disconnect or a stop hands the word back. The engines are looked up per utterance, so a
controller that streamed before a stage came up is heard once it does. An utterance the
wake word began — on the phone or here — is abandoned without transcribing when the VAD
hears no speech in its first five seconds of audio, or when four seconds pass without a
frame; the recogniser is dropped, not drained, so a hosted one is never sent silence, and a
held button is never abandoned.

## Remote desktop

`[remote] enabled = true` shares this node's desktop; viewing another node's needs no flag,
since every `remote.open` is gated. With it on, the module finds the host (Apollo, else
Sunshine, or `[remote] host_command`), installs it with winget, brew or flatpak when it is
missing and `[remote] install` is on (the Windows installer elevates, so the user answers
UAC), starts the Windows service if it is stopped, sets the host's credentials through its
welcome endpoint into `data/remote/host.json` unless `host_user` and `host_password` are
set, writes the node's name into its config, and polls `/api/clients/list` every `poll_ms`
for the viewers and whether one streams. Each step is `remote.state.host`; the node's
`capabilities.remote` is true while the host is `ready`.

`remote.open` is answered by the node the client's socket is on. For the desktop app on
this machine (a loopback `ui` client, named by this node) it runs moonlight-qt: `list` to
see whether it is paired, else `pair --pin` with a random PIN that `remote.pair` has the
host's node accept, then `stream <host> Desktop` in a window. For a controller on the LAN
listener it fetches moonlight-web v2.10.0 into `data/sidecars/moonlight-web/` the first
time, starts it on a loopback port under `/remote`, adds and pairs the host through its REST
API (`hosts.json` beside it keeps the ids), and answers a one-use URL
`/remote/?t=<ticket>`; the ticket becomes an `cophyla_remote` cookie, and every request and the
stream's WebSocket under `/remote/` is proxied to the sidecar with the user in
`x-cophyla-user`. `[remote] web_transport` seeds the page's transport, WebSocket by default.
`remote.pair` is gated on the host's node with the host's own ask and the viewer's name as
target (a secondary's viewer goes up the node link as `remote.pair`), `remote.invite` mints
Apollo's code and `art://` link, and `remote.revoke` ends a web session or unpairs a client.
`remote.screenshot` needs no host: PowerShell's `System.Drawing` to a temp JPEG on Windows,
`screencapture` and `sips` on macOS, `grim` or ImageMagick's `import` on Linux, scaled to
`screenshot_width`. Pins, codes, passphrases, the link's query and the stream URL's ticket are
redacted in audit rows, and any `base64` field is kept as its size, so no frame is stored there.

## Views

`views/default/` is the default view, served as it is on disk: `view.json` names the entry
and the scopes the view needs, `index.html` loads `view.css` and `view.ts`, and the `.ts`
files import each other by their own names. The daemon strips the types when it serves them,
so nothing here is built. `model.ts` is the pure reducer over what the host sends
(`test/view-default-model.test.ts`), `render.ts` the keyed DOM renderer, `markdown.ts` the
elements of what a model wrote, built from marked's tokens, `rpc.ts` the postMessage line to
the host, `terminal.ts` a terminal's screen, and `view.ts` the loop. `vendor/` holds the
libraries it loads, xterm.js (with its fit, unicode11 and web-links addons), marked and uqr,
copied and pinned by `scripts/vendor-view.ts`. A view's `id` is its directory name.
Every view offers Change view, a control that asks the host `host.chooseView` for its view
picker (`test/views.test.ts` holds the built-in ones to it); the default's is in the ⋮ beside
the chat's tab.
`views/tsconfig.json` typechecks them with the DOM library.

## The gate

Every request calls `gate.run(request, handler)`. The policy decides `allow`, `deny` or
`ask` from, in order: a control action; an answer remembered for this session; an answer
remembered always (the `policy` table); a `[gate.rules]` entry; a built-in rule
(`BUILTIN_RULES` in `gate/policy.ts`: the brain's `ui.say`, `ui.ask`, `llm.complete`,
`thread.start`, `task.*`, `annotate`, `store.*`, `memory.write` and `prompt.write` are
allowed, so it can converse without a prompt per reply); the `[gate.policy.<kind>]`
default for the principal kind and the action's risk class. `ask` opens an `Ask`, streams it
as `ask.state`, and holds the request until `ask.answer` arrives; `remember` on the answer
writes it into policy. The audit row is inserted with the decision and completed with the
outcome, the result whole up to `audit_result_cap` bytes and as hash and size beyond it, and
streamed to clients as `audit.entry` both times, unless it is a read's or the brain's own
bookkeeping, what a built-in rule allowed it (`toldToClients` in `gate/audit.ts`).
Credential-shaped keys in `args` and the result are redacted before they are written, and a
`base64` field is kept as its size.

## Nodes

A secondary is this daemon that joined the primary's cluster with an invite: `cophylad invite`
on the primary (or Add a machine in the default view) prints it, `cophylad join` on the new
machine redeems it, over the primary's LAN listener or through the server relay as the
invite's own throwaway peer, and `data/link.json` keeps the grant and its key from then on.
A node in no cluster runs alone: `[node] role = "primary"` starts a cluster of its own, a
secondary waits for an invite. It finds the primary by a UDP query on `[nodes] discovery_port`
(4819), believed only once a probe of the endpoint answers sealed with its grant, or is told
with `[nodes] primary = "host:port"`, and links to `/ws/node` on the primary's LAN listener,
which is up when `[controller]` is on, `[nodes] accept = true`, or the node is a backup.
Every link is a `SealedSocket` keyed from the node's own grant (`nodes/sealed-link.ts`): two
frames in the clear name the grant and trade ephemeral keys, and every record after is
sealed, so TLS is only the transport. A node joined as hands (`cophylad invite --role hands`,
the default) is driven and drives nothing: never a backup, its clients never relayed, no
custom events, no viewer pairing, and it hears of no node but the primary and the backups.
One joined with `--workspace` folders keeps what the primary sees and does here to them
(`nodes/confine.ts`), which is not a sandbox. A grant revoked or run out closes its link with
a sealed `node.leave {reason: revoked}`, and the node forgets the cluster. After the join the
secondary streams its sessions, asks,
workspaces, audit rows and samples up and serves the requests the primary forwards, each
gated here as principal `node` under `[gate.policy.node]`; its own clients are relayed to
the primary while the link holds and served locally when it drops. A backup (`[node] backup
= true`) also takes a replica of the primary-only tables and the editable files, applied at
the store with the scheduler and the hooks inactive, and promotes itself after
`[nodes] failover_ms × backup_rank` without a heartbeat; `node.promote` from a client hands
the role over on purpose. Every transition of the role machine is a `node.state`.

Across networks the link goes through the server relay (`[nodes] relay = true`, the last
candidate): the secondary is a relay peer of its own grant, with the relay token its
enrollment gave it and no account of its own, the server routes it to the primary its
registry names, the same handshake runs inside the tunnel, and the join says `via: relay`. The server's registry then arbitrates the role: a signed-in node waits
for its link before it claims, takes the primary role only with a grant, registers at every
link-up, renews its lease every `[nodes] registry_heartbeat_ms` while primary, and steps
down when the server names another holder; a backup that lost its primary through the relay
waits for a grant rather than promote on the timer, since a lost tunnel says nothing about
which side is alive. Signed out, or on the free plan, the one-network rules above hold
unchanged.

## Tests

`bun test apps/cophylad` runs the hermetic suite. `test/foundation.test.ts` is milestone 0's
"done when" over a real socket; `test/attach.test.ts` is milestone 1's, over the socket with a
fake Claude registry and hook posts, no harness; `test/brain.test.ts` is milestone 3's, over
the socket with a scripted fake brain (`test/fakes/brain.ts`), a fake ACP agent
(`test/fakes/acp-agent.ts`) and a fake Gemini (`test/fakes/gemini.ts`), the real brain being
private and tested in its own repository; `test/brain-link.test.ts`,
`test/sessions-acp.test.ts`, `test/chat.test.ts`, `test/tasks.test.ts`, `test/tools.test.ts`,
`test/editable.test.ts`, `test/llm.test.ts`, `test/rpc-stdio.test.ts` and
`test/rpc-peer.test.ts` test those modules in pieces, and `test/llm-gemini.live.test.ts` runs
the real API when `GEMINI_API_KEY` is set; the `test/metrics-*.test.ts` files test the
metrics module on the fake engine, the Linux engine on `test/fixtures/proc/`, the Windows
engine on this machine when it is one, and the whole over the socket with the fake brain;
the `test/nodes-*.test.ts` files start two or three daemons in one process, invited and
joined over the loopback LAN listener with `test/nodes-helpers.ts`, for the link, forwarding,
forged rows and beacons (`test/nodes-hardening.test.ts`), the relay,
discovery on an in-memory LAN, replication, failover and metrics across the link, and, in
`test/nodes-relay-server.test.ts` and `test/nodes-registry.test.ts`, linked through the fake
server's relay with its registry arbitrating the role; the `test/grants-*.test.ts` files test
the store, enrollment and its refusals, the sealed link against injected and replayed records,
hands containment, the ends of grants and re-keying, confinement, and phone invites, and
`test/access-limited.test.ts` a phone its grant limits;
the `test/remote-*.test.ts` files and `test/remote.test.ts` test the remote desktop against
a fake Apollo over TLS (`test/fakes/apollo.ts`), a fake moonlight-web
(`test/fakes/moonlight-web.ts`) and a recorded exec in place of winget and moonlight
(`test/fakes/remote.ts`): the host API, the daemon with the host coming up, pairing and
opening through the gate, the proxy's ticket, cookie and WebSocket bridge, and the parts
alone, and `test/nodes-remote.test.ts` opens one node's desktop from another;
`test/views.test.ts` serves a fake view
directory through the module and the socket and checks the real `views/` for consistency;
the `test/cloud*.test.ts` files test the account against a fake server (`test/fakes/server.ts`:
the device flow over HTTP, the link with its own entitlement key, scripted hosted calls, the
beta feed behind the bearer, the relay routed by peer between its sockets, the registry's
lease, the pushes it was sent): login and logout through the socket, the route walk, forged
and expired tokens, hosted speech with the fake engines around it, the beta feed, the audit
without tokens, the exact set of methods the server ever sees, and reconnects;
`test/cloud-relay.test.ts` pairs a fake phone (`@cophyla/relay` against the fake server) and
says hello through the tunnel, `test/api-tunnel.test.ts` serves a tunnel with no cloud at
all, and `test/push.test.ts` opens asks with and without a phone connected. `test/sessions-claude.test.ts` and
`test/sessions-codex.test.ts` test each adapter in pieces, the Codex one against a fake
app-server (`test/fakes/codex-app-server.ts`); `test/sessions-muse.test.ts` tests Muse's
against a fake `muse serve` and `muse plugins` (`test/fakes/muse-serve.ts`), in tether and
headless. `test/codex-hooks-trust.test.ts` runs the trust
step against the real Codex binary in a throwaway `CODEX_HOME`, and skips when the binary is
absent; it touches nothing under the real `~/.codex`.

The harness integration tests drive real terminals in a pty (ConPTY on Windows) and are
skipped unless `COPHYLA_HARNESS_TESTS=1`:

```
COPHYLA_HARNESS_TESTS=1 bun test apps/cophylad/test/harness
```

They need `@lydell/node-pty` (a cophylad devDependency) hosted under Node
(`test/harness/pty-broker.mjs`; under Bun the typed input is lost on Windows and the child
is hung up on Linux, so `pty.ts` starts a Node broker whenever Node is on PATH,
`COPHYLA_PTY_HOST` forcing either host), a Claude and a Codex login (`CLAUDE_BIN`/`CODEX_BIN`
override the Windows install paths; elsewhere PATH), and, for `profiles.test.ts`, a second
Claude install under `~/.claude-accounts/extra`. Each runs the daemon in a temp home and
loads cophylad's hooks from a temp settings file or a temp `CODEX_HOME`, so nothing under the
real `~/.claude` or `~/.codex` is written. `test/harness/pty.test.ts` checks the driver
itself against a shell and runs with the suite.

Against this machine, `bun run cophylad --home <scratch>` with `install_hooks = false` lists the
live sessions without changing any harness config; `bun run apps/cophylad/scripts/peek.ts --home
<scratch>` prints `profile.list`, `session.list` and `workspace.list` from a running daemon, and
`bun run apps/cophylad/scripts/talk.ts --home <scratch>` is a chat client on stdin for the brain:
messages go out as `chat.send` (`/quick …` in quick mode), replies stream in, prompts print
with their options and are answered with `/answer <ask> <option>`, and tasks and sessions
print as they change.
