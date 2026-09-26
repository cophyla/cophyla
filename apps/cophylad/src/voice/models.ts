// Where a voice model comes from. The wake word's and the VAD's come from the release feed:
// the update module fetches one the first time a stage that needs it is turned on, and the
// directory it unpacked is what the engine loads. A speech engine's comes only from this
// machine, where `voice.install` put it (`install.ts`). During development `[voice] models_dir` points at a directory of
// model folders instead, so the engines run against local copies with no feed, no signing
// and no download.

import { join } from "node:path";
import type { Logger } from "../log.ts";
import type { ModelResolver } from "./engines.ts";
import { voiceModel } from "./catalog.ts";
import { modelDir, modelInstalled } from "./install.ts";
import { readVoiceManifest } from "./manifest.ts";

export interface ModelResolverDeps {
  /** `[voice] models_dir`: `<override>/<name>/` is used when it holds a manifest. */
  override?: string;
  /** `<data>`: where a speech engine installed on this machine keeps its models (`install.ts`). */
  dataDir?: string;
  /** The update module, which fetches and promotes a model release. */
  update?: { ensureModel(name: string): Promise<string | undefined> };
  log?: Logger;
}

export function modelResolver(deps: ModelResolverDeps): ModelResolver {
  return {
    async resolve(name: string): Promise<string | undefined> {
      if (deps.override) {
        const dir = join(deps.override, name);
        if (readVoiceManifest(dir)) {
          deps.log?.info("voice model from the local directory", { model: name, dir });
          return dir;
        }
        deps.log?.warn("no model in the configured directory; falling back to the feed", { model: name, dir });
      }
      // A speech engine's model is installed on this machine when its user asks, never
      // fetched from the feed behind their back: it is here, or it is not.
      const spec = voiceModel(name);
      if (spec && (spec.kind === "stt" || spec.kind === "tts")) {
        if (deps.dataDir && modelInstalled(deps.dataDir, name)) return modelDir(deps.dataDir, name);
        deps.log?.info("voice model not installed", { model: name });
        return undefined;
      }
      if (!deps.update) return undefined;
      const dir = await deps.update.ensureModel(name);
      if (!dir) deps.log?.warn("voice model not available", { model: name });
      return dir;
    },
  };
}
