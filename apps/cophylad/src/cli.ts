// `cophylad invite`, `cophylad join`, `cophylad leave` and `cophylad lan`: thin clients of the running
// daemon on its loopback listener, authenticated with data/client.token like the desktop app.
//
//   cophylad invite [--name N] [--role hands|full] [--expires 1d] [--invite-expires 1h]
//   cophylad invite --phone [--name N] [--access full|sessions|view] [--expires 1d] [--invite-expires 15m]
//       prints the invite text for a new node or phone on stdout, and on a terminal its QR
//       code beside it, on stderr, for a phone's camera
//   cophylad invite --browser [--name N] [--access full|sessions|view] [--expires 30d]
//       a key for a browser on another computer on this network: the address to open and the
//       key to type there on stderr, with the QR code of a link that carries both on a
//       terminal, and that link on stdout; good once, for fifteen minutes
//   cophylad join [--file F|-] [--workspace P]... [--answer-here] [--ask|--trust]
//       redeems an invite read from a file or stdin, never from the command line, so it
//       stays out of the process list and the shell's history; at a terminal it asks whether
//       the primary may work here without asking each time (yes unless answered no), which
//       --trust and --ask answer beforehand
//   cophylad leave
//   cophylad lan on|off|status
//       whether this machine serves devices on its network (a phone, a browser on another
//       computer): `on` and `off` set it, kept from then on over `[controller] enabled`, and
//       each prints where the listener stands, with its addresses and its fingerprints
//
// Each takes --home and --port as the daemon does.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { encode } from "uqr";
import { ACCESS_PRESETS, parseInvite, request, UNNAMED_NODE } from "@cophyla/protocol";
import type { AccessPreset } from "@cophyla/protocol";
import type { ClientRequestName, ClientResult, LanState, RpcMessage } from "@cophyla/protocol";
import { loadConfig, paths, resolveHome } from "./config/load.ts";

export const COMMANDS = ["invite", "join", "leave", "lan"] as const;
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

/**
 * One request to the daemon on loopback, after hello; rejects with the daemon's message.
 * `local`: served by this machine's daemon even while it is a node of a cluster.
 */
export async function call<N extends ClientRequestName>(opts: { home?: string; port?: string }, method: N, params: unknown, how: { local?: boolean; name?: string } = {}): Promise<ClientResult<N>> {
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
    await send("hello", { token, kind: "ui", name: how.name ?? "cophylad cli", audio: { in: false, out: false }, ...(how.local ? { local: true } : {}) });
    return (await send(method, params)) as ClientResult<N>;
  } finally {
    ws.close();
  }
}

/** Questions answered at this terminal, a line each, asked on stderr so stdout stays the command's. */
export interface Questions {
  ask(question: string): Promise<string>;
  close(): void;
}

export function terminalQuestions(): Questions {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return { ask: (q) => new Promise((ok) => rl.question(q, ok)), close: () => rl.close() };
}

