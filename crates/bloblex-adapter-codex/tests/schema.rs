//! The pinned Codex protocol schema (`crates/bloblex-adapter-codex/schema/`).
//!
//! These tests are the reason the pin exists: a Codex update that drops a
//! method this adapter uses must fail here, in a test, rather than inside a
//! turn the owner is watching.

use bloblex_adapter_codex::protocol::{
    self, CompatUse, MethodUse, PinnedSchema, COMPAT, COMPAT_AGENT_MESSAGE_DELTA,
    COMPAT_RAW_RESPONSE_ITEM, CLIENT_NOTIFICATION, CLIENT_REQUEST, METHODS, SERVER_NOTIFICATION,
    SERVER_REQUEST,
};

#[test]
fn every_method_the_adapter_uses_is_in_the_pinned_schema() {
    let schema = PinnedSchema::pinned();
    let missing = schema.missing(METHODS);
    assert!(missing.is_empty(), "the pinned {} schema no longer lists {missing:?}; a turn using it would fail", protocol::pinned_version());
    // A method declared in the wrong document is just as broken as a missing
    // one: `turn/start` has to be a request Bitbots sends, not a notification.
    for use_ in METHODS {
        assert!(schema.has(use_.direction, use_.method), "{} is declared at {}", use_.method, use_.at);
    }
    assert!(METHODS.iter().any(|use_| use_.direction == protocol::Direction::Send && use_.method == "turn/start"));
    assert!(METHODS.iter().any(|use_| use_.method == "turn/steer"), "the pin must cover steering, not only turns");
}

#[test]
fn a_method_missing_from_the_schema_fails() {
    // The same check, on a bundle with one method removed: the failure is the
    // one a real Codex update would cause, and it names what went.
    let doctored = CLIENT_REQUEST.replace("\"turn/steer\"", "\"turn/steer-removed\"");
    assert_ne!(doctored, CLIENT_REQUEST, "the test's own edit has to change the document");
    let schema = PinnedSchema::from_documents(&doctored, CLIENT_NOTIFICATION, SERVER_REQUEST, SERVER_NOTIFICATION)
        .expect("the doctored bundle still parses");
    assert_eq!(schema.missing(METHODS), vec!["turn/steer"]);
    let sentence = schema.first_missing(METHODS).expect("a sentence naming the gap");
    assert!(sentence.contains("turn/steer") && sentence.contains("ClientRequest"), "{sentence}");

    // Each of the other three documents is checked too, so a removal from any
    // one of them fails rather than only the first.
    let mutations = [("initialized", 1u8), ("item/tool/requestUserInput", 2), ("turn/completed", 3)];
    for (method, which) in mutations {
        let source = match which {
            1 => CLIENT_NOTIFICATION,
            2 => SERVER_REQUEST,
            _ => SERVER_NOTIFICATION,
        };
        let doctored = source.replace(&format!("\"{method}\""), "\"removed-method\"");
        assert_ne!(doctored, source, "{method} has to be in its own document");
        let (a, b, c, d) = match which {
            1 => (CLIENT_REQUEST, doctored.as_str(), SERVER_REQUEST, SERVER_NOTIFICATION),
            2 => (CLIENT_REQUEST, CLIENT_NOTIFICATION, doctored.as_str(), SERVER_NOTIFICATION),
            _ => (CLIENT_REQUEST, CLIENT_NOTIFICATION, SERVER_REQUEST, doctored.as_str()),
        };
        let schema = PinnedSchema::from_documents(a, b, c, d).expect("the doctored bundle still parses");
        assert_eq!(schema.missing(METHODS), vec![method], "{method} is pinned in its own document");
    }
}

/// A drive-rooted path or a UNC path: neither may be committed, because the pin
/// has to be the same file on every machine.
fn absolute_path_in(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for (index, window) in bytes.windows(3).enumerate() {
        // A path starts a JSON value, so the letter is preceded by a delimiter.
        // Without that, `http://json-schema.org` would look like a drive.
        let before = if index == 0 { b' ' } else { bytes[index - 1] };
        if !matches!(before, b'"' | b'\'' | b' ' | b':' | b'=' | b',' | b'(' | b'[' | b'{') { continue; }
        if window[0].is_ascii_alphabetic() && window[1] == b':' && (window[2] == b'\\' || window[2] == b'/') {
            let end = (index + 48).min(text.len());
            return Some(text[index..end].to_owned());
        }
    }
    text.find("\"\\\\").map(|index| text[index..(index + 48).min(text.len())].to_owned())
}

#[test]
fn the_pinned_schema_holds_no_absolute_paths() {
    let documents: [(&str, &str); 6] = [
        ("ClientRequest.json", CLIENT_REQUEST),
        ("ClientNotification.json", CLIENT_NOTIFICATION),
        ("ServerRequest.json", SERVER_REQUEST),
        ("ServerNotification.json", SERVER_NOTIFICATION),
        ("compat/RawResponseItemCompletedNotification.json", COMPAT_RAW_RESPONSE_ITEM),
        ("compat/AgentMessageDeltaNotification.json", COMPAT_AGENT_MESSAGE_DELTA),
    ];
    for (name, text) in documents {
        assert!(text.len() > 200, "{name} is not empty");
        assert_eq!(absolute_path_in(text), None, "{name} holds a path from the machine that generated it");
    }
    // The scan is not vacuous: it finds one when there is one.
    assert!(absolute_path_in(r#"{"cwd":"C:\\work"}"#).is_some());
    assert!(absolute_path_in(r#"{"cwd":"\\\\server\\share"}"#).is_some());
}

#[test]
fn the_two_compatibility_names_are_pinned_types_not_union_members() {
    // Both names are real payloads this adapter handles for older builds, and
    // the current bundle no longer lists them. Pinning the *type* keeps the
    // entry honest, and this asserts they have not quietly joined the union.
    let schema = PinnedSchema::pinned();
    let names = [COMPAT[0], COMPAT[1]];
    assert_eq!(names.len(), 2, "two compatibility names, one per older spelling");
    for CompatUse { method, document, reason } in names {
        assert!(!schema.known_anywhere(method), "{method} is in the union now; move it into METHODS");
        assert!(!reason.is_empty(), "{method} needs its reason");
        let text = match document {
            "AgentMessageDeltaNotification" => COMPAT_AGENT_MESSAGE_DELTA,
            "RawResponseItemCompletedNotification" => COMPAT_RAW_RESPONSE_ITEM,
            other => panic!("{other} is not a pinned compatibility type"),
        };
        assert!(text.contains(&format!("\"title\": \"{document}\"")), "{document} is the pinned type");
    }
    let raw = COMPAT.iter().find(|compat| compat.method == "rawResponseItem/completed").expect("the raw item entry");
    assert!(raw.reason.contains("no event"), "the raw item maps to no event, on purpose");
    assert!(METHODS.iter().all(|MethodUse { method, .. }| *method != raw.method), "a compat name is not also a pinned use");
}
