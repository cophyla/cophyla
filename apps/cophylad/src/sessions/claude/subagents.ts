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

/** What a sub-agent's `.meta.json` says of it: the call that started it, its type and what it was asked, and whether it has finished. */
export interface SubagentMeta {
  call?: string;
  type?: string;
  description?: string;
  finished?: boolean;
}

export function subagentMeta(file: string): SubagentMeta {
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")) as { toolUseId?: unknown; agentType?: unknown; description?: unknown; finished?: unknown };
    const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined);
    const call = str(meta.toolUseId, 200);
    const type = str(meta.agentType, 120);
    const description = str(meta.description, 300);
    return { ...(call ? { call } : {}), ...(type ? { type } : {}), ...(description ? { description } : {}), ...(meta.finished === true ? { finished: true } : {}) };
  } catch {
    // written as it starts: not yet, or a sub-agent of an older Claude
    return {};
  }
}

/**
 * One row of a sub-agent's transcript counted into its run: its tools called, the last in a few
 * words, its model, the tokens its context held at its latest model call, its times. Whether it changed the run.
 */
export function countSubagentRow(run: { steps: number; last?: string; model?: string; tokens?: number; startedAt: number; lastAt: number }, row: unknown): boolean {
  if (row === null || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  const at = typeof r["timestamp"] === "string" ? Date.parse(r["timestamp"]) : NaN;
  let changed = false;
  if (Number.isFinite(at)) {
    if (run.startedAt === 0 || at < run.startedAt) run.startedAt = at;
    if (at > run.lastAt) run.lastAt = at;
  }
  if (r["type"] !== "assistant") return changed;
  const message = r["message"] as Record<string, unknown> | undefined;
  const model = typeof message?.["model"] === "string" && message["model"] !== "<synthetic>" ? message["model"] : undefined;
  if (model !== undefined && model !== run.model) {
    run.model = model;
    changed = true;
  }
  // Its context's size as Claude Code's agent list gives it: what went in, cached or not, and what came out.
  const usage = message?.["usage"] as Record<string, unknown> | undefined;
  if (model !== undefined && usage) {
    const n = (k: string) => (typeof usage[k] === "number" && Number.isFinite(usage[k]) ? Math.max(0, Math.round(usage[k] as number)) : 0);
    const tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
    if (tokens > 0 && tokens !== run.tokens) {
      run.tokens = tokens;
      changed = true;
    }
  }
  const content = Array.isArray(message?.["content"]) ? (message["content"] as Record<string, unknown>[]) : [];
  for (const block of content) {
    if (block?.["type"] !== "tool_use") continue;
    run.steps += 1;
    run.last = callWords(String(block["name"] ?? "tool"), block["input"]);
    changed = true;
  }
  return changed;
}

/** A tool call in a few words, as a turn's steps line has it: the tool and what it was pointed at. */
export function callWords(name: string, input: unknown): string {
  const a = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() !== "" ? (a[k] as string).trim() : undefined);
  const path = str("file_path") ?? str("path") ?? str("notebook_path");
  const what = str("description") ?? str("command") ?? str("pattern") ?? str("query") ?? str("url") ?? (path ? (path.split(/[\\/]/).pop() ?? path) : undefined) ?? str("prompt");
  const tool = name.startsWith("mcp__") ? name.split("__").slice(2).join(" ") || name : name;
  if (!what) return tool.slice(0, 200);
  const line = what.split(/\r?\n/)[0]!;
  return `${tool} ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`.slice(0, 200);
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
