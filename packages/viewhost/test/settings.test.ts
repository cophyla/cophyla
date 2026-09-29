// The host's settings, without a DOM: the rows the panel draws for each machine, harness and
// profile (the usual account and what Automatic would pick, sign-in state, usage, where a
// launch came from), what a save and a reset send, and the note a failure leaves beside
// what failed. Then the node's speech: the engine, its voice counted from 1, its status in
// words, what a pick and a reset send, and the second-by-second read while an engine loads.
// Where an online engine goes first and the node's own keys: the choice under an online engine
// only, the key rows in words with only the last four, and what a route, a key and a clear send.
// Last, what Cophyla listens for: each listener's line, a Remove, and a node with none.

import { describe, expect, test } from "bun:test";
import type { HarnessProfile, Listener, Node, VoiceSettings } from "@cophyla/protocol";
import { joinFlags, keyRows, launchKey, listenerLine, megabytes, micOptions, ROUTE_CHOICES, SettingsModel, settingsRows, SPEECH_POLL_MS, SPEECH_SPEEDS, speechRow, splitFlags, sttRow, usageText, usualKey } from "../src/settings.ts";

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

const GPL = { covers: "espeak-ng, built into the runtime", name: "GPL-3.0", url: "https://github.com/espeak-ng/espeak-ng/blob/master/COPYING" };
const ENGINES: VoiceSettings["engines"] = [
  { id: "piper", stage: "tts", label: "Piper", detail: "The fastest.", local: true, installed: true, licences: [GPL] },
  { id: "kokoro", stage: "tts", label: "Kokoro", detail: "Sounds the most natural.", local: true, installed: false, bytes: 329_000_000, licences: [{ covers: "Kokoro 82M", name: "Apache-2.0", url: "https://huggingface.co/hexgrad/Kokoro-82M" }, GPL] },
  { id: "chatterbox", stage: "tts", label: "Chatterbox", detail: "Your own voice.", local: false },
  { id: "off", stage: "tts", label: "Off", detail: "Replies are shown, not spoken.", local: false },
  { id: "nemotron", stage: "stt", label: "Nemotron", detail: "On this computer.", local: true, installed: false, bytes: 484_000_000, licences: [GPL] },
  { id: "server", stage: "stt", label: "Hosted", detail: "Your account's.", local: false },
  { id: "off", stage: "stt", label: "Off", detail: "Nothing is transcribed.", local: false },
];
/** The same, with Kokoro installed. */
const KOKORO_IN = ENGINES.map((e) => (e.id === "kokoro" ? { ...e, installed: true } : e));
const speech = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({
  enabled: true,
  tts: "piper",
  source: "config",
  voice: 0,
  voices: 904,
  speed: 1,
  stage: { status: "ready", engine: "piper" },
  stt: "server",
  sttSource: "config",
  sttStage: { status: "ready", engine: "server" },
  engines: ENGINES,
  ...over,
});

