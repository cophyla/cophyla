// A tool's result as text: what the tool did, in a line or a few, never the harness's raw
// object. Claude Code's own tools have a rule each, read off the object its PostToolUse hook
// carries (its transcript's `toolUseResult` is the same one); every other tool, MCP tools
// included, and every other harness has the generic rule: the text in the value, else compact
// JSON. A value is redacted before it is read, so a credential-shaped key or a `base64` field
// never becomes text.

import { redact } from "../gate/audit.ts";
import { parseJson } from "./muse/view.ts";

type Row = Record<string, unknown>;
type Rule = (response: unknown) => string | undefined;

const isRow = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The text of a tool's result. A failure's `error` is the text when given. A Claude rule that
 * does not recognise the value's shape (an older CLI, a transcript's plain string) leaves it to
 * the generic rule.
 */
export function toolResultText(harness: string, tool: string | undefined, response: unknown, error?: string): string {
  if (error) return error;
  const value = redact(parseJson(response));
  if (harness === "claude" && tool !== undefined) {
    const text = CLAUDE_RULES.get(tool)?.(value);
    if (text !== undefined) return text;
  }
  return genericText(value);
}

// ---------------------------------------------------------------------------------------
// Claude Code's tools

/** The note Claude Code adds to a command's stderr when it put the shell back in the session's folder. */
const CWD_RESET = /^[ \t]*Shell cwd was reset to .*$/gm;

function shellText(r: unknown): string | undefined {
  if (!isRow(r) || (typeof r["stdout"] !== "string" && typeof r["stderr"] !== "string")) return undefined;
  const lines: string[] = [];
  const out = r["isImage"] === true ? "[image]" : (str(r["stdout"]) ?? "").trimEnd();
  if (out) lines.push(out);
  const err = (str(r["stderr"]) ?? "").replace(CWD_RESET, "").trim();
  if (err) lines.push(err);
  if (r["interrupted"] === true) lines.push("(interrupted)");
  if (r["timedOutAfterMs"] !== undefined) lines.push("(timed out)");
  const background = str(r["backgroundTaskId"]);
  if (background) lines.push(`(in the background: ${background})`);
  const code = str(r["returnCodeInterpretation"]);
  if (code) lines.push(`(${code})`);
  const diff = r["bashEditDiff"];
  const edited = isRow(diff) ? (Array.isArray(diff["files"]) ? diff["files"].length : 0) + (num(diff["moreFiles"]) ?? 0) : 0;
  if (edited > 0) lines.push(`(edited ${plural(edited, "file")})`);
  return lines.length > 0 ? lines.join("\n") : "(no output)";
}

