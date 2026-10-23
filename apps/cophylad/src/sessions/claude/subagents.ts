// A Claude session's sub-agents' transcripts and what each one is: shared by the adapter,
// which reads them live, and the spend backfill, which reads them in a worker.

import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/**
 * A session's sub-agents' transcripts: `<session>/subagents/*.jsonl` beside its own, and a
 * workflow's agents' a folder further down, `subagents/workflows/<run>/agent-*.jsonl`.
 */
export function subagentTranscripts(transcript: string): string[] {
  const list = (dir: string): Dirent[] => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const dir = subagentsDir(transcript);
  const out: string[] = [];
  for (const e of list(dir)) {
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(join(dir, e.name));
    else if (e.isDirectory() && e.name === "workflows") {
      for (const run of list(join(dir, "workflows"))) {
        if (!run.isDirectory()) continue;
        for (const f of list(join(dir, "workflows", run.name))) if (f.isFile() && f.name.startsWith("agent-") && f.name.endsWith(".jsonl")) out.push(join(dir, "workflows", run.name, f.name));
      }
    }
  }
  return out;
}

/** The folder a session's sub-agents' transcripts are under. */
export function subagentsDir(transcript: string): string {
  return join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
}

/** A sub-agent's transcript, as the ledger tells it apart. */
export interface SubagentInfo {
  /** Its id: the one the launch's tool result names. */
  id: string;
  /** `sub:<type>` from its `.meta.json`, `sub` when that says none. */
  agent: string;
  /** Its key under its conversation's, for the ledger's marks: its path below the sub-agents' folder. */
  key: string;
}

export function subagentInfo(transcript: string, file: string): SubagentInfo {
  const id = basename(file, ".jsonl").replace(/^agent-/, "");
  let agent = "sub";
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")) as { agentType?: unknown };
    if (typeof meta.agentType === "string" && meta.agentType.trim() !== "") agent = `sub:${meta.agentType.trim()}`;
  } catch {
    // no meta: a sub-agent of no known type
  }
  if (agent === "sub" && file.includes("workflows")) agent = "sub:workflow";
  return { id, agent, key: relative(subagentsDir(transcript), file).replace(/\\/g, "/") };
}
