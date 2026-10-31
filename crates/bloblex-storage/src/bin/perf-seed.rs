//! Phase 5, section 9: the seeded database behind `scripts/perf-gate.mjs`.
//!
//! It writes a database shaped like a busy owner's: one bot, 200 conversations
//! and 2,000 messages by default, every conversation at rest so a lazy snapshot
//! really skips the older ones. It goes through `Storage`'s own API rather than
//! raw SQL, so the schema rules (checks, indexes, migrations) apply as they do
//! in the app and a schema change breaks this seeder instead of silently
//! producing a database the daemon refuses.
//!
//! Usage: `perf-seed --db <path> [--conversations 200] [--messages 2000]`
//! The file is replaced, never appended. It prints one JSON line.

use bloblex_storage::Storage;
use serde_json::{json, Value};
use std::path::Path;

const RUNTIME_ID: &str = "perf-runtime";
/// Realistic message text: long enough that snapshot bytes mean something, and
/// inert, so nothing here is mistaken for a command.
const MESSAGE_TEXT: &str = "The migration adds the accounts table, then rewrites the two queries that join on the provider column. I checked the index plan before and after, and both keep the covering index. Tests for the new path are next; the existing suite still passes.";

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|value| value == name).and_then(|at| args.get(at + 1)).cloned()
}

fn positive(args: &[String], name: &str, fallback: usize) -> Result<usize, String> {
    match arg(args, name) {
        None => Ok(fallback),
        Some(value) => match value.parse::<usize>() {
            Ok(parsed) if parsed > 0 => Ok(parsed),
            _ => Err(format!("{name} must be a positive number of items")),
        },
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = arg(&args, "--db").ok_or("usage: perf-seed --db <path> [--conversations 200] [--messages 2000]")?;
    let conversations = positive(&args, "--conversations", 200)?;
    let messages = positive(&args, "--messages", 2000)?;
    let path = Path::new(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    for suffix in ["", "-wal", "-shm"] {
        let sidecar = format!("{}{suffix}", path.display());
        if Path::new(&sidecar).exists() {
            std::fs::remove_file(sidecar)?;
        }
    }
    let store = Storage::open(path)?;
    let runtime: Value = json!({
        "id": RUNTIME_ID,
        "hostId": "host_windows_local",
        "provider": "codex",
        "protocolFamily": "local",
        "displayName": "Codex",
        "executablePath": "C:/perf/codex.exe",
        "version": "0.165.0",
        "authState": "authenticated",
        "status": "online",
        "account": null
    });
    store.upsert_runtime(&runtime)?;
    let (agent, _) = store.agent_create(&json!({
        "name": "Perf",
        "runtimeId": RUNTIME_ID,
        "description": "Seeded for the performance gate.",
        "color": "mint"
    }))?;
    let agent_id = agent["id"].as_str().unwrap_or_default().to_owned();
    let per_conversation = messages / conversations;
    let remainder = messages % conversations;
    let mut written = 0usize;
    for index in 0..conversations {
        let id = format!("perf-session-{index:04}");
        store.create_session_for_agent(
            &id,
            RUNTIME_ID,
            "codex",
            &format!("C:/perf/project-{}", index % 8),
            &format!("Perf conversation {index}"),
            Some(&agent_id),
        )?;
        // `create_session_for_agent` writes `starting`, which a snapshot counts
        // as not at rest; at rest is what makes an older conversation lazy.
        store.update_session_state(&id, "idle")?;
        let count = per_conversation + usize::from(index < remainder);
        for message in 0..count {
            let role = if message % 2 == 0 { "user" } else { "agent" };
            store.append_message(&id, "", role, &format!("{MESSAGE_TEXT} ({index}.{message})"))?;
            written += 1;
        }
    }
    println!(
        "{}",
        json!({"db": path.display().to_string(), "conversations": conversations, "messages": written, "agentId": agent_id})
    );
    Ok(())
}
