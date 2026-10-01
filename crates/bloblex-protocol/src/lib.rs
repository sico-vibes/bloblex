use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub v: u16,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcResponse {
    pub v: u16,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub v: u16,
    pub event_id: String,
    pub sequence: u64,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonReady {
    #[serde(rename = "type")]
    pub message_type: String,
    pub protocol_version: u16,
    pub address: String,
    pub capability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Authenticated,
    Unauthenticated,
    NeedsInteraction,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Starting,
    Working,
    WaitingPermission,
    WaitingUser,
    Cancelling,
    Completed,
    Error,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolFamily {
    Acp,
    CodexAppServer,
    ClaudeStream,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_uses_contract_casing_and_defaults_params() {
        let req: RpcRequest =
            serde_json::from_str(r#"{"v":1,"id":"r1","method":"app.snapshot"}"#).unwrap();
        assert_eq!(req.params, Value::Null);
        assert_eq!(serde_json::to_value(req).unwrap()["method"], "app.snapshot");
    }

    #[test]
    fn event_wire_shape_is_stable() {
        let event = EventEnvelope {
            v: 1,
            event_id: "e1".into(),
            sequence: 4,
            timestamp: "t".into(),
            event_type: "session.changed".into(),
            payload: Value::Null,
        };
        let wire = serde_json::to_value(event).unwrap();
        assert_eq!(wire["type"], "session.changed");
        assert_eq!(wire["sequence"], 4);
    }
}