/** The invite from a file, or from stdin: through `questions` when stdin is a terminal. */
export async function readInvite(file: string | undefined, questions?: Questions): Promise<string> {
  let text = "";
  if (file !== undefined && file !== "-") text = readFileSync(file, "utf8");
  else if (questions) text = await questions.ask("Paste the invite, then press Enter:\n");
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

/**
 * Whether the primary that minted `invite` works here without asking each time: `--trust` or
 * `--ask` say so beforehand; at a terminal the question is asked, and anything but a no is a
 * yes; with no terminal to ask at, yes.
 */
export async function trustsPrimary(invite: string, flags: { ask?: boolean; trust?: boolean }, questions?: Questions): Promise<boolean> {
  if (flags.ask && flags.trust) throw new Error("--ask and --trust answer the same question: give one");
  if (flags.ask) return false;
  if (flags.trust || !questions) return true;
  let name: string;
  try {
    name = parseInvite(invite).node.name;
  } catch {
    // a damaged invite is the daemon's to refuse, in its own words
    return true;
  }
  const answer = await questions.ask(`Let ${name} start sessions and terminals, run commands and edit files on this machine without asking each time? [Y/n] `);
  return !/^\s*n/i.test(answer);
}

/** Where the node stands on its network, as lines for a terminal. */
export function lanLines(s: LanState): string {
  const head =
    s.state === "on"
      ? "Access on this network is on: devices are served."
      : s.state === "nodes"
        ? "Access on this network is off. The listener is up for other nodes' links alone."
        : s.state === "failed"
          ? `Access on this network is on, but the listener is not up: ${s.reason ?? "it could not be started"}.`
          : "Access on this network is off.";
  const lines = [head];
  if (s.addresses.length > 0) lines.push(`Open in a browser: ${s.addresses.join("  or  ")}`);
  if (s.fingerprints) lines.push(`Certificate (SHA-256): ${s.fingerprints.certificate}`, `Key (SHA-256, base64): ${s.fingerprints.key}`);
  if (s.certificate) lines.push(s.certificate.error !== undefined ? `Your own certificate is not in use: ${s.certificate.error}` : `Your own certificate serves ${s.certificate.names.join(", ")}`);
  if (s.keys > 0) lines.push(`${s.keys} browser key${s.keys === 1 ? "" : "s"} waiting to be typed.`);
  if (s.refused) lines.push(`Last refused, ${new Date(s.refused.at).toLocaleString()}: ${s.refused.detail}`);
  return lines.join("\n") + "\n";
}

/** One of the commands; `prog` names the program in what it prints, `local` keeps it on this machine. */
export async function runCommand(command: Command, argv: string[], how: { local?: boolean; prog?: string } = {}): Promise<number> {
  const prog = how.prog ?? "cophylad";
  const as = { ...(how.local ? { local: true } : {}), name: `${prog} cli` };
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: command === "lan",
    options: {
      home: { type: "string" },
      port: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      phone: { type: "boolean" },
      browser: { type: "boolean" },
      access: { type: "string" },
      expires: { type: "string" },
      "invite-expires": { type: "string" },
      file: { type: "string" },
      workspace: { type: "string", multiple: true },
      "answer-here": { type: "boolean" },
      ask: { type: "boolean" },
      trust: { type: "boolean" },
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
        if (values.phone && values.browser) throw new Error("--phone and --browser are two invites: give one");
        if (values.browser) {
          const preset = (values.access ?? "full") as AccessPreset;
          if (!(preset in ACCESS_PRESETS)) throw new Error("--access is full, sessions or view");
          if (values.role !== undefined) throw new Error("a browser has --access, not --role");
          if (values["invite-expires"] !== undefined) throw new Error("a browser's key is good for fifteen minutes: --invite-expires is a phone's or a node's");
          const r = await call(where, "browser.invite", { name: values.name ?? "browser", access: ACCESS_PRESETS[preset], ...(values.expires !== undefined ? { expiresIn: parseDuration(values.expires) } : {}) }, as);
          const until = r.grant.expiresAt !== undefined ? `, with access until ${new Date(r.grant.expiresAt).toLocaleString()}` : "";
          process.stderr.write(`A key for the browser ${r.grant.name} (${preset})${until}.\nOn the other computer, open ${r.invite.address} and type this key, good once until ${new Date(r.invite.expiresAt).toLocaleTimeString()}:\n\n    ${r.invite.key}\n\n`);
          if (process.stderr.isTTY) process.stderr.write(`Or scan this, which opens that page with the key in it:\n\n${terminalQr(r.invite.link)}\n`);
          process.stdout.write(r.invite.link + "\n");
          return 0;
        }
        if (values.phone) {
          const preset = (values.access ?? "full") as AccessPreset;
          if (!(preset in ACCESS_PRESETS)) throw new Error("--access is full, sessions or view");
          if (values.role !== undefined) throw new Error("a phone has --access, not --role");
          const r = await call(where, "grant.invite", { kind: "controller", name: values.name ?? "phone", access: ACCESS_PRESETS[preset], ...ends }, as);
          process.stderr.write(`An invite for the phone ${r.grant.name} (${preset}), good until ${new Date(r.invite.expiresAt).toLocaleString()}.\n`);
          if (process.stderr.isTTY) process.stderr.write(`Scan this with the phone's camera, or paste the line under it in the Cophyla app:\n\n${terminalQr(r.invite.link)}\n`);
          else process.stderr.write("Paste this line in the Cophyla app on the phone:\n\n");
          process.stdout.write(r.invite.text + "\n");
          return 0;
        }
        if (values.access !== undefined) throw new Error("a node has --role, not --access");
        const role = values.role ?? "hands";
        if (role !== "hands" && role !== "full") throw new Error("--role is hands or full");
        const r = await call(where, "grant.invite", { kind: "node", name: values.name ?? UNNAMED_NODE, role, ...ends }, as);
        process.stderr.write(`An invite for ${r.grant.name} (${role}), good until ${new Date(r.invite.expiresAt).toLocaleString()}.\nOn the new machine: ${prog} join (or, to lend it one folder, cophyla node add), then paste this line:\n\n`);
        process.stdout.write(r.invite.text + "\n");
        return 0;
      }
      case "join": {
        const flags = { ...(values.ask ? { ask: true } : {}), ...(values.trust ? { trust: true } : {}) };
        if (flags.ask && flags.trust) throw new Error("--ask and --trust answer the same question: give one");
        const questions = process.stdin.isTTY ? terminalQuestions() : undefined;
        let invite: string;
        let trusted: boolean;
        try {
          invite = await readInvite(values.file, questions);
          trusted = await trustsPrimary(invite, flags, questions);
        } finally {
          questions?.close();
        }
        const paths = (values.workspace ?? []).map((w) => resolve(w));
        const r = await call(where, "node.join", { invite: invite.trim(), ...(paths.length > 0 ? { paths } : {}), ...(values["answer-here"] ? { answerHere: true } : {}), ...(trusted ? {} : { askPrimary: true }) }, as);
        process.stdout.write(`Joined ${r.primary.name} as ${r.role === "hands" ? "hands" : "a full member"}${trusted ? "" : ", asking here before what it does"}.\n`);
        return 0;
      }
      case "leave": {
        await call(where, "node.leave", {}, as);
        process.stdout.write("Left the cluster; this machine runs alone now.\n");
        return 0;
      }
      case "lan": {
        const what = positionals[0] ?? "status";
        if (positionals.length > 1 || !["on", "off", "status"].includes(what)) throw new Error("say on, off or status");
        const state = await call(where, what === "on" ? "lan.enable" : what === "off" ? "lan.disable" : "lan.info", {}, as);
        process.stdout.write(lanLines(state));
        return state.state === "failed" ? 1 : 0;
      }
    }
  } catch (e) {
    process.stderr.write(`${prog} ${command}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
