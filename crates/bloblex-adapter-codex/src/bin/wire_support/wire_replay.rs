//! Test-only wire-fixture recorder and replayer, shared (copied) by the three
//! fake CLI binaries. It is never compiled into a production adapter.
//!
//! Format and rationale: `docs/evidence/wire-fixtures.md`.
//!
//! * `BLOBLEX_WIRE_RECORD=<path>` records the fake's own inbound (`in`) and
//!   outbound (`out`) messages as redacted NDJSON.
//! * `--replay <file>` plays the recorded `out` messages back, matching every
//!   inbound message before emitting the `out` lines that follow it.
//!
//! Volatile fields are masked on both sides before an `in` comparison, so
//! recorded fixtures never need real ids, paths, timestamps or prompt text.
use serde_json::Value;
use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};

/// Placeholder for a masked volatile scalar (id, session, timestamp, uuid).
pub const MASKED: &str = "<masked>";
/// Placeholder for a masked absolute path.
pub const MASKED_PATH: &str = "<masked-path>";

/// Keys whose value is volatile for wire comparison and is masked in `in`
/// messages on both the recorded and the received side.
const VOLATILE_KEYS: &[&str] = &[
    "id",
    "session_id",
    "sessionId",
    "threadId",
    "turnId",
    "turn_id",
    "request_id",
    "requestId",
    "expectedTurnId",
    "provider_session_id",
    "tuid",
    "uuid",
    "timestamp",
    "createdAt",
    "updatedAt",
    "created_at",
    "updated_at",
    "startedAt",
    "completedAt",
    "resetsAt",
    "cwd",
];

struct Recorder {
    file: Mutex<Option<fs::File>>,
    start: Instant,
}

static RECORDER: OnceLock<Recorder> = OnceLock::new();

/// Initialise recording from the environment. Call once at process start.
pub fn init(provider: &str, cli_version: &str) {
    let path = env::var_os("BLOBLEX_WIRE_RECORD").map(PathBuf::from);
    let scenario = env::var("BLOBLEX_WIRE_SCENARIO").unwrap_or_else(|_| "recorded".to_owned());
    let _ = RECORDER.set(Recorder {
        file: Mutex::new(None),
        start: Instant::now(),
    });
    let Some(path) = path else { return };
    let header = serde_json::json!({
        "header": {
            "provider": provider,
            "cliVersion": cli_version,
            "scenario": scenario,
            "synthesised": true,
        }
    });
    if fs::write(&path, format!("{header}\n")).is_err() {
        return;
    }
    if let Ok(file) = fs::OpenOptions::new().append(true).open(&path) {
        if let Some(recorder) = RECORDER.get() {
            if let Ok(mut slot) = recorder.file.lock() {
                *slot = Some(file);
            }
        }
    }
}

/// Record an inbound message (adapter -> provider) with comparison masking.
pub fn input(msg: &Value) {
    let Some(recorder) = RECORDER.get() else { return };
    let mut value = msg.clone();
    mask_for_compare(&mut value);
    recorder.write("in", &value);
}

/// Record an outbound message (provider -> adapter) with value sanitisation.
pub fn out(msg: &Value) {
    let Some(recorder) = RECORDER.get() else { return };
    let mut value = msg.clone();
    sanitize(&mut value);
    recorder.write("out", &value);
}

impl Recorder {
    fn write(&self, dir: &str, msg: &Value) {
        let Ok(mut slot) = self.file.lock() else { return };
        let Some(file) = slot.as_mut() else { return };
        let t = self.start.elapsed().as_millis() as u64;
        let line = serde_json::json!({ "dir": dir, "t": t, "msg": msg });
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
    }
}

/// The `--replay <file>` path passed to this fake, if any.
pub fn replay_path_from_args() -> Option<PathBuf> {
    let mut iter = env::args().skip(1);
    while let Some(arg) = iter.next() {
        if arg == "--replay" {
            return iter.next().map(PathBuf::from);
        }
        if let Some(value) = arg.strip_prefix("--replay=") {
            return Some(PathBuf::from(value));
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dir {
    In,
    Out,
}

struct Entry {
    dir: Dir,
    msg: Value,
    line: usize,
}

struct Fixture {
    entries: Vec<Entry>,
}

fn load_fixture(path: &Path) -> Result<Fixture, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut entries = Vec::new();
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line).map_err(|e| format!("line {}: invalid JSON: {e}", index + 1))?;
        if value.get("header").is_some() {
            continue;
        }
        let dir = match value["dir"].as_str() {
            Some("in") => Dir::In,
            Some("out") => Dir::Out,
            other => return Err(format!("line {}: unknown dir {other:?}", index + 1)),
        };
        let msg = value["msg"].clone();
        if msg.is_null() {
            return Err(format!("line {}: missing msg", index + 1));
        }
        entries.push(Entry { dir, msg, line: index + 1 });
    }
    if entries.is_empty() {
        return Err("fixture has no entries".to_owned());
    }
    Ok(Fixture { entries })
}

