// The host's settings, without a DOM: the rows the panel draws for each machine, harness and
// profile (the usual account and what Automatic would pick, sign-in state, usage, where a
// launch came from), what a save and a reset send, and the note a failure leaves beside
// what failed. Then the node's speech: the engine, its voice counted from 1, its status in
// words, what a pick and a reset send, and the second-by-second read while an engine loads.

import { describe, expect, test } from "bun:test";
import type { HarnessProfile, Node, VoiceSettings } from "@cophyla/protocol";
import { joinFlags, launchKey, SettingsModel, settingsRows, SPEECH_POLL_MS, speechRow, splitFlags, usageText, usualKey } from "../src/settings.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LAPTOP = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const node = (id: string, name: string): Node => ({
  id,
  name,
  role: "primary",
  status: "online",
  via: "direct",
  platform: "windows",
  scope: { kind: "machine" },
  capabilities: { harnesses: ["claude"], voice: { wake: false, stt: false, tts: false }, remote: false, brain: false },
  versions: { platform: "0.8.0", protocol: 1 },
  lastSeen: 1,
});

const profile = (id: string, over: Partial<HarnessProfile> = {}): HarnessProfile => ({ id, node: DESK, harness: "claude", name: id, configDir: `C:/${id}`, env: {}, origin: "user", status: "ok", ...over });

const PROFILES: HarnessProfile[] = [
  profile("prof_home", { name: "home", origin: "discovered", default: true, defaultBy: "recent", automatic: "recent", launch: { mode: "auto", args: ["--settings", "C:/Users/me/.claude/settings.json"], source: "mirrored", at: 1000 } }),
  profile("prof_work", { name: "work", launch: { args: ["--effort", "high"], source: "config" } }),
  profile("prof_codex", { name: "default", harness: "codex", origin: "discovered", default: true, defaultBy: "discovered", automatic: "discovered" }),
  profile("prof_far", { node: LAPTOP, name: "far", status: "unauthenticated", default: true, defaultBy: "discovered", automatic: "discovered" }),
];

const time = (at: number) => `t${at}`;

