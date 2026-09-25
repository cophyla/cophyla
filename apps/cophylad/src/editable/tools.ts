// An editable tool from its module: `~/.cophyla/tools/<name>.ts` exports `{name, description,
// schema, risk, run}` as named exports or as `default`. The name is namespaced like
// `my.word_count`, the schema is a JSON Schema object (anything with `safeParse` is taken
// too), the risk one of the four classes. A module that fails any of this yields a problem
// naming the file, and the tool it replaced stays.

import { RiskClass } from "@cophyla/protocol";
import { compileSchema } from "../tools/schema.ts";
import type { Tool } from "../tools/index.ts";

/** `namespace.name`, lower-case, at least one dot: the same rule as a custom event's name. */
export const TOOL_NAME = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

export type LoadedTool = { tool: Tool } | { problem: string };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

/** The tool a module declares, or what is wrong with it. `file` names the module in a problem. */
export function loadTool(file: string, mod: Record<string, unknown>): LoadedTool {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  const fail = (message: string): LoadedTool => ({ problem: `${base}: ${message}` });
  const source = isRecord(mod["default"]) ? mod["default"] : mod;
  const name = source["name"];
  if (typeof name !== "string") return fail("export a string `name` such as my.word_count");
  if (!TOOL_NAME.test(name)) return fail(`name ${JSON.stringify(name)} must be namespaced, like my.word_count`);
  const description = source["description"];
  if (typeof description !== "string" || description.trim() === "") return fail("export a `description`");
  const risk = source["risk"];
  const riskParsed = RiskClass.safeParse(risk);
  if (!riskParsed.success) return fail(`risk must be one of ${RiskClass.options.join(", ")}`);
  const run = source["run"];
  if (typeof run !== "function") return fail("export a `run(args, ctx)` function");
  const schema = source["schema"] ?? { type: "object", properties: {} };
  try {
    compileSchema(schema);
  } catch (e) {
    return fail(`schema: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    tool: {
      name,
      description,
      schema: schema as Tool["schema"],
      risk: riskParsed.data,
      run: run as Tool["run"],
    },
  };
}
