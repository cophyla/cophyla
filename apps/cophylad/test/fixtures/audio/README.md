# Audio fixtures

Two 16 kHz mono PCM clips the live engine check runs on, synthesized with Windows SAPI voices
and copied here so the check needs no microphone and no network.

| File | Words | From |
|---|---|---|
| `cophyla.wav` | "Co-filla.", the name as it is said, ko-FILL-uh, with half a second of silence either side | Microsoft David, from the clips the v0.2 wake heads were checked against (`packages/wake/heads/README.md`); David reads "Kohfilla" as ko-FY-la, so it is spelled "Co-filla" for him |
| `question.wav` | "What time is the meeting tomorrow afternoon?" | Microsoft Zira, `spikes/10-stt-tts/out/clips/en_short.zira.wav` |

`voice-engines.live.test.ts` is skipped unless the four model directories are present under
`apps/cophylad/models/voice/` (or `COPHYLA_VOICE_MODELS` names another directory of them), because
they are a gigabyte and are fetched by `apps/cophylad/scripts/fetch-models.ts --voice`.
