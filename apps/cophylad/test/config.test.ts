// config.toml: defaults, partial sections, the default file written on first run, errors.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, loadOrCreateToken, parseConfig, paths, readToken, resolveHome } from "../src/config/load.ts";
import { DEFAULT_CONFIG_TOML } from "../src/config/schema.ts";
import { tempHome } from "./helpers.ts";

describe("config", () => {
  test("an empty file is all defaults", () => {
    const c = parseConfig("");
    expect(c.node.role).toBe("primary");
    expect(c.node.scope).toEqual({ kind: "machine" });
    expect(c.api).toEqual({ host: "127.0.0.1", port: 4817 });
    expect(c.gate.audit_result_cap).toBe(65536);
    expect(c.gate.ask_timeout_ms).toBe(0);
    expect(c.gate.policy.user).toEqual({ read: "allow", write: "allow", exec: "allow", network: "allow" });
    expect(c.gate.policy.brain).toEqual({ read: "allow", write: "ask", exec: "ask", network: "ask" });
    expect(c.gate.rules).toEqual({});
    expect(c.sessions).toEqual({
      poll_ms: 2000,
      codex_list_ms: 10000,
      hook_timeout_s: 7200,
      receipt_timeout_ms: 30000,
      codex_recent_ms: 600000,
      muse_list_ms: 2000,
      muse_recent_ms: 600000,
      claude_hook_grace_ms: 600000,
      install_hooks: true,
      discover: true,
      launch: "terminal",
      brain_sends: "pipe",
    });
    expect(c.tether).toEqual({ idle_exit_s: 600, window: "auto", window_on_start: false, profiles: true, on_path: true });
    expect(c.profiles).toEqual([]);
    expect(c.store).toEqual({ embedding: "local", embed_batch: 8, embed_max_chars: 1536, vector_max_rows: 150000, backfill_batch: 200 });
    expect(c.editable).toEqual({ poll_ms: 10000 });
    expect(c.node.tz).toBeUndefined();
    // The phone listener and the microphone are both off until asked for: a fresh node does
    // not open a port on the LAN, and does not fetch a gigabyte of models.
    expect(c.controller).toEqual({ enabled: false, host: "0.0.0.0", port: 4818, account_pairing: true });
    expect(c.voice.enabled).toBe(false);
    expect(c.voice).toMatchObject({
      wake: "openwakeword",
      stt: "nemotron",
      tts: "piper",
      wake_model: ["cophyla_v0.1.onnx", "hey_phyla_v0.1.onnx"],
      vad_min_silence_ms: 700,
      stt_threads: 2,
      tts_threads: 2,
      chatterbox_device: "auto",
      cpu_affinity: "auto",
      thinking_timeout_ms: 60000,
    });
    // The two clips are optional: a reference voice is only Chatterbox's business.
    expect(c.voice.chatterbox_voice).toBeUndefined();
    expect(c.voice.models_dir).toBeUndefined();
    expect(c.voice.stt_language).toBeUndefined();
    // The voice is the model's own until one is picked.
    expect(c.voice.tts_voice).toBeUndefined();
    expect(c.controller.app_dir).toBeUndefined();
  });

  test("the node's zone must be one Intl knows; the editable poll may be off", () => {
    expect(parseConfig('[node]\ntz = "Europe/Istanbul"\n').node.tz).toBe("Europe/Istanbul");
    expect(() => parseConfig('[node]\ntz = "Mars/Olympus"\n')).toThrow(/node.tz/);
    expect(parseConfig("[editable]\npoll_ms = 0\n").editable.poll_ms).toBe(0);
    expect(() => parseConfig("[editable]\npoll_ms = -1\n")).toThrow(ConfigError);
  });

  test("the store section: embedding off, or another model directory", () => {
    expect(parseConfig('[store]\nembedding = "off"\n').store.embedding).toBe("off");
    const c = parseConfig('[store]\nembedding_model = "C:\\\\models\\\\other"\nembed_batch = 2\n');
    expect(c.store.embedding_model).toBe("C:\\models\\other");
    expect(c.store.embed_batch).toBe(2);
    expect(c.store.vector_max_rows).toBe(150000);
    expect(() => parseConfig('[store]\nembedding = "remote"\n')).toThrow(/store.embedding/);
    expect(() => parseConfig("[store]\nembed_batch = 0\n")).toThrow(/store.embed_batch/);
  });

  test("a declared profile keeps its defaults and the sessions section is partial", () => {
    const c = parseConfig('[sessions]\ninstall_hooks = false\n\n[[profiles]]\nharness = "claude"\nname = "work"\nconfig_dir = "C:\\\\Users\\\\me\\\\.claude-accounts\\\\work"\n\n[[profiles]]\nharness = "codex"\nname = "lab"\nconfig_dir = "C:\\\\lab"\ncommand = "C:\\\\lab\\\\codex.exe"\nargs = ["--profile", "x"]\nenv = { OPENAI_API_KEY = "k" }\ndefault = true\nhooks = "command"\n');
    expect(c.sessions.install_hooks).toBe(false);
    expect(c.sessions.poll_ms).toBe(2000);
    expect(c.profiles).toEqual([
      { harness: "claude", name: "work", config_dir: "C:\\Users\\me\\.claude-accounts\\work", args: [], env: {}, default: false, hooks: "http" },
      { harness: "codex", name: "lab", config_dir: "C:\\lab", command: "C:\\lab\\codex.exe", args: ["--profile", "x"], env: { OPENAI_API_KEY: "k" }, default: true, hooks: "command" },
    ]);
    expect(() => parseConfig('[[profiles]]\nharness = "acp"\nname = "x"\nconfig_dir = "y"\n')).toThrow(/profiles.0.harness/);
    expect(() => parseConfig('[[profiles]]\nharness = "claude"\nname = "x"\n')).toThrow(/profiles.0.config_dir/);
  });
  test("the controller listener and the voice stages take partial sections, and refuse nonsense", () => {
    const c = parseConfig('[controller]\nenabled = true\nport = 4897\n[voice]\nenabled = true\ntts = "chatterbox"\nchatterbox_voice = "C:\\\\clips\\\\me.wav"\n');
    expect(c.controller).toEqual({ enabled: true, host: "0.0.0.0", port: 4897, account_pairing: true });
    expect(c.voice.tts).toBe("chatterbox");
    expect(c.voice.chatterbox_voice).toBe("C:\\clips\\me.wav");
    // The stages that were not named keep their defaults.
    expect(c.voice.wake).toBe("openwakeword");
    expect(c.voice.stt).toBe("nemotron");
    // A stage can be turned off one at a time: hearing without speaking, or the reverse.
    expect(parseConfig('[voice]\nwake = "off"\ntts = "off"\n').voice).toMatchObject({ wake: "off", stt: "nemotron", tts: "off" });
    expect(() => parseConfig('[voice]\nstt = "whisper"\n')).toThrow(/voice.stt/);
    expect(() => parseConfig("[voice]\nwake_threshold = 1.5\n")).toThrow(/voice.wake_threshold/);
    // One head by name, as older configs say it, or a list; a threshold for all, or per head.
    expect(parseConfig('[voice]\nwake_model = "cophyla_v0.1.onnx"\n').voice.wake_model).toEqual(["cophyla_v0.1.onnx"]);
    expect(parseConfig('[voice]\nwake_model = ["a.onnx", "b.onnx"]\n').voice.wake_model).toEqual(["a.onnx", "b.onnx"]);
    expect(parseConfig('[voice]\nwake_threshold = { "b.onnx" = 0.55 }\n').voice.wake_threshold).toEqual({ "b.onnx": 0.55 });
    expect(() => parseConfig("[voice]\nwake_model = []\n")).toThrow(/voice.wake_model/);
    expect(() => parseConfig("[voice]\nstt_threads = 0\n")).toThrow(/voice.stt_threads/);
    expect(() => parseConfig("[controller]\nport = 70000\n")).toThrow(/controller.port/);
  });

  test("the CPU affinity is auto, off, or a list of cores", () => {
    for (const spec of ["auto", "off", "0-15", "0,1,2", "0-7,16,18-19"]) expect(parseConfig(`[voice]\ncpu_affinity = "${spec}"\n`).voice.cpu_affinity).toBe(spec);
    // Anything else is a typo, and a typo that silently pinned nothing would be a slow engine
    // nobody could explain.
    for (const bad of ["p-cores", "0..15", "all", ""]) expect(() => parseConfig(`[voice]\ncpu_affinity = "${bad}"\n`)).toThrow(/voice.cpu_affinity/);
  });

  test("the metrics section: defaults, the price table over the built-in one, critical above warn", () => {
    const c = parseConfig("");
    expect(c.metrics).toEqual({ enabled: true, idle_interval_ms: 15000, min_interval_ms: 1000, retention_days: 7, warn: 80, critical: 95, gpu: true, limits: true, prices: {} });
    const priced = parseConfig('[metrics]\nwarn = 50\ncritical = 60\n[metrics.prices."gemini/gemini-3.8-flash"]\ninput = 1.5\noutput = 7.5\ncache_read = 0.15\n');
    expect(priced.metrics.warn).toBe(50);
    expect(priced.metrics.critical).toBe(60);
    expect(priced.metrics.prices).toEqual({ "gemini/gemini-3.8-flash": { input: 1.5, output: 7.5, cache_read: 0.15 } });
    // A warn above critical would never say warn: refused, naming the field.
    expect(() => parseConfig("[metrics]\nwarn = 90\ncritical = 80\n")).toThrow(/metrics.critical/);
  });

  test("the nodes section: defaults, a primary endpoint that must be host:port, the backup rank", () => {
    const c = parseConfig("");
    expect(c.nodes).toEqual({
      accept: false,
      discovery: true,
      discovery_port: 4819,
      discovery_interval_ms: 2000,
      beacon_ms: 5000,
      heartbeat_ms: 5000,
      failover_ms: 15000,
      claim_wait_ms: 3000,
      reconnect_ms: 2000,
      reconnect_max_ms: 30000,
      hello_timeout_ms: 5000,
      relay: true,
      registry_heartbeat_ms: 15000,
    });
    expect(c.node.backup_rank).toBe(1);
    const s = parseConfig('[node]\nrole = "secondary"\nbackup = true\nbackup_rank = 2\n[nodes]\nprimary = "192.168.1.44:4818"\ntoken = "0123456789abcdef0123456789abcdef"\ndiscovery = false\n');
    expect(s.nodes.primary).toBe("192.168.1.44:4818");
    expect(s.nodes.token).toBe("0123456789abcdef0123456789abcdef");
    expect(s.node.backup_rank).toBe(2);
    expect(parseConfig('[nodes]\nprimary = "[fe80::1%eth0]:4818"\n').nodes.primary).toBe("[fe80::1%eth0]:4818");
    for (const bad of ["desk", "desk:", "http://desk:4818", "desk:port"]) expect(() => parseConfig(`[nodes]\nprimary = "${bad}"\n`)).toThrow(/nodes.primary/);
    expect(() => parseConfig("[node]\nbackup_rank = 0\n")).toThrow(/backup_rank/);
    // the token from before grants still parses, whatever its length, and is only read to say it is ignored
    expect(parseConfig('[nodes]\ntoken = "short"\n').nodes.token).toBe("short");
  });

  test("the remote section: off by default, the host kinds, the web transport, a positive width", () => {
    const c = parseConfig("");
    expect(c.remote).toEqual({ enabled: false, host: "auto", install: true, web: true, web_transport: "websocket", lan_route: true, screenshot_width: 1280, poll_ms: 3000 });
    const s = parseConfig('[remote]\nenabled = true\nhost = "sunshine"\ninstall = false\nhost_command = "/usr/bin/sunshine"\nhost_user = "me"\nhost_password = "pw"\nweb_transport = "webrtc"\nlan_route = false\nscreenshot_width = 640\n');
    expect(s.remote).toMatchObject({ enabled: true, host: "sunshine", install: false, host_command: "/usr/bin/sunshine", host_user: "me", host_password: "pw", web_transport: "webrtc", lan_route: false, screenshot_width: 640 });
    expect(() => parseConfig('[remote]\nhost = "rustdesk"\n')).toThrow(/remote.host/);
    expect(() => parseConfig('[remote]\nweb_transport = "udp"\n')).toThrow(/remote.web_transport/);
    expect(() => parseConfig("[remote]\nscreenshot_width = 0\n")).toThrow(/remote.screenshot_width/);
  });

  test("the direct section: a port kept by the helper, mapping and prediction on, public STUN servers, a bounded prediction", () => {
    const c = parseConfig("");
    expect(c.direct).toEqual({ port: 0, map_port: true, ipv6: true, predict: 12, nodes: true, report: true, stun: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"], restart_backoff_ms: 1000, restart_backoff_max_ms: 30000 });
    const s = parseConfig('[direct]\nport = 41641\nmap_port = false\nreport = false\nstun = ["stun:stun.example.test:3478"]\ncommand = "/opt/cophyla-net"\n');
    expect(s.direct).toMatchObject({ port: 41641, map_port: false, report: false, stun: ["stun:stun.example.test:3478"], command: "/opt/cophyla-net" });
    expect(() => parseConfig("[direct]\npredict = 65\n")).toThrow(/direct.predict/);
    expect(() => parseConfig("[direct]\nport = 70000\n")).toThrow(/direct.port/);
  });

  test("the shipped default file parses to the same defaults", () => {
    expect(parseConfig(DEFAULT_CONFIG_TOML)).toEqual(parseConfig(""));
  });

  test("a partial section keeps the other defaults", () => {
    const c = parseConfig('[gate.policy.brain]\nwrite = "allow"\n[node]\nrole = "secondary"\n[node.scope]\nkind = "workspaces"\npaths = ["C:\\\\src"]\n');
    expect(c.gate.policy.brain).toEqual({ read: "allow", write: "allow", exec: "ask", network: "ask" });
    expect(c.node.role).toBe("secondary");
    expect(c.node.scope).toEqual({ kind: "workspaces", paths: ["C:\\src"] });
    expect(c.api.port).toBe(4817);
  });

  test("a file with a byte-order mark is read as written, not as empty", () => {
    const c = parseConfig("\uFEFF[api]\nport = 4899\n\n[update]\nenabled = false\n");
    expect(c.api.port).toBe(4899);
    expect(c.update.enabled).toBe(false);
  });

  test("bad values are ConfigErrors that name the field", () => {
    expect(() => parseConfig('[api]\nport = 99999\n')).toThrow(ConfigError);
    expect(() => parseConfig('[gate.rules]\n"bogus" = "allow"\n')).toThrow(/gate.rules/);
    expect(() => parseConfig('[gate.policy.user]\nread = "maybe"\n')).toThrow(/gate.policy.user.read/);
    expect(() => parseConfig("this is not toml =")).toThrow(ConfigError);
  });

  test("the provider route is a list in order: one string is a list of one, the default is server then byok, a bad route is refused", () => {
    expect(parseConfig("").providers.llm).toEqual(["server", "byok:gemini"]);
    expect(parseConfig('[providers]\nllm = "byok:gemini"\n').providers.llm).toEqual(["byok:gemini"]);
    expect(parseConfig('[providers]\nllm = ["server"]\n').providers.llm).toEqual(["server"]);
    expect(parseConfig('[providers]\nllm = ["byok:gemini", "server", "local:llama"]\n').providers.llm).toEqual(["byok:gemini", "server", "local:llama"]);
    expect(() => parseConfig('[providers]\nllm = "openai"\n')).toThrow(/providers.llm/);
    expect(() => parseConfig('[providers]\nllm = ["server", "cloud"]\n')).toThrow(/providers.llm/);
    expect(() => parseConfig("[providers]\nllm = []\n")).toThrow(/providers.llm/);
  });

  test("the voice stages may be hosted, and the cloud section has its defaults", () => {
    const v = parseConfig('[voice]\nstt = "server"\ntts = "server"\n').voice;
    expect(v.stt).toBe("server");
    expect(v.tts).toBe("server");
    expect(() => parseConfig('[voice]\nstt = "cloud"\n')).toThrow(/voice.stt/);
    const c = parseConfig("").cloud;
    expect(c).toEqual({ enabled: true, url: "https://api.getcophyla.com", refresh_interval_ms: 21600000, reconnect_ms: 2000, reconnect_max_ms: 60000, request_timeout_ms: 120000, hello_timeout_ms: 15000, allow_insecure: false });
    expect(parseConfig('[cloud]\nenabled = false\nurl = "http://127.0.0.1:8099"\nrefresh_interval_ms = 60000\n').cloud).toMatchObject({ enabled: false, url: "http://127.0.0.1:8099", refresh_interval_ms: 60000, reconnect_ms: 2000 });
    expect(() => parseConfig('[cloud]\nurl = "not a url"\n')).toThrow(/cloud.url/);
    expect(() => parseConfig("[cloud]\nrefresh_interval_ms = 0\n")).toThrow(/cloud.refresh_interval_ms/);
  });

  test("a missing file is written with the commented defaults", () => {
    const home = tempHome();
    rmSync(join(home, "config.toml"));
    const p = paths(home);
    expect(existsSync(p.config)).toBe(false);
    const c = loadConfig(p);
    expect(existsSync(p.config)).toBe(true);
    expect(readFileSync(p.config, "utf8")).toBe(DEFAULT_CONFIG_TOML);
    expect(c).toEqual(parseConfig(""));
    rmSync(home, { recursive: true, force: true });
  });

  test("resolveHome honours an override, then COPHYLA_HOME, then ~/.cophyla", () => {
    const prev = process.env["COPHYLA_HOME"];
    process.env["COPHYLA_HOME"] = "C:\\tmp\\cophyla-env";
    expect(resolveHome("C:\\tmp\\cophyla-arg")).toMatch(/cophyla-arg$/);
    expect(resolveHome()).toMatch(/cophyla-env$/);
    delete process.env["COPHYLA_HOME"];
    expect(resolveHome()).toMatch(/[\\/]\.cophyla$/);
    if (prev !== undefined) process.env["COPHYLA_HOME"] = prev;
  });

  test("paths put everything under home", () => {
    const p = paths("C:\\home\\.cophyla");
    expect(p.db).toBe(join("C:\\home\\.cophyla", "data", "cophyla.sqlite"));
    expect(p.clientToken).toBe(join("C:\\home\\.cophyla", "data", "client.token"));
    expect(p.tools).toBe(join("C:\\home\\.cophyla", "tools"));
    expect(p.readme).toBe(join("C:\\home\\.cophyla", "README.md"));
    // What voice adds: the listener's certificate, the models the feed unpacks, and the
    // sidecar's own Python environment. All three are data, none is ever in a release.
    expect(p.tls).toBe(join("C:\\home\\.cophyla", "data", "tls"));
    expect(p.models).toBe(join("C:\\home\\.cophyla", "data", "models"));
    expect(p.sidecars).toBe(join("C:\\home\\.cophyla", "data", "sidecars"));
    // This node's membership of a cluster: its grant and key, minted for it alone.
    expect(p.linkFile).toBe(join("C:\\home\\.cophyla", "data", "link.json"));
  });

  test("a token file is minted once and read back; a short one is replaced", () => {
    const home = tempHome();
    const path = join(home, "t.token");
    const a = loadOrCreateToken(path);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateToken(path)).toBe(a);
    expect(readToken(path)).toBe(a);
    writeFileSync(path, "short\n");
    expect(readToken(path)).toBeUndefined();
    expect(loadOrCreateToken(path)).not.toBe("short");
    rmSync(home, { recursive: true, force: true });
  });
});
