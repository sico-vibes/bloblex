//! On-device dictation for Bitbots.
//!
//! Mirrors the reference design used by Orca (MIT): a pinned model catalog,
//! 16 kHz mono resampling before the native boundary, bounded utterances for offline models (with live partials),
//! and an owner-locked dictation lifecycle. The heavy sherpa-onnx + cpal engine
//! lives behind the `native` feature so the pure logic stays testable without a
//! native toolchain.

pub mod catalog;
pub mod cloud;
pub mod error;
pub mod level;
pub mod manifest;
pub mod model_manager;
pub mod needle;
pub mod resample;
pub mod session;
pub mod utterance;

#[cfg(feature = "native")]
pub mod capture;
#[cfg(feature = "native")]
pub mod engine;

pub use catalog::{catalog, default_model, get_catalog_model};
pub use error::{SpeechError, SpeechResult};
pub use level::rms_level;
pub use needle::NeedleRunner;
pub use manifest::{SpeechDownloadFile, SpeechModelManifest, SpeechModelType, SpeechProvider};
pub use resample::{downmix_to_mono, resample_to_rate};
pub use session::{DictationLifecycle, DictationOwner};
pub use utterance::{UtteranceStep, UtteranceTracker};

#[cfg(feature = "native")]
pub use capture::{start_capture, AudioFrame};
#[cfg(feature = "native")]
pub use engine::{EngineEvent, SpeechEngine};
