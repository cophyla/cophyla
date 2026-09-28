// The tool registry behind `tool.list` and `tool.run`: the built-in filesystem read tools
// and the HTTP tool, and every editable tool the `editable` module loads from `~/.cophyla/tools`,
// behind one interface `{name, description, schema, risk, run}`. Arguments are validated
// against the tool's schema, zod or plain JSON Schema; the schema goes out to the brain as
// JSON Schema. The gate keys policy on the effective risk: an editable tool runs arbitrary
// code in the daemon, so one that declares `read` or `write` is treated as `exec`, and
// `tool.list` reports it so. A built-in name is never replaced by an editable tool.

import type { z } from "zod";
import { RpcError } from "@cophyla/protocol";
import type { JSONSchema, NodeId, RiskClass, ToolDefinition, ToolSource, Workspace } from "@cophyla/protocol";
import type { ToolsConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import { builtinTools } from "./builtin.ts";
import { compileSchema } from "./schema.ts";
import type { CompiledSchema } from "./schema.ts";

export interface ToolContext {
  signal?: AbortSignal;
  config: ToolsConfig;
  workspaces: WorkspaceLookup;
  /** The daemon's log, under the tool's name. */
  log: Logger;
  /** `~/.cophyla`. */
  home: string;
  /** On a node confined to some folders, run for its primary: a path outside them is refused. */
  confine?: ToolConfinement;
}

/** The folders a primary's request may reach on a confined node, as the tools ask it. */
export interface ToolConfinement {
  require(path: string, what: string): void;
  contains(path: string, fresh?: boolean): boolean;
}

export interface WorkspaceLookup {
  get(id: string): Workspace | undefined;
}

export interface Tool<A = unknown> {
  name: string;
  description: string;
  /** A zod schema, or a plain JSON Schema object. */
  schema: z.ZodType<A> | JSONSchema;
  risk: RiskClass;
  run(args: A, ctx: ToolContext): Promise<unknown> | unknown;
}

export interface ToolsDeps {
  nodeId: NodeId;
  config: ToolsConfig;
  workspaces: WorkspaceLookup;
  log: Logger;
  home: string;
}

export const RISK_RANK: Record<RiskClass, number> = { read: 0, write: 1, exec: 2, network: 3 };

/** The risk class the gate keys on: an editable tool is at least `exec`, whatever it declares. */
export function effectiveRisk(declared: RiskClass, source: ToolSource): RiskClass {
  if (source === "editable" && RISK_RANK[declared] < RISK_RANK.exec) return "exec";
  return declared;
}

interface Entry {
  tool: Tool;
  source: ToolSource;
  schema: CompiledSchema;
}

export class Tools {
  private deps: ToolsDeps;
  private tools = new Map<string, Entry>();

  constructor(deps: ToolsDeps) {
    this.deps = deps;
    for (const t of builtinTools()) this.register(t);
  }

  /**
   * Adds a tool, or replaces the editable one of the same name. A built-in name is kept:
   * false, and the caller reports it. A schema that compiles to nothing throws.
   */
  register(tool: Tool, source: ToolSource = "builtin"): boolean {
    const existing = this.tools.get(tool.name);
    if (existing && existing.source === "builtin") return false;
    this.tools.set(tool.name, { tool, source, schema: compileSchema(tool.schema) });
    return true;
  }

  /** Removes an editable tool; false for a built-in or unknown name. */
  unregister(name: string): boolean {
    const existing = this.tools.get(name);
    if (!existing || existing.source === "builtin") return false;
    this.tools.delete(name);
    return true;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  source(name: string): ToolSource | undefined {
    return this.tools.get(name)?.source;
  }

  /** The effective risk class of a tool, for the gate. */
  risk(name: string): RiskClass | undefined {
    const e = this.tools.get(name);
    return e ? effectiveRisk(e.tool.risk, e.source) : undefined;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(({ tool, source, schema }) => ({
      name: tool.name,
      description: tool.description,
      schema: schema.json,
      source,
      node: this.deps.nodeId,
      risk: effectiveRisk(tool.risk, source),
    }));
  }

  /** Runs a tool; `workspaces` resolves a workspace id where the caller's differ from the machine's (a workspace node's). */
  async run(name: string, args: unknown, opts: { signal?: AbortSignal; confine?: ToolConfinement; workspaces?: WorkspaceLookup } = {}): Promise<unknown> {
    const entry = this.tools.get(name);
    if (!entry) throw new RpcError("not_found", `no tool ${name}`);
    const parsed = entry.schema.validate(args ?? {});
    if (!parsed.ok) throw new RpcError("invalid", `bad arguments for ${name}: ${parsed.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ")}`, parsed.issues);
    const ctx: ToolContext = { config: this.deps.config, workspaces: opts.workspaces ?? this.deps.workspaces, log: this.deps.log.child(name), home: this.deps.home };
    if (opts.signal) ctx.signal = opts.signal;
    if (opts.confine) ctx.confine = opts.confine;
    return entry.tool.run(parsed.data, ctx);
  }
}

export { jsonSchema } from "./schema.ts";
