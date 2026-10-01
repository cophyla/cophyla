# @cophyla/protocol

The entities and the five protocols, defined once as Zod schemas and shared by every
process. They are the public contract; the design notes behind them are kept private. Nothing here does I/O.

| File | Holds |
|---|---|
| `src/ids.ts` | prefixed ULIDs, `newId`, one id schema per entity, `Timestamp` |
| `src/rpc.ts` | the JSON-RPC 2.0 envelope, the `Error` codes and their numeric forms, `RpcError` |
| `src/entities.ts` | every entity, and `entities` keyed by the name entities.md uses |
| `src/capability.ts` | `hello`, the events into the brain, the requests out of it with their results, the notices |
| `src/client.ts` | the client protocol: requests with results, signals, notifications |
| `src/hooks.ts` | what Claude Code, Codex and Muse post to `/hooks/*` and what cophylad answers (all Claude-shaped) |
| `src/server-link.ts` | the multiplexed frames on the daemon's link to the server: the requests it makes (`serverLinkRequests`), the one the server makes of it (`serverLinkInbound`: `relay.open`), and the notifications either way |
| `src/node-link.ts` | the messages of the link between nodes: the handshake, the client relay, the registry, replication |
| `src/relay.ts` | a phone's socket to the server's relay, `/ws/relay`: `relay.auth`, `relay.open`, the record frames, the close codes |
| `src/release.ts` | the release feed as bytes: what a signature covers, where a channel's feed lives, what an artifact is called |
| `src/actions.ts` | every request name with its risk class: the gate's vocabulary |
| `src/scopes.ts` | the scope each client request, notification and signal needs |
| `src/quotes.ts` | the quote projection: `quotable` numbers a result the way the model sees it, `selectLines` picks a cited range and narrows its `Source` |
| `fixtures/*.json` | at least one valid example per schema, and a list of invalid ones |
| `scripts/emit-json-schema.ts` | writes JSON Schema for every entry under `schema/` (`bun run schema`) |

## Rules

- **Additive only.** A schema gains fields; it never loses or renames one. Objects strip
  unknown fields on parse rather than rejecting them, and the fixture test checks that every
  example is still accepted with a field the schema does not know.
- **Every schema has a fixture.** `bun test` fails when a schema has no example, when a
  fixture names no schema, or when an example does not parse.
- **Every request has an action.** `actions.ts` is checked at compile time against both
  request tables, so a request without a risk class does not build.

## What this package settles that the design left open

- **Both wire protocols are JSON-RPC 2.0**, one message per WebSocket frame, no batches.
  The capability protocol was JSON-RPC by design; the client protocol uses the same envelope
  so the relay, the views and the tests share one parser.
- **Client signals.** `chat.typing` and `voice.audio` are notifications with no response.
  They are streams, not requests, so they are not audited one by one.
- **`AuditEntry.outcome` is absent while the request is in flight.** The entry is written when
  the decision is made and completed when the result is known, so a request that outlives the
  daemon still has a row.
- **Control actions.** `hello`, `ask.answer` and `cancel` are allowed for any principal that
  is entitled to them and never answered with `ask`, since an ask to answer an ask would loop.
  They are audited like everything else.
- **`llm.complete` streams** as `llm.delta` notices carrying the request id, with the whole
  completion as the request's result.
- **Codex hook payloads** were read off the wire in milestone 1 and corrected: the events a
  hook posts are Claude-shaped, with PascalCase `hook_event_name` values (the camelCase names
  are what `hooks/list` reports as metadata, kept in the enum for that), `session_id` is the
  thread id, `transcript_path` is nullable, and `CodexHookResponse` is Claude's shape,
  `{continue?, hookSpecificOutput?: {hookEventName, decision?: {behavior, message?},
  additionalContext?}}`.
- **Muse hook payloads** were read off the wire in milestone 18: Claude-shaped too, from a
  plugin's command hook, `transcript_path` always null, `turn_id` beside `session_id`, and a
  reminder's or a subagent's hooks under the child's own id. `MuseHookResponse` is
  `{hookSpecificOutput?: {hookEventName, decision?: {behavior, message?}}}`. `HarnessKind`
  gains `muse` and `SessionTransport` gains `msp`, the `muse serve` protocol cophylad reads a
  Muse session through; both additive.
- **`profile.list {node?}` → `{profiles}`** is on both protocols: it names the harness
  installations a session can be started under. `session.send` gains an optional `ref` on its
  result, and `session.spawn` an optional `profile`, both additive.
- **`profile.limits {node?}` → `{limits}`** is on both protocols and **`profile.update {node,
  id, patch: {usual?, launch?}}` → `{profile}`** on the client's: a profile's plan limits read
  now, and the usual account and the launch set from the app (`null` hands either back).
  `HarnessProfile` gains `defaultBy`, `automatic` and `launch`, all optional and additive.
- **Handing a session its work.** `session.send` gains `task`, `clear` and `mode`, and
  `session.spawn` a `mode`. A message's mode is `WorkMode`, `default` or `plan` alone, so a
  message never loosens one (a looser mode is `session.mode`'s, asked on its own). A start's is
  any `LaunchMode`, `bypassPermissions` too: one looser than `default` is asked about whatever
  built-in rule lets the brain start sessions, and the hello names it `spawn.mode`. `task.ready` gains
  `cleared`, the blocker that cleared; the task filter `parent`; `session.git {id, log?}` is a
  capability request too, and `log` (up to 20) adds `GitCommit`s on both protocols. The
  brain's `hello` gains `features`, naming what the platform does, since an older one ignores
  what it does not know. All additive.
- **`Session.profile` is required.** This is the one non-additive change the package has made:
  a `Session` now names the `HarnessProfile` it was found under. It is allowed because only
  cophylad produces `Session` values and nothing has shipped; every other schema change stays
  additive.
- **Quotes cite numbers both sides compute the same way.** `quotable(action, params,
  result, node)` projects a `tool.run` of `fs.read`/`fs.grep`, a `session.history`, a
  `thread.history`, a `memory.read`, a `prompt.read` or a `recall` into `{n, text}` entries
  (a file line, an event `seq`, a message index, a body line, a hit's position from 1) and a
  `Source`; the brain renders results through it and brain-link expands citations through
  it, so the lines the model cites are the lines that are quoted. A `recall` result has no
  source of its own: each line carries its hit's, so a one-line quote lands on that hit's
  seq, message or memory lines and a wider one is text only. A quote that does not resolve
  carries `unresolved: true`.
- **Provider signatures.** `LlmContent` text and `tool_use` blocks carry an optional opaque
  `signature` (Gemini's thought signature) that the brain echoes back unchanged. The `pending`
  notice carries `at`, so a held request still advances the brain's clock.
