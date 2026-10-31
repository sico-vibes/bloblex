//! The pinned Codex app-server protocol, and the methods this adapter uses.
//!
//! `schema/` holds what `scripts/codex-schema.ps1` generated from one installed
//! `codex-cli`: the four documents that carry method names, the CLI version that
//! produced them, and the two notification types older builds still emit under
//! names the current bundle no longer lists. The pin is a *check*, never a
//! refusal: a newer Codex is reported (see `bloblex-daemon`'s Doctor) and still
//! runs, because the CLI is the owner's, not ours.
//!
//! [`METHODS`] is what Bitbots sends and handles, with the line it is used at.
//! [`PinnedSchema::missing`] answers which of those the pin no longer lists, so
//! a Codex update that removes one fails a test instead of a turn.

use std::collections::BTreeSet;

use serde_json::Value;

pub const CLIENT_REQUEST: &str = include_str!("../schema/ClientRequest.json");
pub const CLIENT_NOTIFICATION: &str = include_str!("../schema/ClientNotification.json");
pub const SERVER_REQUEST: &str = include_str!("../schema/ServerRequest.json");
pub const SERVER_NOTIFICATION: &str = include_str!("../schema/ServerNotification.json");
pub const PINNED_VERSION: &str = include_str!("../schema/VERSION");
/// The notification types older CLI builds emit; see [`COMPAT`].
pub const COMPAT_RAW_RESPONSE_ITEM: &str =
    include_str!("../schema/compat/RawResponseItemCompletedNotification.json");
pub const COMPAT_AGENT_MESSAGE_DELTA: &str =
    include_str!("../schema/compat/AgentMessageDeltaNotification.json");

/// The version of the CLI the pinned schema was generated from.
pub fn pinned_version() -> &'static str {
    PINNED_VERSION.trim()
}

/// Which document a method name belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// A request Bitbots sends (`ClientRequest`).
    Send,
    /// A notification Bitbots sends (`ClientNotification`).
    SendNotification,
    /// A request the CLI sends and Bitbots answers (`ServerRequest`).
    Receive,
    /// A notification Bitbots handles (`ServerNotification`).
    Handle,
}

impl Direction {
    fn document(self) -> &'static str {
        match self {
            Direction::Send => "ClientRequest",
            Direction::SendNotification => "ClientNotification",
            Direction::Receive => "ServerRequest",
            Direction::Handle => "ServerNotification",
        }
    }
}

/// One method Bitbots uses, and where it is used.
#[derive(Debug, Clone, Copy)]
pub struct MethodUse {
    pub method: &'static str,
    pub direction: Direction,
    /// `file:line`, so a failure points at the call site to read.
    pub at: &'static str,
}

/// A name handled for compatibility with a build that emits it, which the
/// pinned bundle no longer lists. Pinning the name and the type keeps both
/// honest: the type must still exist in the bundle, and the name is asserted to
/// be absent, so the day Codex lists it the entry is promoted instead of
/// quietly staying an exception.
#[derive(Debug, Clone, Copy)]
pub struct CompatUse {
    pub method: &'static str,
    /// The pinned notification type carrying the same payload.
    pub document: &'static str,
    pub reason: &'static str,
}

