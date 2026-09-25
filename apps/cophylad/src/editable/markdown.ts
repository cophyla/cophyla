// Markdown files with YAML frontmatter, the shape of prompts and memory. The YAML subset:
// `key: scalar`, `key: [a, b]`, and a block list of `- item` lines under a key. Enough for
// `description`, `kind`, `tags` and `variables`; anything else is kept as a string.

export interface Frontmatter {
  [key: string]: string | string[] | undefined;
}

export interface Parsed {
  frontmatter: Frontmatter;
  body: string;
}

const FENCE = "---";

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function inlineList(s: string): string[] | undefined {
  const t = s.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map(unquote).filter((x) => x !== "");
}

export function parseMarkdown(text: string): Parsed {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return { frontmatter: {}, body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === FENCE);
  if (end < 0) return { frontmatter: {}, body: text };
  const frontmatter: Frontmatter = {};
  let key: string | undefined;
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && key !== undefined) {
      const current = frontmatter[key];
      const list = Array.isArray(current) ? current : [];
      list.push(unquote(item[1]!));
      frontmatter[key] = list;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    key = kv[1]!;
    const value = kv[2]!;
    if (value.trim() === "") {
      frontmatter[key] = [];
      continue;
    }
    const list = inlineList(value);
    frontmatter[key] = list ?? unquote(value);
  }
  const body = lines.slice(end + 1).join("\n").replace(/^\n/, "");
  return { frontmatter, body };
}

function needsQuotes(s: string): boolean {
  return s === "" || /[:#\[\]{},&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s);
}

function scalar(s: string): string {
  return needsQuotes(s) ? JSON.stringify(s) : s;
}

export function serialiseMarkdown(frontmatter: Frontmatter, body: string): string {
  const out: string[] = [FENCE];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) out.push(`${key}: [${value.map(scalar).join(", ")}]`);
    else out.push(`${key}: ${scalar(value)}`);
  }
  out.push(FENCE, "");
  return out.join("\n") + body.replace(/\s+$/, "") + "\n";
}

export function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(", ") : v;
}

export function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : v.split(",").map((x) => x.trim()).filter((x) => x !== "");
}
