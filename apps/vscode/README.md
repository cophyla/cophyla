# tether for VS Code

Adds **tether** to the terminal panel's profile menu: this window's own shell, started in
tether (`tether run -- <shell>`), so a program you run there, a `claude` say, is one Cophyla can
type into as you (see `tether/README.md`). The tether it runs is the one cophylad runs, which cophylad
names in `<home>/editors/tether.json` with its state folder, so the terminal lands on the host
cophylad watches; with no such file it is the `tether` on PATH, and with neither the profile says
so and opens nothing. Closing the tab ends the shell and whatever runs in it, as closing any
terminal would; Ctrl-] detaches instead and leaves it running in tether (`tether ls`,
`tether attach`).

It also puts the terminal of a session Cophyla starts in this window's panel, beside your own.

## Why an extension at all

`window.createTerminal` is the only way into the terminal panel, and only an extension can
call it. VS Code's command line opens files and manages extensions; it has no terminal in it,
and the channel the `code` CLI uses to reach a running window carries no command of any kind.

So the window announces itself rather than being reached into. On startup the extension
listens on a loopback port, writes `<home>/editors/<pid>.json` naming that port, a token and
the folders the window has open, and removes the file when the window closes. cophylad reads
that directory and posts a session's command to the window whose folders hold the session's
working directory. A request without the token is refused, and the listener is bound to
127.0.0.1, so nothing off this machine can reach it.

With no window listening, cophylad opens a terminal of the platform's own instead — the feature
works without this extension, it just lands outside the editor.

## Build and install

```sh
bun install
bun run build     # dist/extension.js
bun run package   # dist/tether.vsix, needs vsce
code --install-extension dist/tether.vsix
```

`apps/vscode` is not a workspace of the root `package.json`: its `@types/node` would displace
the one the daemon's own typecheck resolves. It installs on its own, as `apps/server` does.

## Settings

| Setting | Meaning |
| --- | --- |
| `cophyla.home` | The Cophyla home this window announces itself in and reads `tether.json` from. Empty follows `COPHYLA_HOME`, then `~/.cophyla`. |

Its log is in the tether output channel.