/** Lines added and removed over a `structuredPatch`'s hunks. */
function patchCounts(patch: unknown): string {
  let added = 0;
  let removed = 0;
  for (const hunk of Array.isArray(patch) ? patch : []) {
    const lines = isRow(hunk) && Array.isArray(hunk["lines"]) ? hunk["lines"] : [];
    for (const l of lines) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return `+${added} −${removed}`;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function editText(r: unknown): string | undefined {
  if (!isRow(r) || typeof r["filePath"] !== "string") return undefined;
  return `edited ${r["filePath"]}: ${patchCounts(r["structuredPatch"])}${r["userModified"] === true ? " (the user changed it first)" : ""}`;
}

function writeText(r: unknown): string | undefined {
  if (!isRow(r) || typeof r["filePath"] !== "string") return undefined;
  if (r["type"] === "create") return `created ${r["filePath"]}, ${plural(lineCount(str(r["content"]) ?? ""), "line")}`;
  return `updated ${r["filePath"]}: ${patchCounts(r["structuredPatch"])}`;
}

function readText(r: unknown): string | undefined {
  if (!isRow(r) || !isRow(r["file"])) return undefined;
  const f = r["file"];
  const path = str(f["filePath"]);
  switch (r["type"]) {
    case "text": {
      const shown = num(f["numLines"]);
      if (!path || shown === undefined) return undefined;
      const start = num(f["startLine"]) ?? 1;
      const total = num(f["totalLines"]);
      const of = total !== undefined ? ` of ${total}` : "";
      if (shown > 0) return `read ${path}, lines ${start}–${start + shown - 1}${of}`;
      return total === 0 ? `read ${path}, an empty file` : `read ${path}, no lines from ${start}${of}`;
    }
    case "image": {
      const dims = isRow(f["dimensions"]) ? f["dimensions"] : {};
      const w = num(dims["originalWidth"]);
      const h = num(dims["originalHeight"]);
      const about = [str(f["type"]), w !== undefined && h !== undefined ? `${w}×${h}` : undefined].filter(Boolean).join(", ");
      return `read ${path ? `${path}, an image` : "an image"}${about ? ` (${about})` : ""}`;
    }
    case "pdf":
      return path ? `read ${path} (a PDF)` : "read a PDF";
    case "notebook":
      return `read ${path ?? "a notebook"}${Array.isArray(f["cells"]) ? `, a notebook of ${plural(f["cells"].length, "cell")}` : ""}`;
    case "file_unchanged":
      return `read ${path ?? "a file"}: unchanged since it was last read`;
    default:
      return path ? `read ${path}${typeof r["type"] === "string" ? ` (${r["type"]})` : ""}` : undefined;
  }
}

function filesText(count: unknown, names: unknown): string {
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
  return [plural(num(count) ?? list.length, "file"), ...list].join("\n");
}

function grepText(r: unknown): string | undefined {
  if (!isRow(r) || (typeof r["mode"] !== "string" && !Array.isArray(r["filenames"]))) return undefined;
  const content = str(r["content"]);
  return content ? content : filesText(r["numFiles"], r["filenames"]);
}

function globText(r: unknown): string | undefined {
  if (!isRow(r) || !Array.isArray(r["filenames"])) return undefined;
  return filesText(r["numFiles"], r["filenames"]) + (r["truncated"] === true ? "\n(truncated)" : "");
}

function agentText(r: unknown): string | undefined {
  if (!isRow(r) || (typeof r["status"] !== "string" && !Array.isArray(r["content"]))) return undefined;
  const head = [str(r["status"]), str(r["description"])].filter(Boolean).join(": ");
  const body = Array.isArray(r["content"]) ? blocksText(r["content"].filter((b) => isRow(b) && b["type"] === "text")) : "";
  return [head, body].filter(Boolean).join("\n");
}

function searchText(r: unknown): string | undefined {
  if (!isRow(r) || !Array.isArray(r["results"])) return undefined;
  const lines: string[] = [];
  for (const group of r["results"]) {
    if (!isRow(group) || !Array.isArray(group["content"])) continue;
    for (const hit of group["content"]) {
      if (!isRow(hit) || typeof hit["url"] !== "string") continue;
      lines.push(typeof hit["title"] === "string" && hit["title"] ? `${hit["title"]} (${hit["url"]})` : hit["url"]);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "no results";
}

function answersText(r: unknown): string | undefined {
  if (!isRow(r) || !isRow(r["answers"])) return undefined;
  const notes = isRow(r["annotations"]) ? r["annotations"] : {};
  const lines = Object.entries(r["answers"]).map(([question, answer]) => {
    const note = isRow(notes[question]) ? str(notes[question]["notes"]) : undefined;
    return `${question} → ${Array.isArray(answer) ? answer.join(", ") : String(answer)}${note ? ` (${note})` : ""}`;
  });
  return lines.length > 0 ? lines.join("\n") : "no answers";
}

function searchToolsText(r: unknown): string | undefined {
  if (!isRow(r) || !Array.isArray(r["matches"])) return undefined;
  return r["matches"].length > 0 ? r["matches"].map(String).join(", ") : "no matches";
}

const CLAUDE_RULES = new Map<string, Rule>([
  ["Bash", shellText],
  ["PowerShell", shellText],
  ["Edit", editText],
  ["Write", writeText],
  ["Read", readText],
  ["Grep", grepText],
  ["Glob", globText],
  ["Agent", agentText],
  ["Task", agentText],
  ["WebFetch", (r) => (isRow(r) ? str(r["result"]) : undefined)],
  ["WebSearch", searchText],
  ["AskUserQuestion", answersText],
  ["ToolSearch", searchToolsText],
]);

// ---------------------------------------------------------------------------------------
// Any other tool

/** Keys whose value is a result's text, looked for in this order after `stdout`/`stderr` and `output`. */
const TEXT_KEYS = ["formatted_output", "content", "result", "message", "text"];

const isBlock = (b: unknown): b is Row => isRow(b) && typeof b["type"] === "string";
const isBlocks = (v: unknown): v is Row[] => Array.isArray(v) && v.length > 0 && v.every(isBlock);

/**
 * A string as it is, or the value it holds as JSON; content blocks as their text, images as
 * `[image]`; an object's first text field; anything else as compact JSON.
 */
export function genericText(value: unknown): string {
  const v = typeof value === "string" ? redact(parseJson(value)) : value;
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "(no output)";
  if (isBlocks(v)) return blocksText(v);
  if (isRow(v)) {
    const text = rowText(v);
    if (text !== undefined) return text;
  }
  return JSON.stringify(v) ?? "";
}

function rowText(r: Row): string | undefined {
  if (typeof r["stdout"] === "string" || typeof r["stderr"] === "string") {
    return [str(r["stdout"]), str(r["stderr"])]
      .map((s) => (s ?? "").trimEnd())
      .filter(Boolean)
      .join("\n");
  }
  const output = str(r["output"]);
  if (output !== undefined) {
    const code = num(r["exit_code"]);
    return code ? [output.trimEnd(), `(exit code ${code})`].filter(Boolean).join("\n") : output;
  }
  for (const k of TEXT_KEYS) {
    const x = r[k];
    if (typeof x === "string") return x;
    if (isBlocks(x)) return blocksText(x);
  }
  return undefined;
}

function blocksText(blocks: unknown[]): string {
  return blocks
    .map(blockText)
    .filter((t) => t !== "")
    .join("\n");
}

function blockText(b: unknown): string {
  if (!isRow(b)) return genericText(b);
  switch (b["type"]) {
    case "text":
    case "input_text":
    case "output_text":
      return genericText(str(b["text"]) ?? "");
    case "image":
    case "input_image":
      return "[image]";
    // ACP wraps each piece of a tool's output in a `content` block.
    case "content":
      return b["content"] !== undefined ? blockText(b["content"]) : "";
    default:
      return JSON.stringify(b);
  }
}