pub const METHODS: &[MethodUse] = &[
    // Requests: `src/lib.rs` `call` and `startup_call`.
    MethodUse { method: "initialize", direction: Direction::Send, at: "src/lib.rs:721" },
    MethodUse { method: "thread/start", direction: Direction::Send, at: "src/lib.rs:659,1519" },
    MethodUse { method: "thread/resume", direction: Direction::Send, at: "src/lib.rs:653,1576" },
    MethodUse { method: "turn/start", direction: Direction::Send, at: "src/lib.rs:1703" },
    MethodUse { method: "turn/steer", direction: Direction::Send, at: "src/lib.rs:1784" },
    MethodUse { method: "turn/interrupt", direction: Direction::Send, at: "src/lib.rs:1808" },
    MethodUse { method: "model/list", direction: Direction::Send, at: "src/lib.rs:1366" },
    MethodUse { method: "account/rateLimits/read", direction: Direction::Send, at: "src/lib.rs:1416" },
    // The one notification Bitbots sends, after `initialize`.
    MethodUse { method: "initialized", direction: Direction::SendNotification, at: "src/lib.rs:1350,1413" },
    // Requests the CLI sends: a question, an MCP tool the owner must allow, and
    // the approval family (matched by its `requestApproval` suffix, at
    // `src/lib.rs:398`; the three names below are the pinned members of it).
    MethodUse { method: "item/tool/requestUserInput", direction: Direction::Receive, at: "src/lib.rs:373" },
    MethodUse { method: "mcpServer/elicitation/request", direction: Direction::Receive, at: "src/lib.rs:382" },
    MethodUse { method: "item/commandExecution/requestApproval", direction: Direction::Receive, at: "src/lib.rs:402" },
    MethodUse { method: "item/fileChange/requestApproval", direction: Direction::Receive, at: "src/lib.rs:402" },
    MethodUse { method: "item/permissions/requestApproval", direction: Direction::Receive, at: "src/lib.rs:402" },
    // Notifications: the reader at `src/lib.rs:369` onward, and
    // `map_notification` at `src/lib.rs:1015`.
    MethodUse { method: "turn/started", direction: Direction::Handle, at: "src/lib.rs:419" },
    MethodUse { method: "turn/completed", direction: Direction::Handle, at: "src/lib.rs:466" },
    MethodUse { method: "thread/tokenUsage/updated", direction: Direction::Handle, at: "src/lib.rs:455" },
    MethodUse { method: "thread/settings/updated", direction: Direction::Handle, at: "src/lib.rs:526" },
    MethodUse { method: "item/started", direction: Direction::Handle, at: "src/lib.rs:1028" },
    MethodUse { method: "item/completed", direction: Direction::Handle, at: "src/lib.rs:441,1052" },
    MethodUse { method: "item/agentMessage/delta", direction: Direction::Handle, at: "src/lib.rs:1017" },
    MethodUse { method: "item/commandExecution/outputDelta", direction: Direction::Handle, at: "src/lib.rs:1020" },
    MethodUse { method: "item/mcpToolCall/progress", direction: Direction::Handle, at: "src/lib.rs:1024" },
    MethodUse { method: "thread/name/updated", direction: Direction::Handle, at: "src/lib.rs:1014" },
];

pub const COMPAT: &[CompatUse] = &[
    CompatUse {
        method: "item/agentMessageDelta",
        document: "AgentMessageDeltaNotification",
        reason: "the pre-`item/agentMessage/delta` spelling, kept for older installed builds",
    },
    CompatUse {
        method: "rawResponseItem/completed",
        document: "RawResponseItemCompletedNotification",
        reason: "the raw stream item beside `item/completed`; it maps to no event on purpose, since it repeats the same bytes",
    },
];

/// The four pinned documents, parsed down to the method names each one lists.
#[derive(Debug, Clone, Default)]
pub struct PinnedSchema {
    send: BTreeSet<String>,
    send_notification: BTreeSet<String>,
    receive: BTreeSet<String>,
    handle: BTreeSet<String>,
}

impl PinnedSchema {
    /// Parse a schema bundle from its four documents.
    pub fn from_documents(client_request: &str, client_notification: &str, server_request: &str, server_notification: &str) -> Option<Self> {
        let parse = |text: &str| serde_json::from_str::<Value>(text).ok().map(|value| {
            let mut names = BTreeSet::new();
            collect_methods(&value, &mut names);
            names
        });
        Some(Self {
            send: parse(client_request)?,
            send_notification: parse(client_notification)?,
            receive: parse(server_request)?,
            handle: parse(server_notification)?,
        })
    }

    /// The pin that ships with this build.
    pub fn pinned() -> Self {
        Self::from_documents(CLIENT_REQUEST, CLIENT_NOTIFICATION, SERVER_REQUEST, SERVER_NOTIFICATION)
            .expect("the pinned Codex schema is generated JSON")
    }

