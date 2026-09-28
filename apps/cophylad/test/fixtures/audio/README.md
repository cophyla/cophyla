# Audio fixtures

Two 16 kHz mono PCM clips the live engine check runs on, synthesized with Windows SAPI voices
and copied here so the check needs no microphone and no network.

| File | Words | From |
|---|---|---|
| `cophyla.wav` | "Co-phyla." in the v0.1 wake heads' ko-FY-la, not the name's ko-FILL-uh | Microsoft David, from the clips the wake heads were checked against (`packages/wake/heads/README.md`) |
| `question.wav` | "What time is the meeting tomorrow afternoon?" | Microsoft Zira, `spikes/10-stt-tts/out/clips/en_short.zira.wav` |

The heads do not wake on ko-FILL-uh yet, so `cophyla.wav` says the name as they learned it and
is replaced when they are trained on the new sound.

`voice-engines.live.test.ts` is skipped unless the four model directories are present under
`apps/cophylad/models/voice/` (or `COPHYLA_VOICE_MODELS` names another directory of them), because
they are a gigabyte and are fetched by `apps/cophylad/scripts/fetch-models.ts --voice`.
