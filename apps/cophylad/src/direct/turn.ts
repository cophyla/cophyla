// TURN credentials for this node's direct connections, from the server (`turn.credentials`,
// the plan's to allow). One set serves every phone and the stream viewer until three
// quarters of its lifetime have passed, then the next ask mints another. With no TURN from
// the server (none set up there, the plan's cap reached, the link down) a direct path is
// still worth trying: the set is this node's STUN servers alone, for a few minutes, and then
// the server is asked again. Each set is also
// written to `data/remote/ice-servers.json` (owner-only) in the shape the web viewer's own
// config takes (every entry with a username and a credential, empty for STUN), which its ICE
// script prints for the stream's WebRTC; switching direct connections off removes it.

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IceServer } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export interface IceGrant {
  iceServers: IceServer[];
  expiresAt: number;
}

export interface TurnCacheDeps {
  /** Mints a set through the server. */
  mint: () => Promise<IceGrant>;
  /** `[direct].stun`: the set handed out while the server gives no TURN. */
  stun?: string[];
  /** Where the stream viewer's script reads the servers from. */
  file: string;
  log: Logger;
  now?: () => number;
}

/** The share of a set's lifetime after which it is not handed out again. */
const FRESH = 0.75;
/** The lifetime of a set without TURN: how soon the server is asked again. */
export const STUN_ONLY_MS = 5 * 60_000;

export class TurnCache {
  private deps: TurnCacheDeps;
  private held?: { grant: IceGrant; mintedAt: number };
  private minting?: Promise<IceGrant>;

  constructor(deps: TurnCacheDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** A set good for a while yet: the one held, or a new one. */
  async get(): Promise<IceGrant> {
    const held = this.held;
    if (held && this.now() < held.mintedAt + (held.grant.expiresAt - held.mintedAt) * FRESH) return held.grant;
    this.minting ??= this.mint().finally(() => {
      this.minting = undefined;
    });
    return this.minting;
  }

  private async mint(): Promise<IceGrant> {
    const mintedAt = this.now();
    let grant: IceGrant;
    try {
      grant = await this.deps.mint();
      this.deps.log.info("TURN credentials minted", { servers: grant.iceServers.length, expiresAt: grant.expiresAt });
    } catch (e) {
      const stun = this.deps.stun ?? [];
      grant = { iceServers: stun.length > 0 ? [{ urls: stun }] : [], expiresAt: mintedAt + STUN_ONLY_MS };
      this.deps.log.info("no TURN from the server: direct connections gather with STUN alone for now", { reason: e instanceof Error ? e.message : String(e) });
    }
    this.held = { grant, mintedAt };
    this.write(grant.iceServers);
    return grant;
  }

  private write(servers: IceServer[]): void {
    const file = this.deps.file;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp${process.pid}`;
      writeFileSync(tmp, JSON.stringify(servers.map((s) => ({ urls: Array.isArray(s.urls) ? s.urls : [s.urls], username: s.username ?? "", credential: s.credential ?? "" }))), { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (e) {
      this.deps.log.warn("could not write the ICE servers for the stream viewer", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Forgets the set held: direct connections went off, or the account did. */
  clear(): void {
    this.held = undefined;
    if (existsSync(this.deps.file)) rmSync(this.deps.file, { force: true });
  }
}
