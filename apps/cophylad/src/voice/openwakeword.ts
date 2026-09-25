// The wake word on the node: the three openWakeWord sessions loaded from a model directory
// on onnxruntime-node, shared by every conversation, with the rolling state per stream in
// `@cophyla/wake`'s `WakePipeline`, which the phone runs too. The node listens for a
// controller that does not detect the word itself.

import { join } from "node:path";
import { WakePipeline } from "@cophyla/wake";
import type { Scale, WakeModels } from "@cophyla/wake";
import type { WakeModel } from "./engines.ts";
import { paramStrings, readVoiceManifest } from "./manifest.ts";
import { loadOrt } from "./runtime.ts";
import type { Ort } from "./runtime.ts";

export type { Scale } from "@cophyla/wake";

type Session = import("onnxruntime-node").InferenceSession;

const SESSION_OPTS = { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ["cpu"] } as const;

export class OpenWakeWord implements WakeModel, WakeModels {
  readonly ort: Ort;
  readonly mel: Session;
  readonly emb: Session;
  readonly heads: { name: string; session: Session }[];
  readonly scale: Scale;

  private constructor(ort: Ort, mel: Session, emb: Session, heads: { name: string; session: Session }[], scale: Scale) {
    this.ort = ort;
    this.mel = mel;
    this.emb = emb;
    this.heads = heads;
    this.scale = scale;
  }

  /**
   * The feature models and one keyword head from a model directory. `head` names a file the
   * manifest lists under `heads`; the manifest's own scale is used unless one is given.
   */
  static async load(dir: string, opts: { head?: string; scale?: Scale } = {}): Promise<OpenWakeWord> {
    const manifest = readVoiceManifest(dir);
    if (!manifest) throw new Error(`no voice manifest in ${dir}`);
    const melFile = typeof manifest.params["mel"] === "string" ? manifest.params["mel"] : "melspectrogram.onnx";
    const embFile = typeof manifest.params["embedding"] === "string" ? manifest.params["embedding"] : "embedding_model.onnx";
    const available = paramStrings(manifest, "heads");
    const wanted = opts.head ?? available[0];
    if (!wanted) throw new Error(`${dir} lists no wake heads`);
    if (available.length > 0 && !available.includes(wanted)) throw new Error(`${dir} has no wake head ${wanted}; it has ${available.join(", ")}`);
    const scale = opts.scale ?? (manifest.params["scale"] === "unit" ? "unit" : "int16");
    const ort = await loadOrt();
    const create = (file: string) => ort.InferenceSession.create(join(dir, file), SESSION_OPTS as never);
    const [mel, emb, head] = await Promise.all([create(melFile), create(embFile), create(wanted)]);
    return new OpenWakeWord(ort, mel!, emb!, [{ name: wanted, session: head! }], scale);
  }

  stream(): WakePipeline {
    return new WakePipeline(this);
  }

  async close(): Promise<void> {
    await Promise.all([this.mel.release(), this.emb.release(), ...this.heads.map((h) => h.session.release())]).catch(() => {});
  }
}