describe("settings rows", () => {
  test("a machine each by name, Claude before Codex; the usual account, what Automatic picks and why, sign-in, usage and each launch's source", () => {
    const rows = settingsRows({ nodes: [node(DESK, "desk"), node(LAPTOP, "air")], profiles: PROFILES, limits: { prof_home: { at: 1, session: { percent: 41.4 }, weekly: { percent: 93 } } }, now: 2000, time });
    expect(rows.map((m) => m.name)).toEqual(["air", "desk"]);
    const desk = rows[1]!;
    expect(desk.harnesses.map((h) => h.label)).toEqual(["Claude", "Codex"]);
    const claude = desk.harnesses[0]!;
    expect(claude.usual).toMatchObject({ key: usualKey(DESK, "claude"), value: "" });
    expect(claude.usual.options).toEqual([
      { value: "", label: "Automatic (home, your latest session's)" },
      { value: "prof_home", label: "home" },
      { value: "prof_work", label: "work" },
    ]);
    const [home, work] = claude.profiles;
    expect(home).toMatchObject({ name: "home", signedIn: "Signed in", usage: "Session 41% · Week 93%", usual: true });
    expect(home!.launch).toMatchObject({ mode: "auto", flags: "--settings C:/Users/me/.claude/settings.json", source: "Mirrored from your own session at t1000.", reset: false, dirty: false });
    expect(work).toMatchObject({ usage: "Usage not known", usual: false });
    expect(work!.launch).toMatchObject({ mode: "", flags: "--effort high", source: "From config.toml ([[profiles]] args)." });
    // Codex has usage and the usual account, no launch.
    expect(desk.harnesses[1]!.profiles[0]!.launch).toBeUndefined();
    // Another machine's signed-out profile says so in the choice.
    expect(rows[0]!.harnesses[0]!.usual.options[1]).toEqual({ value: "prof_far", label: "far (not signed in)" });
    expect(rows[0]!.harnesses[0]!.profiles[0]!.signedIn).toBe("Not signed in");
  });

  test("Muse comes after Claude and Codex, with its usual account and usage and no launch", () => {
    const muse = profile("prof_muse", { name: "default", harness: "muse", origin: "discovered", default: true, defaultBy: "discovered", automatic: "discovered" });
    const rows = settingsRows({ nodes: [node(DESK, "desk")], profiles: [muse, ...PROFILES.filter((p) => p.node === DESK)], limits: { prof_muse: { at: 1, session: { percent: 12 }, weekly: { percent: 3 } } }, now: 2000, time });
    expect(rows[0]!.harnesses.map((h) => h.label)).toEqual(["Claude", "Codex", "Muse"]);
    const section = rows[0]!.harnesses[2]!;
    expect(section.usual).toMatchObject({ key: usualKey(DESK, "muse"), value: "" });
    expect(section.profiles[0]).toMatchObject({ name: "default", signedIn: "Signed in", usage: "Session 12% · Week 3%", usual: true });
    expect(section.profiles[0]!.launch).toBeUndefined();
  });

  test("a profile picked in the app is the choice; one with nothing set says where a launch will come from; a draft shows and is dirty only when it differs", () => {
    const picked = PROFILES.map((p) => (p.id === "prof_work" ? { ...p, default: true, defaultBy: "you" as const, launch: { mode: "plan" as const, args: [], source: "you" as const } } : p.id === "prof_home" ? { ...p, default: undefined, defaultBy: undefined } : p));
    const bare = { ...PROFILES[0]!, launch: undefined };
    const drafts = new Map([
      ["prof_work", { mode: "plan", flags: "" }],
      ["prof_home", { mode: "", flags: "--effort low" }],
    ]);
    const rows = settingsRows({ nodes: [], profiles: [...picked.filter((p) => p.id !== "prof_home"), bare], limits: {}, drafts, now: 2000, time });
    const claude = rows[0]!.harnesses[0]!;
    expect(rows[0]!.name).toBe(DESK);
    expect(claude.usual.value).toBe("prof_work");
    const work = claude.profiles.find((p) => p.id === "prof_work")!.launch!;
    expect(work).toMatchObject({ source: "Set here.", reset: true, dirty: false });
    const home = claude.profiles.find((p) => p.id === "prof_home")!.launch!;
    expect(home).toMatchObject({ flags: "--effort low", dirty: true });
    expect(home.source).toBe("Nothing set: sessions start as this profile's own settings say. Start one yourself and its flags are used.");
  });

  test("a mode the list does not name is kept as a choice", () => {
    const rows = settingsRows({ nodes: [], profiles: [profile("p", { launch: { mode: "dontAsk", args: [], source: "mirrored" } })], limits: {}, now: 1, time });
    expect(rows[0]!.harnesses[0]!.profiles[0]!.launch!.extraMode).toEqual({ value: "dontAsk", label: "Don't ask" });
  });

  test("usage reads each window it has", () => {
    expect(usageText(undefined)).toBe("Usage not known");
    expect(usageText({ at: 1 })).toBe("Usage not known");
    expect(usageText({ at: 1, weekly: { percent: 7.6 } })).toBe("Week 8%");
  });

  test("flags split as a shell splits them, and join back to the same words", () => {
    const words = ["--add-dir", "C:\\My Code", "--append-system-prompt", 'be "brief"', "--effort", "high", "C:\\plain", "C:\\my dir\\", 'a\\"b', "a\\\\b c", ""];
    expect(splitFlags(joinFlags(words))).toEqual(words);
    // A Windows path shows as it is typed.
    expect(joinFlags(["--add-dir", "C:\\My Code"])).toBe('--add-dir "C:\\My Code"');
    expect(splitFlags(`--a 'x y' --b\\ c --c C:\\dir`)).toEqual(["--a", "x y", "--b c", "--c", "C:\\dir"]);
    expect(splitFlags("   ")).toEqual([]);
  });
});

/** A connection that answers from handlers and records what it was asked. */
function fakeConnection(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    asked.push({ method, params: params as Record<string, unknown> });
    const h = handlers[method];
    if (!h) throw new Error(`no ${method}`);
    return h(params as Record<string, unknown>) as T;
  };
  return { request, asked };
}

