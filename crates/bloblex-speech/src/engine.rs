//! sherpa-onnx recognizer wrapper.
//!
//! Supports the two shapes the catalog uses:
//! * streaming transducers (Zipformer) for live partials, and
//! * offline transducers (Parakeet TDT) decoded per utterance: a partial about every second while someone
//!   speaks and a final at each pause (`UtteranceTracker`), so live words appear for these models too.
//!
//! Endpoint thresholds are sherpa-onnx defaults (2.4s / 1.2s / 20s), matching
//! the values Orca configures explicitly.

use std::path::Path;

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use crate::utterance::{UtteranceStep, UtteranceTracker};
use crate::error::{SpeechError, SpeechResult};
use crate::manifest::{SpeechModelManifest, SpeechModelType};
use crate::model_manager::sha256_file_blocking;
use crate::needle::NeedleRunner;

/// One decoded update from the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    /// A provisional hypothesis for the current utterance (streaming models).
    Partial(String),
    /// A committed segment.
    Final(String),
}

enum Recognizer {
    Online(OnlineRecognizer),
    Offline(OfflineRecognizer),
    Needle(NeedleRunner),
}

pub struct SpeechEngine {
    recognizer: Recognizer,
    online_stream: Option<OnlineStream>,
    tracker: Option<UtteranceTracker>,
    last_partial: String,
    sample_rate: i32,
    streaming: bool,
}

fn resolve_file(files: &[String], directory: &Path, needle: &str) -> SpeechResult<String> {
    files
        .iter()
        .find(|name| name.contains(needle))
        .map(|name| directory.join(name).to_string_lossy().into_owned())
        .ok_or_else(|| SpeechError::ModelNotReady(format!("missing '{needle}' file")))
}

impl SpeechEngine {
    /// Load a recognizer from an already-downloaded model directory.
    pub fn load(manifest: &SpeechModelManifest, directory: &Path) -> SpeechResult<Self> {
        if manifest.model_type == SpeechModelType::Needle {
            return Self::load_needle(manifest, directory);
        }
        let tokens = resolve_file(&manifest.files, directory, "tokens")?;
        let encoder = resolve_file(&manifest.files, directory, "encoder")?;
        let decoder = resolve_file(&manifest.files, directory, "decoder")?;
        let joiner = resolve_file(&manifest.files, directory, "joiner")?;

        let (recognizer, online_stream) = if manifest.streaming {
            let mut config = OnlineRecognizerConfig::default();
            config.model_config.transducer.encoder = Some(encoder);
            config.model_config.transducer.decoder = Some(decoder);
            config.model_config.transducer.joiner = Some(joiner);
            config.model_config.tokens = Some(tokens);
            config.model_config.provider = Some("cpu".to_string());
            config.model_config.num_threads = 1;
            config.enable_endpoint = true;
            config.decoding_method = Some("greedy_search".to_string());
            let recognizer = OnlineRecognizer::create(&config)
                .ok_or_else(|| SpeechError::Engine("could not create online recognizer".into()))?;
            let stream = recognizer.create_stream();
            (Recognizer::Online(recognizer), Some(stream))
        } else {
            match manifest.model_type {
                SpeechModelType::Transducer | SpeechModelType::NemoCtc => {
                    let mut config = OfflineRecognizerConfig::default();
                    config.model_config.transducer = OfflineTransducerModelConfig {
                        encoder: Some(encoder),
                        decoder: Some(decoder),
                        joiner: Some(joiner),
                    };
                    config.model_config.tokens = Some(tokens);
                    config.model_config.provider = Some("cpu".to_string());
                    config.model_config.num_threads = 2;
                    let recognizer = OfflineRecognizer::create(&config).ok_or_else(|| {
                        SpeechError::Engine("could not create offline recognizer".into())
                    })?;
                    (Recognizer::Offline(recognizer), None)
                }
                other => {
                    return Err(SpeechError::Engine(format!(
                        "unsupported offline model type: {other:?}"
                    )))
                }
            }
        };

        Ok(Self {
            recognizer,
            online_stream,
            tracker: if manifest.streaming {
                None
            } else {
                Some(UtteranceTracker::new(manifest.sample_rate))
            },
            last_partial: String::new(),
            sample_rate: manifest.sample_rate as i32,
            streaming: manifest.streaming,
        })
    }

    /// Whistle: check the pinned engine's hash (it is about to be run), then keep a runner that decodes one
    /// utterance at a time, like the offline recognizers.
    fn load_needle(manifest: &SpeechModelManifest, directory: &Path) -> SpeechResult<Self> {
        let pinned = |name: &str| manifest.download_files.iter().find(|file| file.name == name).ok_or_else(|| SpeechError::ModelNotReady(format!("missing '{name}' file")));
        let engine = pinned(crate::catalog::WHISTLE_ENGINE_FILE)?;
        let model = pinned(crate::catalog::WHISTLE_MODEL_FILE)?;
        let engine_path = directory.join(&engine.name);
        let model_path = directory.join(&model.name);
        let actual = sha256_file_blocking(&engine_path).map_err(|_| SpeechError::ModelNotReady(engine.name.clone()))?;
        if !actual.eq_ignore_ascii_case(&engine.sha256) {
            return Err(SpeechError::Integrity(engine.name.clone()));
        }
        if !model_path.is_file() {
            return Err(SpeechError::ModelNotReady(model.name.clone()));
        }
        let scratch = directory.join("tmp");
        NeedleRunner::sweep_scratch(&scratch);
        Ok(Self {
            recognizer: Recognizer::Needle(NeedleRunner::subprocess(engine_path, model_path, scratch)),
            online_stream: None,
            tracker: Some(UtteranceTracker::new(manifest.sample_rate)),
            last_partial: String::new(),
            sample_rate: manifest.sample_rate as i32,
            streaming: false,
        })
    }

