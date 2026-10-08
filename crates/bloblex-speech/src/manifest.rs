use serde::{Deserialize, Serialize};

/// The sherpa-onnx recognizer family a model uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechModelType {
    Transducer,
    Paraformer,
    Whisper,
    NemoCtc,
    SenseVoice,
}

/// Where inference happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechProvider {
    Local,
    OpenAi,
}

/// One pinned file inside a model bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDownloadFile {
    pub name: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// Everything the runtime needs to load, download, and describe a model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelManifest {
    pub id: String,
    pub label: String,
    pub description: String,
    pub model_type: SpeechModelType,
    pub provider: SpeechProvider,
    pub language: String,
    pub files: Vec<String>,
    pub download_files: Vec<SpeechDownloadFile>,
    pub size_bytes: u64,
    pub sample_rate: u32,
    pub streaming: bool,
    #[serde(default)]
    pub modeling_unit: Option<String>,
    #[serde(default)]
    pub recommended: bool,
}

impl SpeechModelManifest {
    pub fn is_local(&self) -> bool {
        matches!(self.provider, SpeechProvider::Local)
    }
}