describe("the settings model", () => {
  test("loads the profiles, the machines and then the limits; a failed limits read leaves usage unknown", async () => {
    const { request, asked } = fakeConnection({
      "profile.list": () => ({ profiles: PROFILES }),
      "node.list": () => ({ nodes: [node(DESK, "desk")] }),
      "profile.limits": () => {
        throw new Error("slow");
      },
    });
    let draws = 0;
    const m = new SettingsModel(request, () => draws++);
    await m.load();
    expect(asked.map((a) => a.method)).toEqual(["profile.list", "node.list", "profile.limits"]);
    expect(m.note).toBe("");
    expect(m.limits).toEqual({});
    expect(draws).toBeGreaterThanOrEqual(3);
  });

  test("a save sends the draft's mode and split flags; a reset sends null; the usual account goes out and the list is read again", async () => {
    let profiles = PROFILES;
    const { request, asked } = fakeConnection({
      "profile.list": () => ({ profiles }),
      "node.list": () => ({ nodes: [] }),
      "profile.limits": () => ({ limits: {} }),
      "profile.update": (p) => ({ profile: { ...profiles.find((x) => x.id === p["id"])!, launch: { args: [], source: "you" } } }),
    });
    const m = new SettingsModel(request, () => {});
    await m.load();
    m.edit("prof_work", { mode: "bypassPermissions", flags: `--effort high --add-dir "C:\\My Code"` });
    const drawn: boolean[] = [];
    const watching = new SettingsModel(request, () => drawn.push(watching.drafts.has("prof_work")));
    watching.profiles = m.profiles;
    watching.edit("prof_work", { mode: "", flags: "--effort low" });
    await watching.saveLaunch("prof_work");
    // The last draw after a save shows the saved launch, not the draft.
    expect(drawn.at(-1)).toBe(false);
    await m.saveLaunch("prof_work");
    expect(asked.at(-1)).toEqual({ method: "profile.update", params: { node: DESK, id: "prof_work", patch: { launch: { mode: "bypassPermissions", args: ["--effort", "high", "--add-dir", "C:\\My Code"] } } } });
    expect(m.drafts.has("prof_work")).toBe(false);
    await m.resetLaunch("prof_work");
    expect(asked.at(-1)!.params).toEqual({ node: DESK, id: "prof_work", patch: { launch: null } });
    // Picking a profile, then Automatic again: the picked one is let go.
    await m.setUsual(DESK, "claude", "prof_work");
    expect(asked.at(-2)!.params).toEqual({ node: DESK, id: "prof_work", patch: { usual: true } });
    expect(asked.at(-1)!.method).toBe("profile.list");
    profiles = profiles.map((p) => (p.id === "prof_work" ? { ...p, defaultBy: "you" } : p));
    m.profiles = profiles;
    await m.setUsual(DESK, "claude", "");
    expect(asked.at(-2)!.params).toEqual({ node: DESK, id: "prof_work", patch: { usual: null } });
  });

  test("a failed save leaves a note beside it and keeps the draft; the next edit clears the note", async () => {
    const { request } = fakeConnection({
      "profile.list": () => ({ profiles: PROFILES }),
      "node.list": () => ({ nodes: [] }),
      "profile.limits": () => ({ limits: {} }),
      "profile.update": () => {
        throw new Error("--resume is cophylad's to set");
      },
    });
    const m = new SettingsModel(request, () => {});
    await m.load();
    m.edit("prof_home", { mode: "", flags: "--resume x" });
    await m.saveLaunch("prof_home");
    expect(m.notes.get(launchKey("prof_home"))).toBe("Not saved: --resume is cophylad's to set");
    expect(m.drafts.get("prof_home")).toEqual({ mode: "", flags: "--resume x" });
    const row = m.sections(2000, time)[0]!.harnesses[0]!.profiles.find((p) => p.id === "prof_home")!.launch!;
    expect(row).toMatchObject({ note: "Not saved: --resume is cophylad's to set", flags: "--resume x", dirty: true, busy: false });
    m.edit("prof_home", { mode: "", flags: "--effort low" });
    expect(m.notes.has(launchKey("prof_home"))).toBe(false);
  });

  test("the profiles that cannot be read say so where the list would be", async () => {
    const { request } = fakeConnection({ "node.list": () => ({ nodes: [] }) });
    const m = new SettingsModel(request, () => {});
    await m.load();
    expect(m.note).toBe("The agents' settings could not be read: no profile.list");
    expect(m.sections()).toEqual([]);
  });
});

const ENGINES: VoiceSettings["engines"] = [
  { id: "piper", label: "Piper", detail: "The fastest." },
  { id: "kokoro", label: "Kokoro", detail: "Sounds the most natural." },
  { id: "chatterbox", label: "Chatterbox", detail: "Your own voice." },
  { id: "off", label: "Off", detail: "Replies are shown, not spoken." },
];
const speech = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({ enabled: true, tts: "piper", source: "config", voice: 0, voices: 904, stage: { status: "ready", engine: "piper" }, engines: ENGINES, ...over });

