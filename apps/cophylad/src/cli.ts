// `cophylad invite`, `cophylad join` and `cophylad leave`: thin clients of the running daemon on its
// loopback listener, authenticated with data/client.token like the desktop app.
//
//   cophylad invite [--name N] [--role hands|full] [--expires 1d] [--invite-expires 1h]
//   cophylad invite --phone [--name N] [--access full|sessions|view] [--expires 1d] [--invite-expires 15m]
//       prints the invite text for a new node or phone on stdout, and on a terminal its QR
//       code beside it, on stderr, for a phone's camera
//   cophylad join [--file F|-] [--workspace P]... [--answer-here]
//       redeems an invite read from a file or stdin, never from the command line, so it
//       stays out of the process list and the shell's history
//   cophylad leave
//
// Each takes --home and --port as the daemon does.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { encode } from "uqr";
import { ACCESS_PRESETS, request } from "@cophyla/protocol";
import type { AccessPreset } from "@cophyla/protocol";
import type { ClientResult, RpcMessage } from "@cophyla/protocol";
import { loadConfig, paths, resolveHome } from "./config/load.ts";

export const COMMANDS = ["invite", "join", "leave"] as const;
export type Command = (typeof COMMANDS)[number];

/** `90s`, `30m`, `12h`, `1d`, `2w`, or milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d|w)?$/i.exec(text.trim());
  if (!m) throw new Error(`not a duration: ${text} (try 30m, 12h or 1d)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const ms = n * scale[unit]!;
  if (ms <= 0) throw new Error(`a duration must be more than nothing: ${text}`);
  return ms;
}

/**
 * A QR code for a terminal: two rows of modules to a line in half blocks, light on dark
 * as a phone's camera reads it off a dark terminal, with the quiet zone around it.
 */
export function terminalQr(text: string): string {
  const rows = encode(text, { ecc: "M", border: 2 }).data;
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = "";
    for (let x = 0; x < rows[y]!.length; x++) {
      const top = !rows[y]![x];
      const bottom = !(rows[y + 1]?.[x] ?? false);
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

/** One request to the daemon on loopback, after hello; rejects with the daemon's message. */
async function call<N extends "grant.invite" | "node.join" | "node.leave">(opts: { home?: string; port?: string }, method: N, params: unknown): Promise<ClientResult<N>> {
  const p = paths(resolveHome(opts.home));
  const config = loadConfig(p, { writeDefault: false });
  const port = opts.port !== undefined ? Number(opts.port) : config.api.port;
  let token: string;
  try {
    token = readFileSync(p.clientToken, "utf8").trim();
  } catch {
    throw new Error(`no client token at ${p.clientToken}: is cophylad set up in this home?`);
  }
  const ws = new WebSocket(`ws://${config.api.host}:${port}/ws/client`);
  const pending = new Map<number, (m: RpcMessage) => void>();
  let seq = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data)) as RpcMessage;
    if ("id" in m && typeof m.id === "number" && !("method" in m)) pending.get(m.id)?.(m);
  });
  await new Promise<void>((ok, fail) => {
    ws.addEventListener("open", () => ok(), { once: true });
    ws.addEventListener("error", () => fail(new Error(`cophylad is not answering on ${config.api.host}:${port}: is it running?`)), { once: true });
  });
  const send = (m: string, prm: unknown) =>
    new Promise<unknown>((ok, fail) => {
      const id = ++seq;
      pending.set(id, (r) => {
        pending.delete(id);
        if ("error" in r && r.error) fail(new Error((r.error as { message?: string }).message ?? "failed"));
        else ok((r as { result?: unknown }).result);
      });
      ws.send(JSON.stringify(request(id, m, prm)));
    });
  try {
    await send("hello", { token, kind: "ui", name: "cophylad cli", audio: { in: false, out: false } });
    return (await send(method, params)) as ClientResult<N>;
  } finally {
    ws.close();
  }
}

async function readInvite(file: string | undefined): Promise<string> {
  let text = "";
  if (file !== undefined && file !== "-") text = readFileSync(file, "utf8");
  else {
    if (process.stdin.isTTY) process.stderr.write("Paste the invite, then press Enter:\n");
    for await (const chunk of process.stdin) {
      text += String(chunk);
      // The invite is one line: the first line that holds one is enough.
      if (/cophyla(-invite:|:\/\/invite)\S+\s*\n/.test(text)) break;
    }
  }
  if (!text.trim()) throw new Error(`no invite ${file !== undefined && file !== "-" ? `in ${file}` : "on stdin"}: give it the line \`cophylad invite\` printed on the primary`);
  return text;
}

export async function runCommand(command: Command, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      home: { type: "string" },
      port: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      phone: { type: "boolean" },
      access: { type: "string" },
      expires: { type: "string" },
      "invite-expires": { type: "string" },
      file: { type: "string" },
      workspace: { type: "string", multiple: true },
      "answer-here": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  const where = { ...(values.home !== undefined ? { home: values.home } : {}), ...(values.port !== undefined ? { port: values.port } : {}) };
  try {
    switch (command) {
      case "invite": {
        const ends = {
          ...(values.expires !== undefined ? { expiresIn: parseDuration(values.expires) } : {}),
          ...(values["invite-expires"] !== undefined ? { inviteExpiresIn: parseDuration(values["invite-expires"]) } : {}),
        };
        if (values.phone) {
          const preset = (values.access ?? "full") as AccessPreset;
          if (!(preset in ACCESS_PRESETS)) throw new Error("--access is full, sessions or view");
          if (values.role !== undefined) throw new Error("a phone has --access, not --role");
          const r = await call(where, "grant.invite", { kind: "controller", name: values.name ?? "phone", access: ACCESS_PRESETS[preset], ...ends });
          process.stderr.write(`An invite for the phone ${r.grant.name} (${preset}), good until ${new Date(r.invite.expiresAt).toLocaleString()}.\n`);
          if (process.stderr.isTTY) process.stderr.write(`Scan this with the phone's camera, or paste the line under it in the Cophyla app:\n\n${terminalQr(r.invite.link)}\n`);
          else process.stderr.write("Paste this line in the Cophyla app on the phone:\n\n");
          process.stdout.write(r.invite.text + "\n");
          return 0;
        }
        if (values.access !== undefined) throw new Error("a node has --role, not --access");
        const role = values.role ?? "hands";
        if (role !== "hands" && role !== "full") throw new Error("--role is hands or full");
        const r = await call(where, "grant.invite", { kind: "node", name: values.name ?? "new node", role, ...ends });
        process.stderr.write(`An invite for ${r.grant.name} (${role}), good until ${new Date(r.invite.expiresAt).toLocaleString()}.\nOn the new machine: cophylad join, then paste this line:\n\n`);
        process.stdout.write(r.invite.text + "\n");
        return 0;
      }
      case "join": {
        const invite = await readInvite(values.file);
        const paths = (values.workspace ?? []).map((w) => resolve(w));
        const r = await call(where, "node.join", { invite: invite.trim(), ...(paths.length > 0 ? { paths } : {}), ...(values["answer-here"] ? { answerHere: true } : {}) });
        process.stdout.write(`Joined ${r.primary.name} as ${r.role === "hands" ? "hands" : "a full member"}.\n`);
        return 0;
      }
      case "leave": {
        await call(where, "node.leave", {});
        process.stdout.write("Left the cluster; this machine runs alone now.\n");
        return 0;
      }
    }
  } catch (e) {
    process.stderr.write(`cophylad ${command}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
