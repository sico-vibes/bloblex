//! sherpa-onnx recognizer wrapper.
//!
//! Supports the two shapes the catalog uses:
//! * streaming transducers (Zipformer) for live partials, and
//! * offline transducers (Parakeet TDT) decoded in bounded chunks.
//!
//! Endpoint thresholds are sherpa-onnx defaults (2.4s / 1.2s / 20s), matching
//! the values Orca configures explicitly.

use std::path::Path;

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use crate::chunker::OfflineAudioChunker;
use crate::error::{SpeechError, SpeechResult};
use crate::manifest::{SpeechModelManifest, SpeechModelType};

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
}

pub struct SpeechEngine {
    recognizer: Recognizer,
    online_stream: Option<OnlineStream>,
    chunker: Option<OfflineAudioChunker>,
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
            chunker: if manifest.streaming {
                None
            } else {
                Some(OfflineAudioChunker::new(manifest.sample_rate))
            },
            sample_rate: manifest.sample_rate as i32,
            streaming: manifest.streaming,
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
            self.chunker = Some(OfflineAudioChunker::new(self.sample_rate as u32));
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate as u32
    }

    /// Feed 16 kHz mono samples; return any decoded updates.
    pub fn accept(&mut self, samples: &[f32]) -> Vec<EngineEvent> {
        if self.streaming {
            self.accept_online(samples)
        } else {
            let chunks = self
                .chunker
                .as_mut()
                .map(|chunker| chunker.push(samples))
                .unwrap_or_default();
            let mut events = Vec::new();
            for chunk in chunks {
                if let Some(text) = self.decode_offline_chunk(&chunk) {
                    events.push(EngineEvent::Final(text));
                }
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
            let remaining = self
                .chunker
                .as_mut()
                .map(|chunker| chunker.flush())
                .unwrap_or_default();
            if remaining.is_empty() {
                Vec::new()
            } else {
                self.decode_offline_chunk(&remaining)
                    .map(EngineEvent::Final)
                    .into_iter()
                    .collect()
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

    fn decode_offline_chunk(&self, samples: &[f32]) -> Option<String> {
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
