# Cophyla's own wake-word heads

Keyword heads trained for Cophyla, beside openWakeWord's stock "hey jarvis". Each takes the
16 × 96 embedding window `WakePipeline` feeds every head and returns one score; each is
listed with its threshold and phrase in the `wake-openwakeword` model's manifest
(`apps/cophylad/scripts/fetch-models.ts`, `head_params`), and the phone and the desktop app
carry copies (`packages/voicehost/src/wake/bundled.ts`, pinned by sha256).

| File | Says | Threshold | Validation (19.8 h of negatives, 5,000 positives) |
|---|---|---|---|
| `cophyla_v0.1.onnx` | "Cophyla", ko-FY-la | 0.7 | 91.6% recall, no false accepts; 93.6% with 0.05 an hour at 0.6 |
| `hey_phyla_v0.1.onnx` | "Hey Phyla", hey FY-la | 0.6 | 93.4% recall, 0.10 false accepts an hour; 94.5% with 0.30 at 0.5 |

## How they were made

[livekit-wakeword](https://github.com/livekit/livekit-wakeword) (Apache-2.0), run in WSL on an
RTX 4080, with two changes to its checkout: features are computed from int16-range samples
(`audio * 32768` before the mel model), as openWakeWord feeds its own heads, as the
precomputed negative features were made and as `WakePipeline` runs every head here (upstream
reads clips at −1..1 but trains against those int16 features); and the trainer takes a random
quarter of the ACAV100M features (1.4 M windows) so its page cache stays a few GB.

- Positives: 15,000 clips of Piper VITS (`en-us-libritts-high`, 904 speakers blended by
  SLERP) saying the phrase — "co-phyla", "co phyla", "ko-fyla", which espeak-ng reads as
  kˈoʊfˈaɪlə; "hey phyla", "hey, phyla" — at three speeds and two noise scales; 2,500 more for
  validation.
- Negatives: 15,000 clips of near misses (30 phrases per head plus the phoneme substitutions
  livekit-wakeword derives from CMUdict), openWakeWord's precomputed ACAV100M features, and
  MUSAN noise; all augmented twice (room impulse responses, background, gain).
- The classifier: conv + attention, medium, 60,000 steps.
- "Cophyla" then had a second and a third pass: the first head fired on "profile a function"
  (up to 0.90), a single sound away, so 6,000 more Piper clips of near misses, most of them
  "profile a …", went in twice over, with 48 clips of the eight Kokoro voices the test below
  does not use saying the word, alone and followed by a question, five times over; the
  classifier was trained again on the lot. "Hey Phyla" had a second pass of the same kind against
  "Hey Tyler" and its neighbours; it lost recall on the phrase and on validation without
  settling them, and the first head is the one kept.

Checked against clips no training used — three Kokoro voices and Windows' David and Zira,
through the node's pipeline, with 13 near misses of which six are in no training list:

- "Cophyla" scored 0.93–0.98 in four voices, alone and before a question; Zira, who says
  "co-phyla" as two words, was missed (0.07–0.18). "Profile a function" peaked at 0.46; every
  other near miss stayed under 0.05.
- "Hey Phyla" scored 0.95–0.98 in all five voices. It also fires on "hey" before a name that
  rhymes: "Hey Tyler" (0.15–0.97), "Hey Skyler" (0.11–0.95) and "Hey Tyra" (0.64–0.88) cross
  its threshold in 11 of those 15 clips. Only the first sound of the name tells them apart,
  and neither a higher threshold nor the second pass separated them. Every other near miss
  stayed under 0.15. It fires on "Cophyla" too, in the Kokoro voices, which wakes the node
  all the same.
- "Hey Jarvis" scored 0.998 or more in all five; nothing else reached 0.06 on it.

The precomputed ACAV100M and validation features are CC BY-NC-SA 4.0 (their dataset cards,
`binhpham/livekit_wakeword_features` and `davidscripka/openwakeword_features`), the terms the
stock "hey jarvis" head ships under too. A head trained without them — negatives from
permissively licensed speech run through the same feature models — would be free of that.
