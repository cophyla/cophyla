// `~/.cophyla/README.md`: the contract for whoever writes a tool, a hook or a view into the
// editable layer, the agents the brain starts first of all. Written once, like
// `config.toml`, and never rewritten: the user may edit it.

import { writeFileSync } from "node:fs";

export const README_MD = `# ~/.cophyla

This directory is Cophyla's editable layer: what you put here is loaded by
the running daemon, with no build step and no restart. The daemon watches it; a file that
appears, changes or goes is picked up within a second, and the brain is told. Nothing here
is gated when it is written; every run of a tool and every hook is gated and audited when it
runs. Tools and hooks run inside the daemon, with its rights.

Modules are TypeScript with erasable syntax only (no enums, no namespaces, no parameter
properties): the daemon strips the types and runs the file as is. There is no \`node_modules\`
here: import from the runtime (\`node:fs\`, \`node:path\`, \`node:child_process\`) and from
your own helpers by relative path. A helper file whose name starts with \`_\` is not loaded as
a tool or a hook; note that a helper is cached at first import and changes to it are seen
after the daemon restarts, while the tool or hook file itself is reloaded on every edit.

## tools/<name>.ts

One tool per file, exported as named exports or as \`default\`:

\`\`\`ts
export const name = "my.word_count";           // namespaced: <namespace>.<name>, lower case
export const description = "Counts the words in a text.";
export const risk = "read";                     // read | write | exec | network
export const schema = {                         // JSON Schema for the arguments
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};
export function run(args: { text: string }, ctx: { log: { info(msg: string): void }; home: string; signal?: AbortSignal }) {
  return { words: args.text.trim().split(/\\s+/).filter(Boolean).length };
}
\`\`\`

\`run\` may be async and returns any JSON value. The \`risk\` you declare is the least the
gate applies: a tool from this directory runs code inside the daemon, so \`read\` and
\`write\` are treated as \`exec\` (the policy for \`exec\` decides whether it runs, and a rule
\`"brain:tool.run@my.word_count" = "allow"\` in config.toml lets it run without asking);
\`network\` stays \`network\`. The brain sees the tool as \`my.word_count\` in \`tool.list\`
as soon as the file loads, and is told what is wrong with a file that does not.

## hooks/<name>.ts

A hook reacts to events and raises its own:

\`\`\`ts
import { watch } from "node:fs";

export const name = "inbox";                    // defaults to the file name
export const events = [                         // what this hook raises; listed in event.list
  { name: "inbox.file", description: "a file appeared in the inbox", payload: { type: "object", properties: { path: { type: "string" } } } },
];
export const on = {
  start(ctx) {                                  // runs when the hook loads; may return a disposer
    const w = watch("/path/to/inbox", (_kind, file) => ctx.emit("inbox.file", { path: file }));
    return () => w.close();
  },
  "session.ended"(payload, ctx) {               // any event name: built in (event.list) or custom
    ctx.log.info("a session ended");
  },
};
\`\`\`

\`ctx\` carries \`emit(name, payload)\`, \`log\`, \`home\` (this directory) and \`node\`. An
emitted event reaches the brain as \`event.custom\`, the other hooks, the tasks whose trigger
names it, and \`event.history\`. Event names are namespaced like tool names, and a hook may
not claim a built-in name or another hook's. A hook never hears its own emits; a chain of
hooks answering each other stops after a few steps, and a hook emitting in a burst is
throttled. A handler that throws is logged and the hook keeps running.

## views/<id>/

A directory with a \`view.json\` (\`{ "id": "<id>", "name": "...", "entry": "index.html",
"scopes": [...] }\`; the id must be the directory's name) and the files it names. The app
loads the default view; \`.ts\` files are served as JavaScript, so a view imports its own
modules by relative path with no build. A view runs in a sandboxed frame with no network and
speaks the client protocol through the host, within the scopes it declares. An edit reloads
the view in the app; a view named like a built-in one is skipped.

Every view must offer Change view, somewhere the user can always reach: a control that sends
the host the request \`host.chooseView\` (no scope needed; posted to the parent window as
\`{ cophyla: "cophyla.view/1", frame: { jsonrpc: "2.0", id, method: "host.chooseView" } }\`),
which lays the host's own view picker over the view. The frame is all the user sees, so a
view without it leaves them no way to another. For the same reason every view must offer
Settings beside it: a control that sends \`host.settings\` the same way, which lays the host's
own settings over the view (which account agents start under, and with what).

The frame has no storage of its own. To remember how the user left it on this device, a
view sends \`host.savePrefs\` with \`{ prefs }\` (a plain object, 8 KB at most as JSON; no
scope needed), and gets it back as \`prefs\` in \`host.ready\`.

## prompts/ and memory/

Markdown files with front matter, written by the brain through \`prompt.*\` and \`memory.*\`
and by you by hand; \`memory/\` is indexed for recall on every change.
`;

/** Writes the README when there is none; an existing one, edited or not, is left alone. */
export function ensureReadme(path: string): boolean {
  try {
    writeFileSync(path, README_MD, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") return false;
    throw e;
  }
}
