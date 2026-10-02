use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};
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
pub struct ExecOptions {
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub service_tier: Option<String>,
    pub instructions: Option<String>,
    pub extra_args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub max_concurrency: u32,
}
impl Default for ExecOptions {
    fn default() -> Self {
        Self { model: None, thinking: None, service_tier: None, instructions: None, extra_args: vec![], env: BTreeMap::new(), max_concurrency: 1 }
    }
}

/// A normalized provider catalog. `fallback` catalogs are suggestions only and
/// must never be treated as authoritative validation for execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub models: Vec<ModelInfo>,
    pub fetched_at: String,
    pub expires_at: String,
    pub fallback: bool,
    pub source: String,
}

/// One profile-visible model and the settings that model accepts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub supported_thinking: Vec<String>,
    pub default_thinking: Option<String>,
    pub service_tiers: Vec<ServiceTier>,
    pub default_service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variants: Option<Vec<String>>,
    pub host_dependent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTier {
    pub id: String,
    pub name: String,
}

/// Normalized successful or partial usage; every metric remains nullable when
/// the provider did not report it. Raw provider payloads must not be attached.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub usage_status: String,
    pub provider_update_id: Option<String>,
    pub context_used: Option<u64>,
    pub context_size: Option<u64>,
    pub model: Option<String>,
    pub cost_minor: Option<i64>,
    pub cost_currency: Option<String>,
    pub reported_cost_decimal: Option<String>,
    /// True when `reported_cost_decimal` is a session-cumulative total.
    /// OpenCode ACP's `usage_update.cost.amount` is cumulative; the daemon
    /// derives the per-turn delta. Omitted JSON deserializes as false so
    /// per-turn costs from other adapters stay per-turn.
    #[serde(default)]
    pub cost_is_cumulative: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind { None, RequestShape, ProviderEcho, UsageEffect, SuccessfulTurn }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingOutcome {
    pub requested: Option<Value>,
    pub applied: Option<bool>,
    pub evidence_kind: EvidenceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionRequest {
    pub session_id: String,
    pub project_path: PathBuf,
    #[serde(default)]
    pub exec_options: ExecOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSessionRequest {
    pub session_id: String,
    pub provider_session_id: String,
    pub project_path: PathBuf,
    #[serde(default)]
    pub exec_options: ExecOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub turn_id: String,
    pub text: String,
    #[serde(default)]
    pub exec_options: ExecOptions,
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
    /// Provider has evaluated execution settings; values are normalized evidence.
    ExecApplied { turn_id: String, outcomes: BTreeMap<String, SettingOutcome> },
    /// Normalized usage with nullable buckets; emitted only for valid provider reports.
    UsageReport { turn_id: String, report: UsageReport },
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
    /// Return a profile-scoped model catalog. Adapters that do not support
    /// discovery keep source compatibility and report `Unsupported` by default.
    async fn model_catalog(&self, _runtime: &RuntimeSpec) -> Result<ModelCatalog, AdapterError> {
        Err(AdapterError::Unsupported("model catalog is unavailable".into()))
    }
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

#[cfg(test)]
mod exec_option_tests {
    use super::*;

    #[test]
    fn old_adapter_request_shapes_default_exec_options_and_new_fields_are_camel_case() {
        let new:NewSessionRequest=serde_json::from_value(serde_json::json!({"sessionId":"s","projectPath":"."})).unwrap();
        let resume:ResumeSessionRequest=serde_json::from_value(serde_json::json!({"sessionId":"s","providerSessionId":"p","projectPath":"."})).unwrap();
        let prompt:PromptRequest=serde_json::from_value(serde_json::json!({"turnId":"t","text":"hello"})).unwrap();
        assert_eq!(new.exec_options.max_concurrency,1);assert_eq!(resume.exec_options.max_concurrency,1);assert!(prompt.exec_options.env.is_empty());
        let encoded=serde_json::to_value(ExecOptions::default()).unwrap();assert!(encoded.get("serviceTier").is_some());assert!(encoded.get("maxConcurrency").is_some());assert!(encoded.get("service_tier").is_none());
        assert_eq!(serde_json::to_value(EvidenceKind::ProviderEcho).unwrap(),"provider_echo");
    }

    #[test]
    fn usage_report_cost_is_cumulative_defaults_false_and_serializes_camel_case() {
        let report: UsageReport = serde_json::from_value(serde_json::json!({
            "inputTokens": 1, "outputTokens": 2, "cacheReadTokens": null, "cacheWriteTokens": null,
            "reasoningTokens": null, "usageStatus": "reported", "providerUpdateId": "1",
            "contextUsed": null, "contextSize": null, "model": null, "costMinor": null,
            "costCurrency": "USD", "reportedCostDecimal": "0.0015894"
        })).unwrap();
        assert!(!report.cost_is_cumulative);
        assert_eq!(report.reported_cost_decimal.as_deref(), Some("0.0015894"));
        let mut report = report;
        report.cost_is_cumulative = true;
        let encoded = serde_json::to_value(&report).unwrap();
        assert_eq!(encoded["costIsCumulative"], true);
        assert!(encoded.get("cost_is_cumulative").is_none());
    }
}
