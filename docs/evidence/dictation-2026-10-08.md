# On-device dictation (beta.11)

Current as of 8 October 2026. Release source commit `2d3f16d`; manual-only [v0.1.0-beta.11](../releases/0.1.0-beta.11.md).

## What shipped

- New workspace crate `crates/bloblex-speech`:
  - `catalog.rs`: pinned model catalog (Parakeet TDT v3 default, Parakeet TDT v2, Zipformer streaming EN) with immutable Hugging Face revisions and per-file sizes/SHA-256.
  - `engine.rs`: sherpa-onnx wrapper for streaming transducers (live partials + endpointing) and offline Parakeet decoded in bounded chunks, with a `reset()` for warm reuse.
  - `capture.rs`: cpal microphone capture on a dedicated thread.
  - `model_manager.rs`: resumable download with per-file SHA-256 verification and a model cache.
  - `resample.rs`, `chunker.rs`, `session.rs`: 16 kHz mono resampling, bounded offline chunking, and the owner-locked lifecycle.
- `apps/desktop/src-tauri/src/speech.rs`: a warm decode worker with idle teardown, Tauri commands (`dictation_start/stop/cancel/state`, `speech_models`, `speech_model_status`, `speech_model_download`) and a `bloblex-dictation` event stream.
- Renderer: `ui/dictation.ts`, `ui/DictationButton.tsx`, main and companion composer integration with a live provisional transcript, a Ctrl+E global shortcut, on-first-use model download with progress, and a Settings → Speech model manager.

The intent and the pinned model metadata follow the MIT-licensed reference project [stablyai/orca](https://github.com/stablyai/orca); the implementation is independent Rust. Attribution is in `THIRD_PARTY_NOTICES.md`.

## Verification

- `cargo test --workspace --exclude bloblex-desktop`: pass, including 19 `bloblex-speech` unit tests.
- `cargo check -p bloblex-desktop` with the `native` feature enabled: pass, no warnings.
- `npm run typecheck`, `npm test` (63 files, 361 tests), and `npm run build`: pass.
- Unsigned NSIS bundle built from `2d3f16d` in `D:\b11` (a short-path checkout); `Authenticode: NotSigned`.

## Limits

- No live microphone capture or real model inference was exercised; the model weights are not bundled and are downloaded at runtime.
- The release note records the installer size and SHA-256; the GitHub asset digest matches the local hash.
- This packaging pass does not establish native UI, live-provider, or clean-machine-install acceptance.
