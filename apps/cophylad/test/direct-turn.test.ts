// TURN credentials on the node: one set minted and handed out until three quarters of its
// life, then the next ask mints again; asks at once share one mint; each set lands in the
// stream viewer's file in its own shape, owner-only, and switching off removes it. Without
// TURN from the server the set is STUN alone, for a while.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STUN_ONLY_MS, TurnCache } from "../src/direct/turn.ts";
import type { IceGrant } from "../src/direct/turn.ts";
import { silentLogger } from "../src/log.ts";
import { removeHome, tempHome } from "./helpers.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeHome(h);
});

describe("the TURN cache", () => {
  test("minted once, reused until three quarters of its life, then minted again; one mint for asks at once", async () => {
    const home = tempHome();
    homes.push(home);
    let now = 1_000_000;
    let n = 0;
    const mint = async (): Promise<IceGrant> => {
      n++;
      await Bun.sleep(5);
      return { iceServers: [{ urls: ["turn:turn.example.test:3478?transport=udp"], username: `user${n}`, credential: `secret${n}` }, { urls: "stun:stun.example.test:3478" }], expiresAt: now + 100_000 };
    };
    const file = join(home, "data", "remote", "ice-servers.json");
    const cache = new TurnCache({ mint, file, log: silentLogger, now: () => now });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(n).toBe(1);
    expect(a).toBe(b);
    now += 74_000;
    expect((await cache.get()).iceServers[0]!.username).toBe("user1");
    now += 2_000;
    expect((await cache.get()).iceServers[0]!.username).toBe("user2");
    expect(n).toBe(2);
    // the web viewer's shape: every entry has a list of urls and both fields, empty for STUN
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      { urls: ["turn:turn.example.test:3478?transport=udp"], username: "user2", credential: "secret2" },
      { urls: ["stun:stun.example.test:3478"], username: "", credential: "" },
    ]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    cache.clear();
    expect(existsSync(file)).toBe(false);
    await cache.get();
    expect(n).toBe(3);
  });

  test("no TURN from the server: STUN alone for a few minutes, written for the viewer too, then the server is asked again", async () => {
    const home = tempHome();
    homes.push(home);
    let now = 1_000_000;
    let fail = true;
    let asked = 0;
    const file = join(home, "ice.json");
    const cache = new TurnCache({
      mint: async () => {
        asked++;
        if (fail) throw new Error("TURN is not configured");
        return { iceServers: [{ urls: ["turn:turn.example.test:3478"], username: "u", credential: "c" }], expiresAt: now + 600_000 };
      },
      stun: ["stun:stun.example.test:3478", "stun:stun2.example.test:19302"],
      file,
      log: silentLogger,
      now: () => now,
    });
    const alone = { iceServers: [{ urls: ["stun:stun.example.test:3478", "stun:stun2.example.test:19302"] }], expiresAt: now + STUN_ONLY_MS };
    expect(await cache.get()).toEqual(alone);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ urls: ["stun:stun.example.test:3478", "stun:stun2.example.test:19302"], username: "", credential: "" }]);
    // held like a set of its own: no ask per phone
    now += STUN_ONLY_MS * 0.5;
    expect(await cache.get()).toEqual(alone);
    expect(asked).toBe(1);
    fail = false;
    now += STUN_ONLY_MS * 0.3;
    expect((await cache.get()).iceServers[0]!.username).toBe("u");
    expect(asked).toBe(2);
    // no STUN configured either: host candidates alone, never a refusal
    const bare = new TurnCache({ mint: () => Promise.reject(new Error("the server link is down")), file: join(home, "bare.json"), log: silentLogger });
    await expect(bare.get()).resolves.toMatchObject({ iceServers: [] });
  });
});
