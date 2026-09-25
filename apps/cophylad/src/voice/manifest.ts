// A voice model directory and the manifest that describes it. Every model the feed ships —
// the wake word's three ONNX files, Silero, the Nemotron transducer, Kokoro with its
// espeak data — is a directory with a `manifest.json` naming its kind, its version, the
// parameters the engine needs (which file is the encoder, what sample rate the voices are
// at) and the SHA-256 of every file in it. The hashes are what makes an unpacked directory
// trustworthy: the release entry covers the archive, the manifest covers what came out of it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const MANIFEST_FILE = "manifest.json";

export const VoiceManifest = z.object({
  name: z.string().min(1),
  /** What the engine layer does with it. */
  kind: z.enum(["wake", "vad", "stt", "tts"]),
  version: z.string().min(1),
  /** Engine parameters: file names within the directory, sample rates, feature dimensions. */
  params: z.record(z.string(), z.unknown()).default({}),
  /** Path within the directory → lowercase hex SHA-256. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type VoiceManifest = z.infer<typeof VoiceManifest>;

export function readVoiceManifest(dir: string): VoiceManifest | undefined {
  try {
    const parsed = VoiceManifest.safeParse(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export type VoiceCheck = { ok: true; manifest: VoiceManifest } | { ok: false; reason: string };

/** Every file the manifest names is there and hashes to what it says. */
export function verifyVoiceDir(dir: string): VoiceCheck {
  const manifest = readVoiceManifest(dir);
  if (!manifest) return { ok: false, reason: `no valid ${MANIFEST_FILE}` };
  const names = Object.keys(manifest.files);
  if (names.length === 0) return { ok: false, reason: "the manifest names no files" };
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const path = join(dir, rel);
    if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, reason: `missing ${rel}` };
    if (sha256File(path) !== expected) return { ok: false, reason: `sha256 of ${rel}` };
  }
  return { ok: true, manifest };
}

/** A parameter the engine needs as a path inside the model directory. */
export function paramPath(dir: string, manifest: VoiceManifest, key: string): string | undefined {
  const value = manifest.params[key];
  return typeof value === "string" ? join(dir, value) : undefined;
}

export function paramNumber(manifest: VoiceManifest, key: string, fallback: number): number {
  const value = manifest.params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function paramStrings(manifest: VoiceManifest, key: string): string[] {
  const value = manifest.params[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