/// Replay `path`. Returns the process exit code: 0 on success, 2 on any
/// fixture/input mismatch. The diagnostic is one safe stderr line that names
/// the fixture line and the differing JSON pointer, never the message body.
pub fn run_replay(path: &Path) -> i32 {
    let fixture = match load_fixture(path) {
        Ok(fixture) => fixture,
        Err(error) => {
            eprintln!("wire replay: {error}");
            return 2;
        }
    };
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let mut pending: Vec<Value> = Vec::new();
    let mut index = 0;
    // Provider-initiated lines before the first client input are emitted
    // immediately, matching the live fake's startup handshake (for example the
    // Claude `system/init` frame the adapter waits on).
    while index < fixture.entries.len() && fixture.entries[index].dir == Dir::Out {
        pending.push(fixture.entries[index].msg.clone());
        index += 1;
    }
    flush(&mut stdout, &mut pending);
    while index < fixture.entries.len() {
        let entry = &fixture.entries[index];
        match entry.dir {
            Dir::Out => {
                pending.push(entry.msg.clone());
                index += 1;
            }
            Dir::In => {
                flush(&mut stdout, &mut pending);
                let line = match lines.next() {
                    Some(Ok(line)) => line,
                    _ => return 0,
                };
                let received: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(_) => {
                        eprintln!("wire replay mismatch at fixture line {}: received non-JSON input", entry.line);
                        return 2;
                    }
                };
                let mut expected = entry.msg.clone();
                let mut actual = received;
                mask_for_compare(&mut expected);
                mask_for_compare(&mut actual);
                if expected != actual {
                    let mut pointer = String::new();
                    first_diff(&expected, &actual, &mut pointer);
                    let pointer = if pointer.is_empty() { "/".to_owned() } else { pointer };
                    eprintln!(
                        "wire replay mismatch at fixture line {}: JSON pointer {}",
                        entry.line, pointer
                    );
                    return 2;
                }
                index += 1;
            }
        }
    }
    flush(&mut stdout, &mut pending);
    // Keep the process alive for post-scenario housekeeping (for example ACP
    // `session/close`), answering requests generically so teardown is prompt.
    for line in lines {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value.get("id").is_some() && value.get("method").is_some() {
            let reply = serde_json::json!({ "jsonrpc": "2.0", "id": value["id"].clone(), "result": {} });
            if writeln!(stdout, "{reply}").is_err() {
                break;
            }
            let _ = stdout.flush();
        }
    }
    0
}

fn flush(stdout: &mut impl Write, pending: &mut Vec<Value>) {
    for message in pending.drain(..) {
        let _ = writeln!(stdout, "{message}");
    }
    let _ = stdout.flush();
}

fn first_diff(expected: &Value, actual: &Value, pointer: &mut String) -> bool {
    match (expected, actual) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let child = format!("{pointer}/{}", escape_pointer(key));
                match (left.get(key), right.get(key)) {
                    (Some(a), Some(b)) => {
                        let mut child_pointer = child.clone();
                        if first_diff(a, b, &mut child_pointer) {
                            *pointer = child_pointer;
                            return true;
                        }
                    }
                    _ => {
                        *pointer = child;
                        return true;
                    }
                }
            }
            false
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                *pointer = format!("{pointer}/{}", left.len().min(right.len()));
                return true;
            }
            for (index, (a, b)) in left.iter().zip(right.iter()).enumerate() {
                let mut child_pointer = format!("{pointer}/{index}");
                if first_diff(a, b, &mut child_pointer) {
                    *pointer = child_pointer;
                    return true;
                }
            }
            false
        }
        _ => expected != actual,
    }
}

fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Sanitise a value for recording: mask uuid-like and absolute-path strings.
fn sanitize(value: &mut Value) {
    sanitize_inner(value, false);
}

/// Mask everything that is volatile for an `in` comparison.
fn mask_for_compare(value: &mut Value) {
    sanitize_inner(value, true);
}

fn sanitize_inner(value: &mut Value, mask_keys: bool) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if mask_keys && VOLATILE_KEYS.contains(&key.as_str()) {
                    *child = Value::String(MASKED.to_owned());
                    continue;
                }
                sanitize_inner(child, mask_keys);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                sanitize_inner(item, mask_keys);
            }
        }
        Value::String(text) => {
            if is_uuid(text) {
                *text = MASKED.to_owned();
            } else if is_abs_path(text) {
                *text = MASKED_PATH.to_owned();
            }
        }
        _ => {}
    }
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    let expected = [8usize, 4, 4, 4, 12];
    groups.len() == expected.len()
        && groups.iter().zip(expected).all(|(group, len)| {
            group.len() == len && group.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn is_abs_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/'))
        || text.starts_with('/')
        || text.starts_with("\\\\")
}