describe("the node's speech", () => {
  test("the row: the engine, its voice from 1, its status in words, and where the choice came from", () => {
    expect(speechRow(speech())).toMatchObject({ engine: "piper", voice: 1, voices: 904, status: "Piper is ready.", trouble: false, canPreview: true, source: "From config.toml.", reset: false, detail: "The fastest." });
    expect(speechRow(speech({ tts: "kokoro", source: "app", voice: 3, voices: 11, stage: { status: "loading", engine: "kokoro" }, engines: KOKORO_IN }))).toMatchObject({ status: "Loading Kokoro…", canPreview: false, voice: 4, source: "Picked here.", reset: true });
    expect(speechRow(speech({ tts: "chatterbox", stage: { status: "loading" } })).status).toContain("the first time takes several minutes");
    expect(speechRow(speech({ tts: "chatterbox", voices: 1, stage: { status: "unavailable", reason: "no GPU" } }))).toMatchObject({ status: "Chatterbox cannot speak: no GPU", trouble: true, canPreview: false });
    // One voice is no choice: the number is not shown.
    expect(speechRow(speech({ tts: "chatterbox", voices: 1 })).voices).toBeUndefined();
    expect(speechRow(speech({ tts: "off", stage: { status: "off" } }))).toMatchObject({ status: "Replies are not spoken.", canPreview: false });
    expect(speechRow(speech({ enabled: false }))).toMatchObject({ trouble: true, canPreview: false });
    expect(speechRow(speech({ enabled: false })).status).toContain("config.toml");
  });

  test("the speed: every one offered, one set some other way among them, and none where nothing is read out", () => {
    const row = speechRow(speech());
    expect(row.speed).toBe(1);
    expect(row.speeds!.map((o) => o.label)).toEqual(["0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×", "2.5×"]);
    expect(row.speeds!.map((o) => Number(o.value))).toEqual(SPEECH_SPEEDS);
    expect(speechRow(speech({ speed: 3 })).speeds!.map((o) => o.label).slice(-2)).toEqual(["2.5×", "3×"]);
    expect(speechRow(speech({ speed: 1.1 })).speeds!.map((o) => o.value).slice(0, 3)).toEqual(["0.75", "1", "1.1"]);
    // Every engine reads at it, whatever its voices: Chatterbox has one.
    expect(speechRow(speech({ tts: "chatterbox", voices: 1, speed: 2 }))).toMatchObject({ speed: 2 });
    expect(speechRow(speech({ tts: "off", stage: { status: "off" } })).speeds).toBeUndefined();
    expect(speechRow(speech({ enabled: false })).speeds).toBeUndefined();
    expect(sttRow(speech()).speeds).toBeUndefined();
    const { speed: _, ...old } = speech();
    expect(speechRow(old as VoiceSettings).speeds).toBeUndefined();
  });

  test("a speed goes out as it is, and the one set already, or none, sends nothing", async () => {
    let now = speech();
    const { request, asked } = fakeConnection({
      "voice.settings": () => now,
      "voice.configure": (p) => (now = { ...now, speed: p["speed"] as number }),
    });
    const m = new SettingsModel(request, () => {});
    await m.loadSpeech();
    await m.setSpeed(2);
    expect(asked.at(-1)).toEqual({ method: "voice.configure", params: { speed: 2 } });
    expect(m.speechRow()?.speed).toBe(2);
    const before = asked.length;
    await m.setSpeed(2);
    await m.setSpeed(Number.NaN);
    expect(asked.length).toBe(before);
    m.dispose();
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
        return speech({ tts: "kokoro", engines: KOKORO_IN, stage: reads >= 2 ? { status: "ready", engine: "kokoro" } : { status: "loading", engine: "kokoro" } });
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

  test("an engine not installed says so, lists what it comes under, and offers the install with its size; one not local offers none", () => {
    const row = speechRow(speech({ tts: "kokoro", source: "app", stage: { status: "uninstalled", engine: "kokoro" } }));
    expect(row).toMatchObject({ status: "Kokoro is not installed on this computer.", trouble: false, canPreview: false });
    expect(row.install).toEqual({ licences: ENGINES[1]!.licences!, bytes: 329_000_000 });
    expect(row.options.find((o) => o.value === "kokoro")!.label).toBe("Kokoro (not installed)");
    expect(megabytes(329_000_000)).toBe("329 MB");
    expect(speechRow(speech()).install).toBeUndefined();
    expect(speechRow(speech({ tts: "chatterbox", stage: { status: "loading", engine: "chatterbox" } })).install).toBeUndefined();
    // While it installs the row says how far, and every control waits; a failed one says why.
    const installing = speechRow(speech({ tts: "kokoro", stage: { status: "uninstalled" }, installing: { engine: "kokoro", step: "model", progress: 0.421 } }));
    expect(installing).toMatchObject({ busy: true, install: { progress: "Installing Kokoro: the model, 42%" } });
    expect(speechRow(speech({ tts: "kokoro", stage: { status: "uninstalled" }, installError: { engine: "kokoro", message: "sha256 mismatch" } })).install!.error).toBe("The install failed: sha256 mismatch");
  });

  test("the transcription row: its engines only, not installed or ready, and hosted needing nothing", () => {
    expect(sttRow(speech())).toMatchObject({ stage: "stt", engine: "server", status: "Hosted is ready.", canPreview: false, source: "From config.toml." });
    expect(sttRow(speech()).options.map((o) => o.value)).toEqual(["nemotron", "server", "off"]);
    expect(sttRow(speech()).voices).toBeUndefined();
    const local = sttRow(speech({ stt: "nemotron", sttSource: "app", sttStage: { status: "uninstalled", engine: "nemotron" } }));
    expect(local).toMatchObject({ status: "Nemotron is not installed on this computer.", reset: true, install: { bytes: 484_000_000 } });
    expect(sttRow(speech({ stt: "off", sttStage: { status: "off" } })).status).toBe("Nothing is transcribed.");
  });

  test("an install goes out for the engine picked, and the model asks again until it is in", async () => {
    let now = speech({ tts: "kokoro", source: "app", stage: { status: "uninstalled", engine: "kokoro" } });
    let reads = 0;
    const { request, asked } = fakeConnection({
      "voice.settings": () => {
        reads++;
        // Two reads into the install it is in, and the engine loads.
        if (reads >= 2) now = { ...now, installing: undefined, engines: ENGINES.map((e) => (e.id === "kokoro" ? { ...e, installed: true } : e)), stage: { status: "ready", engine: "kokoro" } };
        return now;
      },
      "voice.install": (p) => {
        now = { ...now, installing: { engine: String(p["engine"]), step: "runtime", progress: 0 } };
        return now;
      },
      "voice.configure": (p) => ({ ...now, stt: p["stt"] as VoiceSettings["stt"], sttSource: "app" as const }),
    });
    const m = new SettingsModel(request, () => {});
    await m.loadSpeech();
    await m.install("kokoro", "tts");
    expect(asked.at(-1)).toEqual({ method: "voice.install", params: { engine: "kokoro" } });
    expect(m.speechRow()!.install!.progress).toBe("Installing Kokoro: the runtime, 0%");
    await new Promise((r) => setTimeout(r, SPEECH_POLL_MS * 2 + 400));
    expect(m.speechRow()).toMatchObject({ status: "Kokoro is ready." });
    expect(m.speechRow()!.install).toBeUndefined();
    await m.setStt("server");
    expect(asked.at(-1)).toEqual({ method: "voice.configure", params: { stt: "server" } });
    m.dispose();
  }, 10_000);

  test("a node from before transcription could be picked still shows its speech engines, and no transcription row", async () => {
    const old = { enabled: true, tts: "piper", source: "config", voice: 0, voices: 904, stage: { status: "ready", engine: "piper" }, engines: [{ id: "piper", label: "Piper", detail: "The fastest." }, { id: "kokoro", label: "Kokoro", detail: "Natural." }] };
    const m = new SettingsModel(fakeConnection({ "voice.settings": () => old }).request, () => {});
    await m.loadSpeech();
    expect(m.speechRow()).toMatchObject({ engine: "piper", status: "Piper is ready." });
    expect(m.speechRow()!.options.map((o) => o.value)).toEqual(["piper", "kokoro"]);
    expect(m.sttRow()).toBeUndefined();
    m.dispose();
  });

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

const ONLINE: VoiceSettings["engines"] = [
  ...ENGINES,
  { id: "kokoro-online", stage: "tts", label: "Kokoro online", detail: "Online.", local: false },
  { id: "gemini-live", stage: "stt", label: "Gemini Live", detail: "Words as you speak.", local: false },
  { id: "gemini", stage: "stt", label: "Gemini Flash-Lite", detail: "Once you stop.", local: false },
];
const KEYS: NonNullable<VoiceSettings["keys"]> = { gemini: { source: "app", last4: "x9Qa" }, deepinfra: { source: "none" } };
const online = (over: Partial<VoiceSettings> = {}): VoiceSettings => speech({ engines: ONLINE, stt: "gemini-live", sttStage: { status: "ready", engine: "gemini-live" }, tts: "kokoro-online", stage: { status: "ready", engine: "kokoro-online" }, keys: KEYS, ...over });

describe("routes and keys", () => {
  test("an online engine offers where it goes, Cophyla cloud unless set; one on this computer, and a node that cannot say, offer none", () => {
    const stt = sttRow(online());
    expect(stt.route).toMatchObject({ value: "cloud", options: [...ROUTE_CHOICES], trouble: false });
    expect(stt.route!.detail).toBe("Through your account's server on a Pro plan; your own Gemini key when the server cannot.");
    expect(sttRow(online({ stt: "gemini" })).route?.value).toBe("cloud");
    expect(sttRow(online({ sttRoute: "own" })).route).toMatchObject({ value: "own", trouble: false, detail: "Straight to Gemini with your own key, never through Cophyla's server." });
    // Speech goes to DeepInfra, which has no key here: the own route cannot work and says so.
    expect(speechRow(online({ ttsRoute: "own" })).route).toMatchObject({ value: "own", trouble: true, detail: "Your own DeepInfra key is needed: give one below." });
    expect(speechRow(online()).route!.detail).toBe("Through your account's server on a Pro plan; without one, your own DeepInfra key is needed.");
    expect(sttRow(online({ stt: "nemotron", sttStage: { status: "ready", engine: "nemotron" } })).route).toBeUndefined();
    expect(speechRow(online({ tts: "piper", stage: { status: "ready", engine: "piper" } })).route).toBeUndefined();
    expect(sttRow(online({ stt: "off", sttStage: { status: "off" } })).route).toBeUndefined();
    const { keys: _, ...old } = online();
    expect(sttRow(old as VoiceSettings).route).toBeUndefined();
  });

  test("a key row says where the key comes from and how it ends, never more; only one given here can be cleared", () => {
    const rows = keyRows(online({ keys: { gemini: { source: "app", last4: "x9Qa" }, deepinfra: { source: "env", last4: "3f9a" } } }));
    expect(rows.map((r) => [r.provider, r.label, r.status, r.clearable])).toEqual([
      ["gemini", "Gemini key", "Set here, ending ••••x9Qa.", true],
      ["deepinfra", "DeepInfra key", "From DEEPINFRA_API_KEY in the environment, ending ••••3f9a.", false],
    ]);
    expect(keyRows(online({ keys: { gemini: { source: "config" }, deepinfra: { source: "none" } } })).map((r) => r.status)).toEqual(["From config.toml.", "No key."]);
    expect(keyRows(speech())).toEqual([]);
  });

  test("a route goes out as voice.configure, and the one in place sends nothing", async () => {
    let now = online();
    const { request, asked } = fakeConnection({
      "voice.settings": () => now,
      "voice.configure": (p) => (now = { ...now, ...(p["sttRoute"] ? { sttRoute: p["sttRoute"] as "own" } : {}), ...(p["ttsRoute"] ? { ttsRoute: p["ttsRoute"] as "own" } : {}) }),
    });
    const m = new SettingsModel(request, () => {});
    await m.loadSpeech();
    await m.setRoute("stt", "cloud");
    expect(asked.length).toBe(1);
    await m.setRoute("stt", "own");
    expect(asked.at(-1)).toEqual({ method: "voice.configure", params: { sttRoute: "own" } });
    expect(m.sttRow()!.route!.value).toBe("own");
    await m.setRoute("tts", "own");
    expect(asked.at(-1)).toEqual({ method: "voice.configure", params: { ttsRoute: "own" } });
    m.dispose();
  });

  test("a key goes out trimmed as account.apiKey and the row shows the answer's last four; a clear sends null; empty sends nothing; a refusal says so", async () => {
    const typed = "  AIzaSyD-a-long-example-key-Zq7w  ";
    let fail = false;
    const { request, asked } = fakeConnection({
      "voice.settings": () => online(),
      "account.apiKey": (p) => {
        if (fail) throw new Error("invalid: account.apiKey: apiKey: too short");
        const key = p["apiKey"] as string | null;
        return { ...KEYS, deepinfra: key === null ? { source: "none" } : { source: "app", last4: key.slice(-4) } };
      },
    });
    const m = new SettingsModel(request, () => {});
    await m.loadSpeech();
    expect(await m.setKey("deepinfra", typed)).toBe(true);
    expect(asked.at(-1)).toEqual({ method: "account.apiKey", params: { provider: "deepinfra", apiKey: typed.trim() } });
    expect(m.keyRows()[1]).toMatchObject({ status: "Set here, ending ••••Zq7w.", clearable: true, busy: false });
    // What the panel draws holds the last four and nothing more of the key.
    expect(JSON.stringify(m.keyRows())).not.toContain("a-long-example");
    expect(JSON.stringify(m.speechRow())).not.toContain("a-long-example");
    const before = asked.length;
    expect(await m.setKey("gemini", "   ")).toBe(false);
    expect(asked.length).toBe(before);
    expect(await m.setKey("deepinfra", null)).toBe(true);
    expect(asked.at(-1)).toEqual({ method: "account.apiKey", params: { provider: "deepinfra", apiKey: null } });
    expect(m.keyRows()[1]).toMatchObject({ status: "No key.", clearable: false });
    fail = true;
    expect(await m.setKey("gemini", "short")).toBe(false);
    expect(m.keyRows()[0]!.note).toBe("Not saved: invalid: account.apiKey: apiKey: too short");
    m.dispose();
  });
});

describe("listening for", () => {
  const listener = (over: Partial<Listener> & Pick<Listener, "on">): Listener => ({ id: "lst_01ARZ3NDEKTSV4RRFFQ69G5FC1", deliver: "wake", why: "why", createdAt: 1, fired: 0, ...over });

  test("a listener's line: on what and for what, how it tells, the fires left and made", () => {
    expect(listenerLine(listener({ on: ["session.idle", "session.ask"], session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2", until: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", fired: 2 }))).toBe(
      "a session finishes or a session asks · session sess_…5FB2 · until task_…5FB2 is over · wakes Cophyla · until removed · fired twice",
    );
    expect(listenerLine(listener({ on: ["metric"], node: DESK, metric: { resource: "cpu", above: 90, forS: 10 }, deliver: "notify", times: 1 }))).toBe("CPU above 90% for 10 s · machine node_…5FAV · tells you in a line · 1 fire left · not fired yet");
    expect(listenerLine(listener({ on: ["custom"], name: "ci.failed", match: { branch: "main" }, deliver: "note", cooldownS: 30, times: 3, fired: 5 }))).toBe(
      'the event ci.failed · branch = "main" · a note for the next time you talk · at most once in 30 s · 3 fires left · fired 5 times',
    );
    expect(listenerLine(listener({ on: ["session.tool"], origin: "user", harness: "codex", tool: "Bash", fired: 1 }))).toBe("a session uses a tool · Codex · your sessions · tool Bash · wakes Cophyla · until removed · fired once");
  });

  test("the listeners are read, one is removed and the list read again, a failed removal says why, and a node that has none leaves the section out", async () => {
    let listeners = [listener({ on: ["node.pressure"] }), listener({ id: "lst_01ARZ3NDEKTSV4RRFFQ69G5FC2", on: ["session.said"] })];
    const { request, asked } = fakeConnection({
      "listener.list": () => ({ listeners }),
      "listener.remove": (p) => {
        if (p["id"] === "lst_01ARZ3NDEKTSV4RRFFQ69G5FC9") throw new Error("not_found: no listener lst_01ARZ3NDEKTSV4RRFFQ69G5FC9");
        listeners = listeners.filter((l) => l.id !== p["id"]);
        return {};
      },
    });
    const m = new SettingsModel(request, () => {});
    await m.loadListeners();
    expect(m.listeners?.map((l) => l.on)).toEqual([["node.pressure"], ["session.said"]]);
    await m.removeListener("lst_01ARZ3NDEKTSV4RRFFQ69G5FC1");
    expect(asked.map((a) => a.method)).toEqual(["listener.list", "listener.remove", "listener.list"]);
    expect(asked[1]!.params).toEqual({ id: "lst_01ARZ3NDEKTSV4RRFFQ69G5FC1" });
    expect(m.listeners?.map((l) => l.id)).toEqual(["lst_01ARZ3NDEKTSV4RRFFQ69G5FC2"]);
    expect(m.removing.size).toBe(0);
    await m.removeListener("lst_01ARZ3NDEKTSV4RRFFQ69G5FC9");
    expect(m.listenerNotes.get("lst_01ARZ3NDEKTSV4RRFFQ69G5FC9")).toBe("Not removed: not_found: no listener lst_01ARZ3NDEKTSV4RRFFQ69G5FC9");
    expect(asked).toHaveLength(4);
    const old = new SettingsModel(fakeConnection({}).request, () => {});
    await old.loadListeners();
    expect(old.listeners).toBeUndefined();
  });
});

describe("the microphone row", () => {
  const base = { listening: true, speak: true, talkKey: "", phrases: [], status: "" };
  const usb = { id: "usb-1", label: "Microphone (USB Advanced Audio Device)" };
  const brio = { id: "brio-1", label: "Microphone (Brio 101)" };

  test("the system's default comes first, named when the host knows it, then each device", () => {
    const { options, value } = micOptions({ ...base, mics: [usb, brio], defaultMic: usb.label });
    expect(options).toEqual([{ value: "", label: `System default (${usb.label})` }, { value: "usb-1", label: usb.label }, { value: "brio-1", label: brio.label }]);
    expect(value).toBe("");
    expect(micOptions({ ...base }).options).toEqual([{ value: "", label: "System default" }]);
  });

  test("a pick is selected by its id, or by its name when its id moved", () => {
    expect(micOptions({ ...base, mics: [usb, brio], micChoice: brio }).value).toBe("brio-1");
    expect(micOptions({ ...base, mics: [usb, brio], micChoice: { id: "brio-old", label: brio.label } }).value).toBe("brio-1");
  });

  test("a pick that is not connected stays listed, marked, so the choice still shows", () => {
    const { options, value } = micOptions({ ...base, mics: [brio], micChoice: usb });
    expect(options.at(-1)).toEqual({ value: "usb-1", label: `${usb.label} (not connected)` });
    expect(value).toBe("usb-1");
  });
});
