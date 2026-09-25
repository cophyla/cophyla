#!/usr/bin/env bash
# The macOS half of spike 09: gathers what the Windows build machine could not see. Run on
# the Mac from the repository root, after `bun install`, with a `claude` session open in a
# Terminal window and, for U5, a `codex` session open in another; paste the output back.
#   bash spikes/09-unix/mac-probes.sh
# Reads only; writes nothing under ~/.claude or ~/.codex. Secrets (peer tokens, credentials)
# are typed, never printed.
set -uo pipefail
say() { printf '\n=== %s\n' "$*"; }

say "host"
uname -m; sw_vers 2>/dev/null | tr '\n' ' '; echo
echo "bun $(bun --version 2>/dev/null)  node $(node --version 2>/dev/null)  claude $(claude --version 2>/dev/null | head -1)  codex $(codex --version 2>/dev/null | head -1)"

say "U1 node-pty under bun and node"
cat > /tmp/cophyla-pty-probe.mjs <<'EOF'
const pty = await import("@lydell/node-pty");
const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`;
let out = ""; let exited = null;
const p = pty.spawn("bash", ["-c", "echo ready; read x; echo got:$x"], { name: "xterm", cols: 80, rows: 20, cwd: process.cwd(), env: process.env });
p.onData((d) => (out += d)); p.onExit((e) => (exited = e));
await new Promise((r) => setTimeout(r, 500)); p.write("abc\r");
await new Promise((r) => setTimeout(r, 1500));
console.log(`${runtime}: out=${JSON.stringify(out)} exited=${JSON.stringify(exited)} ${/got:abc/.test(out) ? "PTY_OK" : "PTY_FAIL"}`);
process.exit(0);
EOF
cp /tmp/cophyla-pty-probe.mjs apps/cophylad/cophyla-pty-probe.tmp.mjs
(cd apps/cophylad && bun ./cophyla-pty-probe.tmp.mjs; node ./cophyla-pty-probe.tmp.mjs; rm -f ./cophyla-pty-probe.tmp.mjs)

say "U2 the Claude registry shape (types only, no values)"
for f in ~/.claude/sessions/*.json; do
  [ -e "$f" ] || { echo "no ~/.claude/sessions/*.json: open a claude session first"; break; }
  echo "$f"; jq 'map_values(type)' "$f"
  echo "messagingSocketPath shape:"; jq -r '.messagingSocketPath' "$f" | sed -E 's/[0-9a-f]{16,}/<hex>/g'
  echo "procStart value shape:"; jq -r '.procStart // .startTime // "absent"' "$f" | sed -E 's/[0-9]/9/g'
done
for k in ~/.claude/sessions/*.key; do
  [ -e "$k" ] || break
  echo "$k"; jq 'map_values(type)' "$k"; ls -l "$k" | awk '{print "mode", $1}'
done

say "U3 the Keychain"
security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; echo "find-generic-password -s 'Claude Code-credentials': exit $?"
security dump-keychain 2>/dev/null | grep -i '"svce"' | grep -i claude | sort | uniq -c
echo "second login under ~/.claude-accounts/extra (if any):"
ls ~/.claude-accounts/extra/.credentials.json 2>/dev/null || echo "no .credentials.json there (expected on macOS)"

say "U4 codex hooks/list form (the trust test against the real binary)"
COPHYLA_PTY_HOST=node bun test apps/cophylad/test/codex-hooks-trust.test.ts 2>&1 | tail -6

say "U5 codex processes and the shared daemon"
ps -axo pid=,ppid=,comm= | grep -i codex | grep -v grep
echo "app-server-control:"; ls -la ~/.codex/app-server-control/ 2>/dev/null || echo "(none)"

say "focus: GUI processes System Events lists (asks for Automation once)"
osascript -e 'tell application "System Events" to get unix id of every process whose background only is false' 2>&1 | head -c 300; echo

say "done"
