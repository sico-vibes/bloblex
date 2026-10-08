//! On-device dictation for Bloblex.
//!
//! Mirrors the reference design used by Orca (MIT): a pinned model catalog,
//! 16 kHz mono resampling before the native boundary, bounded offline chunking,
//! and an owner-locked dictation lifecycle. The heavy sherpa-onnx + cpal engine
//! lives behind the `native` feature so the pure logic stays testable without a
//! native toolchain.

pub mod catalog;
pub mod chunker;
pub mod error;
pub mod manifest;
pub mod model_manager;
pub mod resample;
pub mod session;

#[cfg(feature = "native")]
pub mod capture;
#[cfg(feature = "native")]
pub mod engine;

pub use catalog::{catalog, default_model, get_catalog_model};
pub use chunker::OfflineAudioChunker;
pub use error::{SpeechError, SpeechResult};
pub use manifest::{SpeechDownloadFile, SpeechModelManifest, SpeechModelType, SpeechProvider};
pub use resample::{downmix_to_mono, resample_to_rate};
pub use session::{DictationLifecycle, DictationOwner};

#[cfg(feature = "native")]
pub use capture::{start_capture, AudioFrame};
#[cfg(feature = "native")]
pub use engine::{EngineEvent, SpeechEngine};
