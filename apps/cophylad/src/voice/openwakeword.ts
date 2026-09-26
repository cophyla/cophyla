// The wake word on the node: the openWakeWord sessions loaded from a model directory on
// onnxruntime-node — the two feature models and one keyword head per phrase — shared by every
// conversation, with the rolling state per stream in `@cophyla/wake`'s `WakePipeline`, which
// the phone runs too. The node listens for a controller that does not detect the word itself.
//
// The model's manifest lists its heads (`heads`) and may say, per head, the score it fires
// at, the scale it was trained at and the phrase it hears (`head_params`); the config picks
// which heads listen and may set the threshold and the scale over the manifest's.

import { basename, join } from "node:path";
import { WakePipeline } from "@cophyla/wake";
import type { Scale, WakeHead, WakeModels } from "@cophyla/wake";
import type { WakeHeadInfo, WakeModel } from "./engines.ts";
import { paramStrings, readVoiceManifest } from "./manifest.ts";
import type { VoiceManifest } from "./manifest.ts";
import { loadOrt } from "./runtime.ts";
import type { Ort } from "./runtime.ts";

export type { Scale } from "@cophyla/wake";

type Session = import("onnxruntime-node").InferenceSession;

const SESSION_OPTS = { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ["cpu"] } as const;

/** A head's threshold when neither the config nor the manifest names one: the stock head's. */
export const DEFAULT_THRESHOLD = 0.7;

export interface WakeLoadOptions {
  /** The heads to listen with, by file name; the manifest's first when absent. */
  heads?: readonly string[];
  /** One threshold for every head, or one per head by file name, over the manifest's. */
  threshold?: number | Record<string, number>;
  /** The scale every head was trained at, over the manifest's. */
  scale?: Scale;
}

/** "hey_phyla_v0.1.onnx" → "hey phyla": what a head hears, when the manifest does not say. */
export function phraseOf(file: string): string {
  return basename(file)
    .replace(/\.onnx$/i, "")
    .replace(/_v\d+(\.\d+)*$/i, "")
    .replace(/_/g, " ");
}

/** The heads a model directory would listen with under these options: the configured ones it has, each with its numbers. */
export function wakeHeads(manifest: VoiceManifest, opts: WakeLoadOptions = {}): { heads: WakeHeadInfo[]; missing: string[] } {
  const available = paramStrings(manifest, "heads");
  const wanted = opts.heads && opts.heads.length > 0 ? [...opts.heads] : available.slice(0, 1);
  // A manifest that lists no heads is taken at its word for whatever the config names.
  const present = available.length > 0 ? wanted.filter((h) => available.includes(h)) : wanted;
  const missing = wanted.filter((h) => !present.includes(h));
  const all = manifest.params["head_params"];
  const params = (head: string): Record<string, unknown> => {
    const p = typeof all === "object" && all !== null ? (all as Record<string, unknown>)[head] : undefined;
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  };
  const scaleOf = (v: unknown): Scale | undefined => (v === "unit" || v === "int16" ? v : undefined);
  const heads = present.map((name): WakeHeadInfo => {
    const p = params(name);
    const configured = typeof opts.threshold === "number" ? opts.threshold : opts.threshold?.[name];
    const own = typeof p["threshold"] === "number" && p["threshold"] >= 0 && p["threshold"] <= 1 ? p["threshold"] : undefined;
    return {
      name,
      threshold: configured ?? own ?? DEFAULT_THRESHOLD,
      scale: opts.scale ?? scaleOf(p["scale"]) ?? scaleOf(manifest.params["scale"]) ?? "int16",
      phrase: typeof p["phrase"] === "string" && p["phrase"] ? p["phrase"] : phraseOf(name),
    };
  });
  return { heads, missing };
}

export class OpenWakeWord implements WakeModel, WakeModels {
  readonly ort: Ort;
  readonly mel: Session;
  readonly emb: Session;
  readonly heads: (WakeHead & WakeHeadInfo & { session: Session })[];
  /** Configured heads the directory does not have, skipped. */
  readonly missing: string[];

  private constructor(ort: Ort, mel: Session, emb: Session, heads: (WakeHead & WakeHeadInfo & { session: Session })[], missing: string[]) {
    this.ort = ort;
    this.mel = mel;
    this.emb = emb;
    this.heads = heads;
    this.missing = missing;
  }

  /** The feature models and the configured heads the directory has; fails when it has none of them. */
  static async load(dir: string, opts: WakeLoadOptions = {}): Promise<OpenWakeWord> {
    const manifest = readVoiceManifest(dir);
    if (!manifest) throw new Error(`no voice manifest in ${dir}`);
    const melFile = typeof manifest.params["mel"] === "string" ? manifest.params["mel"] : "melspectrogram.onnx";
    const embFile = typeof manifest.params["embedding"] === "string" ? manifest.params["embedding"] : "embedding_model.onnx";
    const { heads, missing } = wakeHeads(manifest, opts);
    if (heads.length === 0) {
      const available = paramStrings(manifest, "heads");
      throw new Error(`${dir} has none of the wake heads ${missing.join(", ") || "(none named)"}${available.length ? `; it has ${available.join(", ")}` : ""}`);
    }
    const ort = await loadOrt();
    const create = (file: string) => ort.InferenceSession.create(join(dir, file), SESSION_OPTS as never);
    const [mel, emb, ...sessions] = await Promise.all([create(melFile), create(embFile), ...heads.map((h) => create(h.name))]);
    return new OpenWakeWord(
      ort,
      mel!,
      emb!,
      heads.map((h, i) => ({ ...h, session: sessions[i]! })),
      missing,
    );
  }

  stream(): WakePipeline {
    return new WakePipeline(this);
  }

  async close(): Promise<void> {
    await Promise.all([this.mel.release(), this.emb.release(), ...this.heads.map((h) => h.session.release())]).catch(() => {});
  }
}
