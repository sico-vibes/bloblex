# Floating dictation bubble (beta.12)

Current as of 8 October 2026. Release source commit `6662b14`; manual-only [v0.1.0-beta.12](../releases/0.1.0-beta.12.md).

## What shipped

- A `dictation` Tauri window: frameless, transparent, always-on-top, skip-taskbar, positioned above the companion. Created hidden at startup and shown by the backend only while dictation is active.
- `DictationBubble.tsx` (adapted from the Waveora bubble, without its logo): a mic glyph and a live waveform driven by a microphone level, plus processing and error states, hold-to-drag, and tap-to-focus.
- `dictationSound.ts`: synthesized Web Audio cues ported from Waveora — `record-start`, `processing-start`, `processing-finish`, and `error`. No audio assets are bundled.
- Backend surface selection in `speech.rs`: `bloblex-dictation-surface` reports `bubble` or `companion`. The bubble shows only when the companion is hidden; otherwise the companion renders a full-cover listening wave. `bloblex-dictation-level` carries the throttled RMS level, and `bloblex-dictation` gained a `processing` type.
- `bloblex-speech::level::rms_level` metering with unit tests.

## Verification

- `cargo test --workspace --exclude bloblex-desktop`: pass, including the `bloblex-speech` unit tests.
- `cargo check -p bloblex-desktop` with the `native` feature enabled: pass.
- `npm run typecheck`, `npm test` (63 files, 361 tests), and `npm run build`: pass.
- Unsigned NSIS bundle built from `6662b14` in `D:\b12`; `Authenticode: NotSigned`; 12,719,309 bytes, SHA-256 `1b3aff43ad1a150eb3b3977231bd6024e74151bb36db50f49664e274a01830cb`.

## Limits

- Live microphone capture and real model inference were not exercised; the microphone-level waveform and cues are verified by source and tests only.
- This packaging pass does not establish native UI, live-provider, or clean-machine-install acceptance.
