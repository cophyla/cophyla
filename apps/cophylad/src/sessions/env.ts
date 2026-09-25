// The environment a harness a session starts in. The daemon's own environment is the
// starting point, but cophylad is often started from a harness session itself, and a harness
// leaves markers behind that a child of it reads as meaning it is a child: Claude Code turns
// off its transcript and writes no registry entry when it sees `CLAUDE_CODE_CHILD_SESSION`,
// which makes the session invisible to the daemon that started it. Muse names the session
// and plugin a process runs under, the same way. Every marker goes.

const DROP = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"];
const MARKERS = /^(CLAUDE_CODE_|CLAUDE_PLUGIN_|MUSE_PLUGIN_|MUSE_AGENTS_|MUSE_CURRENT_SESSION)/;

/** The daemon's environment with the harness's own markers taken out. */
export function scrub(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (MARKERS.test(k) || DROP.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
