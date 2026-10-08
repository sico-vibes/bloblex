use thiserror::Error;

/// Errors surfaced by the dictation engine. Kept small and explicit so the
/// desktop shell can map each one to a stable user-facing message.
#[derive(Debug, Error)]
pub enum SpeechError {
    #[error("unknown speech model: {0}")]
    UnknownModel(String),
    #[error("speech model is not ready: {0}")]
    ModelNotReady(String),
    #[error("dictation is already active")]
    AlreadyActive,
    #[error("dictation owner mismatch")]
    OwnerMismatch,
    #[error("dictation start was canceled")]
    Canceled,
    #[error("speech model download failed: {0}")]
    Download(String),
    #[error("speech model integrity check failed for {0}")]
    Integrity(String),
    #[error("audio capture failed: {0}")]
    Capture(String),
    #[error("speech engine failed: {0}")]
    Engine(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type SpeechResult<T> = Result<T, SpeechError>;
