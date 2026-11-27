// The OS engine on the background worker. Reading every process of the machine is one
// synchronous system call that copies each thread's record too: 150 ms at the median and over
// 400 under load, every second while a client watches the meters, all of it time the daemon's
// own thread could not answer anyone. So the engine (hostEngine, GPU readers and all) is made
// and kept on the background worker, and a sample here is a call to it; what comes back is the
// same raw sample. The engine's name is the worker's, known after the first sample.

import type { Background } from "../background/client.ts";
import type { MetricsEngine, RawSample } from "./engine.ts";

/** The `metrics.sample` job's answer: the sample, and the name of the engine that took it. */
export interface WorkerSample {
  engine: string;
  sample: RawSample;
}

export function workerEngine(background: Background, opts: { gpu: boolean }): MetricsEngine {
  let name = "worker";
  return {
    get name() {
      return name;
    },
    async sample() {
      const r = await background.call<WorkerSample>("metrics.sample", { gpu: opts.gpu }, { class: "read" });
      name = r.engine;
      return r.sample;
    },
    dispose() {
      void background.call("metrics.dispose", { gpu: opts.gpu }, { class: "read" }).catch(() => {});
    },
  };
}