describe("the node's speech", () => {
  test("the row: the engine, its voice from 1, its status in words, and where the choice came from", () => {
    expect(speechRow(speech())).toMatchObject({ engine: "piper", voice: 1, voices: 904, status: "Piper is ready.", trouble: false, canPreview: true, source: "From config.toml.", reset: false, detail: "The fastest." });
    expect(speechRow(speech({ tts: "kokoro", source: "app", voice: 3, voices: 11, stage: { status: "loading", engine: "kokoro" } }))).toMatchObject({ status: "Loading Kokoro…", canPreview: false, voice: 4, source: "Picked here.", reset: true });
    expect(speechRow(speech({ tts: "chatterbox", stage: { status: "loading" } })).status).toContain("the first time takes several minutes");
    expect(speechRow(speech({ tts: "chatterbox", voices: 1, stage: { status: "unavailable", reason: "no GPU" } }))).toMatchObject({ status: "Chatterbox cannot speak: no GPU", trouble: true, canPreview: false });
    // One voice is no choice: the number is not shown.
    expect(speechRow(speech({ tts: "chatterbox", voices: 1 })).voices).toBeUndefined();
    expect(speechRow(speech({ tts: "off", stage: { status: "off" } }))).toMatchObject({ status: "Replies are not spoken.", canPreview: false });
    expect(speechRow(speech({ enabled: false }))).toMatchObject({ trouble: true, canPreview: false });
    expect(speechRow(speech({ enabled: false })).status).toContain("config.toml");
  });

  test("a pick sends the engine, a voice goes out counted from 0, and a reset hands both back", async () => {
    let now = speech();
    const { request, asked } = fakeConnection({
      "voice.settings": () => now,
      "voice.configure": (p) => {
        now = { ...now, ...(p["tts"] ? { tts: p["tts"] as VoiceSettings["tts"], source: "app" as const } : {}), ...(typeof p["voice"] === "number" ? { voice: p["voice"] } : {}) };
        return now;
      },
    });
    const m = new SettingsModel(request, () => {});
    await m.loadSpeech();
    expect(m.speechRow()?.engine).toBe("piper");
    await m.setEngine("kokoro");
    expect(asked.at(-1)).toEqual({ method: "voice.configure", params: { tts: "kokoro" } });
    await m.setVoice(5);
    expect(asked.at(-1)).toEqual({ method: "voice.configure", params: { voice: 4 } });
    // The voice already set, one out of range, and nothing at all send nothing.
    const before = asked.length;
    await m.setVoice(5);
    await m.setVoice(0);
    await m.setVoice(905);
    await m.setVoice(Number.NaN);
    expect(asked.length).toBe(before);
    await m.setEngine(null);
    expect(asked.at(-1)).toEqual({ method: "voice.configure", params: { tts: null, voice: null } });
    m.dispose();
  });

  test("while an engine loads the model asks again each second, and stops when the panel closes", async () => {
    let reads = 0;
    const { request } = fakeConnection({
      "voice.settings": () => {
        reads++;
        return speech({ tts: "kokoro", stage: reads >= 2 ? { status: "ready", engine: "kokoro" } : { status: "loading", engine: "kokoro" } });
      },
    });
    const m = new SettingsModel(request, () => {});
    await m.loadSpeech();
    expect(m.speechRow()?.status).toBe("Loading Kokoro…");
    await new Promise((r) => setTimeout(r, SPEECH_POLL_MS + 300));
    expect(m.speechRow()?.status).toBe("Kokoro is ready.");
    expect(reads).toBe(2);
    await new Promise((r) => setTimeout(r, SPEECH_POLL_MS + 200));
    expect(reads).toBe(2);

    let loading = 0;
    const slow = fakeConnection({ "voice.settings": () => (loading++, speech({ stage: { status: "loading", engine: "piper" } })) });
    const closed = new SettingsModel(slow.request, () => {});
    await closed.loadSpeech();
    closed.dispose();
    await new Promise((r) => setTimeout(r, SPEECH_POLL_MS + 200));
    expect(loading).toBe(1);
  }, 10_000);

  test("a node that cannot say leaves the part out; a failed pick or preview says so beside it", async () => {
    const none = new SettingsModel(fakeConnection({}).request, () => {});
    await none.loadSpeech();
    expect(none.speechRow()).toBeUndefined();

    const { request } = fakeConnection({
      "voice.settings": () => speech(),
      "voice.configure": () => {
        throw new Error("denied: voice.configure needs scope voice");
      },
      "voice.preview": () => {
        throw new Error("unavailable: speech is loading");
      },
    });
    const m = new SettingsModel(request, () => {});
    await m.loadSpeech();
    await m.setEngine("kokoro");
    expect(m.speechRow()).toMatchObject({ engine: "piper", busy: false, note: "Not saved: denied: voice.configure needs scope voice" });
    await m.preview();
    expect(m.speechRow()?.note).toBe("Could not play it: unavailable: speech is loading");
    m.dispose();
  });
});
