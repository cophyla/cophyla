# Cophyla's own wake-word heads

Keyword heads trained for Cophyla, beside openWakeWord's stock "hey jarvis". Each takes the
16 × 96 embedding window `WakePipeline` feeds every head and returns one score; each is
listed with its threshold and phrase in the `wake-openwakeword` model's manifest
(`apps/cophylad/scripts/fetch-models.ts`, `head_params`), and the phone and the desktop app
carry copies (`packages/voicehost/src/wake/bundled.ts`, pinned by sha256).

| File | Says | Threshold | Validation (19.8 h of speech, 5,000 positives) |
|---|---|---|---|
| `cophyla_v0.1.onnx` | "Cophyla", ko-FY-la | 0.8 | 0.15 false accepts an hour at 0.83 with 91.7% recall; 0.35 an hour at 0.5 with 96.2% |

## How they were made

[livekit-wakeword](https://github.com/livekit/livekit-wakeword) (Apache-2.0), run in WSL on an
RTX 4080, with two changes to its checkout: features are computed from int16-range samples
(`audio * 32768` before the mel model), as openWakeWord feeds its own heads, as the
precomputed negative features were made and as `WakePipeline` runs every head here (upstream
reads clips at −1..1 but trains against those int16 features); and the trainer takes a random
quarter of the ACAV100M features (1.4 M windows) so its page cache stays a few GB.

- Positives: 15,000 clips of Piper VITS (`en-us-libritts-high`, 904 speakers blended by
  SLERP) saying the phrase — "co-phyla", "co phyla", "ko-fyla", which espeak-ng reads as
  kˈoʊfˈaɪlə — at three speeds and two noise scales; 2,500 more for validation.
- Negatives: 15,000 clips of near misses (the config's list plus the phoneme substitutions
  livekit-wakeword derives from CMUdict), openWakeWord's precomputed ACAV100M features, and
  MUSAN noise; both augmented twice (room impulse responses, background, gain).
- The classifier: conv + attention, medium, 60,000 steps.

Checked against clips no training used — Kokoro (four voices) and Windows' own voices, through
the node's pipeline: "co-phyla" scored 0.94–0.98 in five voices; Windows' Zira, who says it as
two words, was missed (0.03–0.06); of the near misses, "profile a function" scored 0.47–0.90,
which is what the threshold is set against; everything else stayed under 0.03.

The precomputed ACAV100M and validation features are CC BY-NC-SA 4.0 (their dataset cards,
`binhpham/livekit_wakeword_features` and `davidscripka/openwakeword_features`), the terms the
stock "hey jarvis" head ships under too. A head trained without them — negatives from
permissively licensed speech run through the same feature models — would be free of that.