    fn names(&self, direction: Direction) -> &BTreeSet<String> {
        match direction {
            Direction::Send => &self.send,
            Direction::SendNotification => &self.send_notification,
            Direction::Receive => &self.receive,
            Direction::Handle => &self.handle,
        }
    }

    /// Whether the pin lists `method` in the document its direction belongs to.
    pub fn has(&self, direction: Direction, method: &str) -> bool {
        self.names(direction).contains(method)
    }

    /// Whether any of the four documents lists `method`.
    pub fn known_anywhere(&self, method: &str) -> bool {
        [Direction::Send, Direction::SendNotification, Direction::Receive, Direction::Handle]
            .iter()
            .any(|direction| self.has(*direction, method))
    }

    /// The methods Bitbots uses that the pin no longer lists, by name.
    pub fn missing(&self, uses: &[MethodUse]) -> Vec<&'static str> {
        uses.iter().filter(|use_| !self.has(use_.direction, use_.method)).map(|use_| use_.method).collect()
    }

    /// A sentence naming the first method that is missing in the wrong document,
    /// or `None` when the pin covers every use.
    pub fn first_missing(&self, uses: &[MethodUse]) -> Option<String> {
        let use_ = uses.iter().find(|use_| !self.has(use_.direction, use_.method))?;
        Some(format!("`{}` ({}) is not in the pinned {} document (used at {})", use_.method, direction_label(use_.direction), use_.direction.document(), use_.at))
    }
}

fn direction_label(direction: Direction) -> &'static str {
    match direction {
        Direction::Send => "a request Bitbots sends",
        Direction::SendNotification => "a notification Bitbots sends",
        Direction::Receive => "a request the CLI sends",
        Direction::Handle => "a notification Bitbots handles",
    }
}

/// Every `{"method": {"enum": [...]}}` in a schema document: the method names a
/// union variant accepts. A document also has nested objects with other names,
/// so this can only over-collect; a name it takes from somewhere else still
/// came from the pinned bundle.
fn collect_methods(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == "method" {
                    if let Some(names) = child.get("enum").and_then(Value::as_array) {
                        out.extend(names.iter().filter_map(Value::as_str).map(str::to_owned));
                    }
                }
                collect_methods(child, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_methods(item, out)),
        _ => {}
    }
}

/// `runtime.list`'s `protocol` field for a Codex row: what the CLI reported and
/// whether it is the version the pin came from. It never refuses anything.
pub fn protocol_compatibility(installed: Option<&str>) -> Value {
    let installed = installed.map(str::trim).filter(|version| !version.is_empty());
    let pinned = pinned_version();
    serde_json::json!({"pinned": pinned, "installed": installed, "match": installed == Some(pinned)})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pinned_documents_parse_and_list_methods() {
        let schema = PinnedSchema::pinned();
        assert!(schema.send.len() > 100, "{}", schema.send.len());
        assert!(schema.receive.len() > 10);
        assert!(schema.handle.len() > 30, "{}", schema.handle.len());
        assert!(schema.has(Direction::Send, "turn/start"));
        assert!(schema.has(Direction::SendNotification, "initialized"));
        assert_eq!(pinned_version(), "0.165.0");
    }

    #[test]
    fn a_compat_name_is_absent_from_the_pinned_union() {
        let schema = PinnedSchema::pinned();
        for compat in COMPAT {
            assert!(!schema.known_anywhere(compat.method), "{} is listed now; promote it in METHODS", compat.method);
        }
    }

    #[test]
    fn protocol_compatibility_reports_a_match_and_a_mismatch() {
        let same = protocol_compatibility(Some("0.165.0"));
        assert_eq!(same["match"], true);
        assert_eq!(same["installed"], "0.165.0");
        let newer = protocol_compatibility(Some("0.170.2"));
        assert_eq!(newer["match"], false);
        assert_eq!(newer["installed"], "0.170.2");
        let unknown = protocol_compatibility(None);
        assert_eq!(unknown["match"], false);
        assert!(unknown["installed"].is_null());
    }
}
