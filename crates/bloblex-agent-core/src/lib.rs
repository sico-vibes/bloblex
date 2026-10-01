use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use thiserror::Error;
use tokio::sync::mpsc;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("unsupported capability: {0}")]
    Unsupported(String),
    #[error("provider protocol error: {0}")]
    Protocol(String),
    #[error("provider process unavailable: {0}")]
    Process(String),
    #[error("operation failed: {0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSpec {
    pub runtime_id: String,
    pub provider: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub resume: bool,
    pub cancel: bool,
    pub permissions: bool,
    pub usage: bool,
    pub files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub provider: String,
    pub version: Option<String>,
    pub protocol: String,
    pub authenticated: Option<bool>,
    pub capabilities: AgentCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionRequest {
    pub session_id: String,
    pub project_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSessionRequest {
    pub session_id: String,
    pub provider_session_id: String,
    pub project_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub turn_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandle {
    pub session_id: String,
    pub provider_session_id: String,
    pub capabilities: AgentCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", content = "payload")]
pub enum AgentEvent {
    SessionStarted {
        provider_session_id: String,
    },
    AssistantDelta {
        text: String,
    },
    AssistantMessage {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ToolStarted {
        tool_call_id: String,
        kind: String,
        title: String,
        raw: Value,
    },
    ToolUpdated {
        tool_call_id: String,
        raw: Value,
    },
    ToolCompleted {
        tool_call_id: String,
        raw: Value,
    },
    FileChanged {
        path: String,
        raw: Value,
    },
    PermissionRequested {
        provider_request_id: String,
        title: String,
        detail: Option<String>,
        choices: Vec<String>,
        raw: Value,
    },
    UsageUpdated {
        raw: Value,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        model: Option<String>,
    },
    TurnCompleted,
    TurnCancelled,
    Error {
        message: String,
    },
    SessionIdle,
}

pub type EventSender = mpsc::Sender<AgentEvent>;

#[async_trait]
pub trait AgentAdapter: Send + Sync {
    async fn probe(&self, runtime: &RuntimeSpec) -> Result<ProbeResult, AdapterError>;
    async fn new_session(
        &self,
        runtime: &RuntimeSpec,
        req: NewSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError>;
    async fn resume_session(
        &self,
        runtime: &RuntimeSpec,
        req: ResumeSessionRequest,
        events: EventSender,
    ) -> Result<SessionHandle, AdapterError>;
    async fn prompt(&self, handle: &SessionHandle, req: PromptRequest) -> Result<(), AdapterError>;
    async fn cancel(&self, handle: &SessionHandle) -> Result<(), AdapterError>;
    async fn reply_permission(
        &self,
        provider_request_id: &str,
        choice: &str,
    ) -> Result<(), AdapterError>;
    async fn close_session(&self, handle: &SessionHandle) -> Result<(), AdapterError>;
}