    pub fn is_streaming(&self) -> bool {
        self.streaming
    }

    /// Return the engine to a clean session state so a warm recognizer can be
    /// reused for the next dictation without reloading the model.
    pub fn reset(&mut self) {
        if self.streaming {
            if let Recognizer::Online(recognizer) = &self.recognizer {
                self.online_stream = Some(recognizer.create_stream());
            }
        } else {
            self.tracker = Some(UtteranceTracker::new(self.sample_rate as u32));
        }
        self.last_partial.clear();
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate as u32
    }

    /// Feed 16 kHz mono samples; return any decoded updates.
    pub fn accept(&mut self, samples: &[f32]) -> Vec<EngineEvent> {
        if self.streaming {
            self.accept_online(samples)
        } else {
            let step = self.tracker.as_mut().and_then(|tracker| tracker.push(samples));
            let mut events = Vec::new();
            match step {
                Some(UtteranceStep::Partial(audio)) => {
                    let began = std::time::Instant::now();
                    let text = self.decode_offline_chunk(&audio);
                    if let Some(tracker) = self.tracker.as_mut() {
                        tracker.note_decode_cost(began.elapsed().as_secs_f32());
                    }
                    if let Some(text) = text.filter(|text| *text != self.last_partial) {
                        self.last_partial = text.clone();
                        events.push(EngineEvent::Partial(text));
                    }
                }
                Some(UtteranceStep::Final(audio)) => {
                    self.last_partial.clear();
                    if let Some(text) = self.decode_offline_chunk(&audio) {
                        events.push(EngineEvent::Final(text));
                    }
                }
                None => {}
            }
            events
        }
    }

    /// Flush the tail of the current session.
    pub fn finish(&mut self) -> Vec<EngineEvent> {
        if self.streaming {
            let mut events = Vec::new();
            if let Recognizer::Online(recognizer) = &self.recognizer {
                if let Some(stream) = self.online_stream.as_ref() {
                    stream.input_finished();
                    while recognizer.is_ready(stream) {
                        recognizer.decode(stream);
                    }
                    if let Some(result) = recognizer.get_result(stream) {
                        let text = result.text.trim().to_string();
                        if !text.is_empty() {
                            events.push(EngineEvent::Final(text));
                        }
                    }
                    recognizer.reset(stream);
                }
            }
            events
        } else {
            let remaining = self.tracker.as_mut().and_then(|tracker| tracker.finish());
            self.last_partial.clear();
            match remaining {
                Some(audio) => self.decode_offline_chunk(&audio).map(EngineEvent::Final).into_iter().collect(),
                None => Vec::new(),
            }
        }
    }

    fn accept_online(&mut self, samples: &[f32]) -> Vec<EngineEvent> {
        let Recognizer::Online(recognizer) = &self.recognizer else {
            return Vec::new();
        };
        let Some(stream) = self.online_stream.as_ref() else {
            return Vec::new();
        };
        stream.accept_waveform(self.sample_rate, samples);
        let mut events = Vec::new();
        while recognizer.is_ready(stream) {
            recognizer.decode(stream);
        }
        if let Some(result) = recognizer.get_result(stream) {
            let text = result.text.trim().to_string();
            if !text.is_empty() {
                events.push(EngineEvent::Partial(text));
            }
        }
        if recognizer.is_endpoint(stream) {
            if let Some(result) = recognizer.get_result(stream) {
                let text = result.text.trim().to_string();
                if !text.is_empty() {
                    events.push(EngineEvent::Final(text));
                }
            }
            recognizer.reset(stream);
        }
        events
    }

    fn decode_offline_chunk(&mut self, samples: &[f32]) -> Option<String> {
        if let Recognizer::Needle(runner) = &mut self.recognizer {
            // A failed run is a missed utterance, not a failed dictation; nothing about it is logged.
            return runner.transcribe(samples, self.sample_rate as u32).ok().flatten();
        }
        let Recognizer::Offline(recognizer) = &self.recognizer else {
            return None;
        };
        // Offline streams are single-use: mint a fresh one per attempt.
        let stream = recognizer.create_stream();
        stream.accept_waveform(self.sample_rate, samples);
        recognizer.decode(&stream);
        stream
            .get_result()
            .map(|result| result.text.trim().to_string())
            .filter(|text| !text.is_empty())
    }
}
