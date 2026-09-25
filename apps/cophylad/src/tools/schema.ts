// A tool's argument schema in the two forms a tool may declare it: a zod schema (the
// built-in tools; anything with `safeParse`), or a plain JSON Schema object (an editable
// tool, whose file has no `node_modules` to import zod from). Both compile to one validator
// and one JSON Schema for the brain. The plain form is checked structurally: an object with
// its `required` keys present, each top-level property of its declared `type` and among its
// `enum`; what lies deeper is the tool's own to check.

import { z } from "zod";
import type { JSONSchema } from "@cophyla/protocol";

export interface SchemaIssue {
  path: (string | number)[];
  message: string;
}

export type Validation = { ok: true; data: unknown } | { ok: false; issues: SchemaIssue[] };

export interface CompiledSchema {
  validate(args: unknown): Validation;
  json: JSONSchema;
}

interface ZodLike {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

const isZodLike = (v: unknown): v is ZodLike => v !== null && typeof v === "object" && typeof (v as { safeParse?: unknown }).safeParse === "function";

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The zod schema as JSON Schema, `$schema` dropped: what a model sees. */
export function jsonSchema(schema: z.ZodType): JSONSchema {
  const out = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as JSONSchema;
  delete out["$schema"];
  return out;
}

/** Whether a value is of a JSON Schema primitive `type`. */
function ofType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** Checks `args` against the top level of a plain JSON Schema object. */
export function checkStructure(schema: JSONSchema, args: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const type = schema["type"];
  if (type !== undefined && type !== "object") {
    if (!ofType(args, String(type))) issues.push({ path: [], message: `expected ${String(type)}` });
    return issues;
  }
  if (!isPlainObject(args)) return [{ path: [], message: "expected an object" }];
  const required = Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).filter((k): k is string => typeof k === "string") : [];
  for (const key of required) if (!(key in args) || args[key] === undefined) issues.push({ path: [key], message: "required" });
  const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
  for (const [key, def] of Object.entries(properties)) {
    if (!isPlainObject(def)) continue;
    const value = args[key];
    if (value === undefined) continue;
    const t = def["type"];
    const types = Array.isArray(t) ? t.map(String) : t !== undefined ? [String(t)] : [];
    if (types.length > 0 && !types.some((x) => ofType(value, x))) issues.push({ path: [key], message: `expected ${types.join(" or ")}` });
    const options = def["enum"];
    if (Array.isArray(options) && !options.some((o) => JSON.stringify(o) === JSON.stringify(value))) issues.push({ path: [key], message: `expected one of ${options.map((o) => JSON.stringify(o)).join(", ")}` });
  }
  if (schema["additionalProperties"] === false) {
    for (const key of Object.keys(args)) if (!(key in properties)) issues.push({ path: [key], message: "unknown argument" });
  }
  return issues;
}

/** Whether a plain object is a JSON Schema this module can check: an object schema, or one with a type. */
export function isJsonSchemaObject(v: unknown): v is JSONSchema {
  if (!isPlainObject(v)) return false;
  const type = v["type"];
  if (type === undefined) return isPlainObject(v["properties"]) || Array.isArray(v["required"]);
  return typeof type === "string" || Array.isArray(type);
}

/** One validator and one JSON Schema from either form; throws for anything else. */
export function compileSchema(schema: unknown): CompiledSchema {
  if (isZodLike(schema)) {
    const withJson = schema as ZodLike & { jsonSchema?: () => JSONSchema };
    const json = schema instanceof z.ZodType ? jsonSchema(schema) : typeof withJson.jsonSchema === "function" ? (withJson.jsonSchema() ?? { type: "object" }) : { type: "object" };
    return {
      json,
      validate: (args) => {
        const r = schema.safeParse(args);
        if (r.success) return { ok: true, data: r.data };
        return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)), message: i.message })) };
      },
    };
  }
  if (isJsonSchemaObject(schema)) {
    const json: JSONSchema = { ...schema };
    delete json["$schema"];
    return {
      json,
      validate: (args) => {
        const issues = checkStructure(json, args);
        return issues.length === 0 ? { ok: true, data: args } : { ok: false, issues };
      },
    };
  }
  throw new Error("schema must be a JSON Schema object or something with safeParse");
}
