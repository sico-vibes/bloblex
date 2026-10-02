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
    #[error("provider rejected execution settings: {0}")]
    Rejected(String),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_note: Option<String>,
    pub provider_update_id: Option<String>,
    pub context_used: Option<u64>,
    pub context_size: Option<u64>,
    pub model: Option<String>,
    pub cost_minor: Option<i64>,
    pub cost_currency: Option<String>,
    pub reported_cost_decimal: Option<String>,
}

/// Computes a lowercase SHA-256 digest without retaining the input. Used for
/// instruction baselines; callers persist only the returned hexadecimal digest.
pub fn instruction_sha256(text: &str) -> Option<String> {
    if text.is_empty() { return None; }
    const K:[u32;64]=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    let bytes=text.as_bytes();let bit_len=(bytes.len() as u64).wrapping_mul(8);let mut data=bytes.to_vec();data.push(0x80);while data.len()%64!=56{data.push(0)}data.extend_from_slice(&bit_len.to_be_bytes());
    let mut h=[0x6a09e667u32,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    for block in data.chunks_exact(64){let mut w=[0u32;64];for(i,word)in block.chunks_exact(4).enumerate(){w[i]=u32::from_be_bytes([word[0],word[1],word[2],word[3]])}for i in 16..64{let s0=w[i-15].rotate_right(7)^w[i-15].rotate_right(18)^(w[i-15]>>3);let s1=w[i-2].rotate_right(17)^w[i-2].rotate_right(19)^(w[i-2]>>10);w[i]=w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1)}
        let(mut a,mut b,mut c,mut d,mut e,mut f,mut g,mut hh)=(h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7]);for i in 0..64{let s1=e.rotate_right(6)^e.rotate_right(11)^e.rotate_right(25);let ch=(e&f)^(!e&g);let t1=hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);let s0=a.rotate_right(2)^a.rotate_right(13)^a.rotate_right(22);let maj=(a&b)^(a&c)^(b&c);let t2=s0.wrapping_add(maj);hh=g;g=f;f=e;e=d.wrapping_add(t1);d=c;c=b;b=a;a=t1.wrapping_add(t2)}for(i,v)in[a,b,c,d,e,f,g,hh].into_iter().enumerate(){h[i]=h[i].wrapping_add(v)}}
    Some(h.iter().map(|v|format!("{v:08x}")).collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Supplies per-turn instruction hash context. Defaults preserve source
    /// compatibility for providers whose instruction lifecycle is adapter-local.
    async fn set_instruction_hash_context(&self, _session_id:&str, _desired:Option<String>, _baseline:Option<String>) {}
    /// Performs option preparation that can fail before a user prompt is
    /// admitted. Implementations must not send the user prompt here.
    async fn preflight_exec_options(&self, _options:&ExecOptions) -> Result<(),AdapterError> { Ok(()) }
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
    fn instruction_sha256_is_standard_and_empty_is_absent(){assert_eq!(instruction_sha256("abc").as_deref(),Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));assert_eq!(instruction_sha256(""),None);}
}
