//! Times the reads the window makes constantly, on a copy of a real database.
//!
//! `app.snapshot` had never been timed end to end on the owner's data: one note
//! said 304 ms (lazy) and a separate read pass said about 1.7 s. This binary
//! settles it. It opens a database *copy* through `Storage` (the same open the
//! daemon does, indexes and all) and reports:
//!
//! - `lazy` and `full` snapshot wall time and JSON size, repeated;
//! - the time the per-session context lookup takes in total, plus the plan
//!   SQLite chooses for it, so a new index can be proved;
//! - how long `settings.get` waits while a snapshot is being built, which is
//!   what a single `Mutex<Connection>` costs;
//! - one message delta write, which is what every streamed token pays.
//!
//! It is an example, not a test, so `cargo test` never runs it. Point it at a
//! file you copied yourself; it opens the file for writing.
//!
//! ```text
//! cargo run --release -p bloblex-storage --example snapshot-timing -- <db> [--runs 3] [--concurrent 20] [--index]
//! ```
//!
//! `--index` creates the context-event index first (the way the next launch
//! will), reports how long that took, its query plan before and after, and
//! whether every session's answer is unchanged. It prints one JSON line and
//! never prints row content.

use bloblex_storage::Storage;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// The query `session_context_locked` runs per session on every snapshot
/// (`crates/bloblex-storage/src/lib.rs`, "fn session_context_locked"). Kept
/// here verbatim so the plan this tool prints is the plan the daemon gets.
const CONTEXT_SQL: &str = "SELECT event_type,payload FROM app_events WHERE event_type IN ('session.context.updated','session.context.reset') AND json_valid(payload) AND json_extract(payload,'$.sessionId')=?1 ORDER BY sequence DESC LIMIT 1";

/// The partial indexes on the event log (`ensure_read_indexes` in
/// `crates/bloblex-storage/src/lib.rs`). Kept here verbatim for the same reason:
/// what this tool times is what startup runs.
const CONTEXT_INDEX_SQL: &str = "CREATE INDEX IF NOT EXISTS idx_app_events_session_context ON app_events(json_extract(payload,'$.sessionId'), sequence) WHERE event_type IN ('session.context.updated','session.context.reset') AND json_valid(payload)";
const TURN_INDEX_SQL: &str = "CREATE INDEX IF NOT EXISTS idx_app_events_turn_error ON app_events(json_extract(payload,'$.turnId'), sequence) WHERE event_type='turn.error' AND json_valid(payload)";
/// The detail read `session_detail_parts` runs once per turn (lib.rs, the
/// `turns` query). The `json_valid` is what lets the planner use the index.
const TURN_DETAIL_SQL: &str = "SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_valid(e.payload) AND json_extract(e.payload,'$.turnId')=?1 ORDER BY e.sequence DESC LIMIT 1";
/// The same read before this change, to prove `json_valid` changed no answer.
const TURN_DETAIL_SQL_BEFORE: &str = "SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_extract(e.payload,'$.turnId')=?1 ORDER BY e.sequence DESC LIMIT 1";

/// The one-conversation `json_object` query that starts `session_detail_parts`
/// in `crates/bloblex-storage/src/lib.rs`. Read out of that file rather than
/// copied, so this tool can never drift from what the daemon runs.
const LIB_RS: &str = include_str!("../src/lib.rs");

fn base_sql() -> &'static str {
    const MARK: &str = "let base:Option<String>=c.query_row(\"";
    let start = LIB_RS.find(MARK).expect("the base query in lib.rs") + MARK.len();
    let rest = &LIB_RS[start..];
    let end = rest.find("\",[id],").expect("the end of the base query in lib.rs");
    &rest[..end]
}

/// `SESSION_MESSAGES_SQL` from the same file: the message read a detailed
/// conversation runs, with its attachment, meta and reaction fields.
fn messages_sql() -> &'static str {
    const MARK: &str = "const SESSION_MESSAGES_SQL: &str = \"";
    let start = LIB_RS.find(MARK).expect("SESSION_MESSAGES_SQL in lib.rs") + MARK.len();
    let rest = &LIB_RS[start..];
    let end = rest.find("\";").expect("the end of SESSION_MESSAGES_SQL in lib.rs");
    &rest[..end]
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|value| value == name).and_then(|at| args.get(at + 1)).cloned()
}

fn positive(args: &[String], name: &str, fallback: usize) -> Result<usize, String> {
    match arg(args, name) {
        None => Ok(fallback),
        Some(value) => match value.parse::<usize>() {
            Ok(parsed) if parsed > 0 => Ok(parsed),
            _ => Err(format!("{name} must be a positive number")),
        },
    }
}

fn round(ms: f64) -> f64 { (ms * 10.0).round() / 10.0 }

/// Every non-archived session's context row, for proving an index changed
/// nothing about the answer.
type ContextRow = Option<(String, String)>;

fn context_rows(path: &std::path::Path, ids: &[String]) -> Result<Vec<ContextRow>, Box<dyn std::error::Error>> {
    let read = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = read.prepare(CONTEXT_SQL)?;
    let mut rows = Vec::new();
    for id in ids {
        rows.push(query.query_row([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok());
    }
    Ok(rows)
}

fn context_plan(path: &std::path::Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    plan_of(path, CONTEXT_SQL)
}

fn plan_of(path: &std::path::Path, sql: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let read = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = read.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    let rows = query.query_map(["probe"], |row| row.get::<_, String>(3))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn turn_ids(path: &std::path::Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let read = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = read.prepare("SELECT id FROM turns")?;
    let rows = query.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn turn_details(path: &std::path::Path, ids: &[String]) -> Result<Vec<Option<String>>, Box<dyn std::error::Error>> {
    details_with(path, TURN_DETAIL_SQL, ids)
}

fn details_with(path: &std::path::Path, sql: &str, ids: &[String]) -> Result<Vec<Option<String>>, Box<dyn std::error::Error>> {
    let read = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = read.prepare(sql)?;
    let mut rows = Vec::new();
    for id in ids {
        rows.push(query.query_row([id], |row| row.get::<_, Option<String>>(0)).ok().flatten());
    }
    Ok(rows)
}

fn session_ids(path: &std::path::Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let read = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = read.prepare("SELECT id FROM sessions WHERE archived=0")?;
    let rows = query.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Creates the indexes the way the next launch will, records how long each took
/// (they run once, at startup, against this database's real size), and proves
/// each query answers the same rows before and after.
fn create_indexes(path: &std::path::Path) -> Result<Value, Box<dyn std::error::Error>> {
    let ids = session_ids(path)?;
    let turns = turn_ids(path)?;
    // `Storage::open` already created what this build ships, so drop them
    // first: the run then measures the real "before" plan and the real cost of
    // building them once, on this file.
    {
        let write = Connection::open(path)?;
        write.execute_batch("DROP INDEX IF EXISTS idx_app_events_session_context; DROP INDEX IF EXISTS idx_app_events_turn_error;")?;
    }
    let context_plan_before = context_plan(path)?;
    let turn_plan_before = plan_of(path, TURN_DETAIL_SQL)?;
    let context_before = context_rows(path, &ids)?;
    let turns_before = turn_details(path, &turns)?;
    // The added `json_valid` must not change what a turn's detail reads.
    let turns_without_json_valid = details_with(path, TURN_DETAIL_SQL_BEFORE, &turns)?;
    let mut created = serde_json::Map::new();
    for (name, sql) in [("context", CONTEXT_INDEX_SQL), ("turnError", TURN_INDEX_SQL)] {
        let started = Instant::now();
        {
            let write = Connection::open(path)?;
            write.execute_batch(sql)?;
        }
        created.insert(name.to_owned(), json!(round(started.elapsed().as_secs_f64() * 1000.0)));
    }
    let context_after = context_rows(path, &ids)?;
    let turns_after = turn_details(path, &turns)?;
    Ok(json!({
        "createMs": created,
        "context": {
            "planBefore": context_plan_before,
            "planAfter": context_plan(path)?,
            "sessions": ids.len(),
            "sessionsWithAContextRow": context_before.iter().filter(|row| row.is_some()).count(),
            "resultsIdentical": context_before == context_after,
        },
        "turnDetail": {
            "planBefore": turn_plan_before,
            "planAfter": plan_of(path, TURN_DETAIL_SQL)?,
            "turns": turns.len(),
            "turnsWithADetail": turns_before.iter().filter(|row| row.is_some()).count(),
            "resultsIdentical": turns_before == turns_after,
            "jsonValidChangedNothing": turns_without_json_valid == turns_after,
        },
    }))
}

/// One snapshot timed: wall time, JSON size and what it carried.
fn one_snapshot(store: &Storage, keep: Option<usize>) -> Result<Value, Box<dyn std::error::Error>> {
    let started = Instant::now();
    let value = store.snapshot_with(keep)?;
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let bytes = serde_json::to_vec(&value)?.len();
    let sessions = value["sessions"].as_array().map(Vec::len).unwrap_or(0);
    let partial = value["sessions"].as_array().map(|rows| rows.iter().filter(|row| row["partial"] == true).count()).unwrap_or(0);
    Ok(json!({
        "ms": round(elapsed),
        "bytes": bytes,
        "sessions": sessions,
        "partial": partial,
        "messages": value["sessions"].as_array().map(|rows| rows.iter().map(|row| row["messages"].as_array().map(Vec::len).unwrap_or(0)).sum::<usize>()).unwrap_or(0),
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = arg(&args, "--db").or_else(|| args.first().filter(|value| !value.starts_with("--")).cloned())
        .ok_or("usage: snapshot-timing <db path> [--runs 3] [--concurrent 20] [--index]")?;
    let runs = positive(&args, "--runs", 3)?;
    let concurrent = positive(&args, "--concurrent", 20)?;
    let path = std::path::PathBuf::from(&path);

    // `Storage` first: it recovers the write-ahead log, so the read-only
    // connections below find a settled file with its shared-memory index.
    let opened = Instant::now();
    let store = Arc::new(Storage::open(&path)?);
    let open_ms = round(opened.elapsed().as_secs_f64() * 1000.0);

    // Database shape, read straight from the file, so a slow run can be judged
    // by what it had to read.
    let shape = {
        let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let count = |sql: &str| read.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap_or(-1);
        json!({
            "fileMb": std::fs::metadata(&path).map(|meta| (meta.len() / 1_048_576) as i64).unwrap_or(-1),
            "journalMode": read.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0)).unwrap_or_default(),
            "sessions": count("SELECT COUNT(*) FROM sessions WHERE archived=0"),
            "messages": count("SELECT COUNT(*) FROM messages"),
            "toolCalls": count("SELECT COUNT(*) FROM tool_calls"),
            "turns": count("SELECT COUNT(*) FROM turns"),
            "usageEvents": count("SELECT COUNT(*) FROM usage_events"),
            "messageReactions": count("SELECT COUNT(*) FROM message_reactions"),
            "messages": count("SELECT COUNT(*) FROM messages"),
            "events": count("SELECT COUNT(*) FROM app_events"),
        })
    };
    // The scans a snapshot runs once, outside the per-conversation work: the
    // event high-water mark, the usage sums, and the approval cards.
    let once_ms = {
        let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let timed = |sql: &str| -> f64 {
            let started = Instant::now();
            for _ in 0..3 {
                let mut query = read.prepare(sql).expect("probe query");
                let rows = query.query_map([], |row| row.get::<_, Option<i64>>(0)).map(|rows| rows.count()).unwrap_or(0);
                let _ = rows;
            }
            round(started.elapsed().as_secs_f64() * 1000.0 / 3.0)
        };
        json!({
            "maxSequenceMs": timed("SELECT COALESCE(MAX(sequence),0) FROM app_events"),
            "usageSumsMs": timed("SELECT SUM(input_tokens)+SUM(output_tokens),0,0,0,0 FROM usage_events WHERE timestamp>='0000' AND timestamp<='9999'"),
        })
    };

    let mut lazy = Vec::new();
    let mut full = Vec::new();
    // With `--index`, the index is created first, the way the next launch will
    // create it, so the snapshot times below are the steady state after it.
    let index = if args.iter().any(|value| value == "--index") { Some(create_indexes(&path)?) } else { None };
    for _ in 0..runs {
        lazy.push(one_snapshot(&store, Some(15))?);
        full.push(one_snapshot(&store, None)?);
    }
    let times = |rows: &[Value]| rows.iter().filter_map(|row| row["ms"].as_f64()).collect::<Vec<_>>();
    let median = |mut values: Vec<f64>| {
        if values.is_empty() { return Value::Null; }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        json!(round(values[values.len() / 2]))
    };

    // The context lookup: every non-archived session asks once per snapshot.
    let ids: Vec<String> = session_ids(&path)?;
    let context_started = Instant::now();
    {
        let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut query = read.prepare(CONTEXT_SQL)?;
        for id in &ids {
            let _ = query.query_row([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok();
        }
    }
    let context_ms = round(context_started.elapsed().as_secs_f64() * 1000.0);
    // Where the rest of a snapshot's time goes. The tools read is the one the
    // 2026-11-01 note blamed: every row's `data` is a provider payload of
    // roughly 90 KB. `toolsIdsOnly` reads the same rows without their JSON, so
    // the difference is what parsing those blobs costs.
    let tools_sql = "SELECT json_object('id',id,'sessionId',session_id,'turnId',turn_id,'kind',json_extract(data,'$.kind'),'title',json_extract(data,'$.title'),'state',state,'startedAt',json_extract(data,'$.startedAt'),'completedAt',json_extract(data,'$.completedAt'),'parentToolCallId',json_extract(data,'$.parentToolCallId'),'detail',json(COALESCE(json_extract(data,'$.detail'),'{}'))) FROM tool_calls WHERE session_id=?1 ORDER BY rowid";
    let files_sql = "SELECT json_object('id',id,'turnId',turn_id,'path',path,'createdAt',json_extract(data,'$.createdAt'),'detail',json(COALESCE(json_extract(data,'$.detail'),'{}'))) FROM file_changes WHERE session_id=?1 ORDER BY rowid";
    let timed_over_sessions = |sql: &str| -> Result<f64, Box<dyn std::error::Error>> {
        let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut query = read.prepare(sql)?;
        let started = Instant::now();
        let mut rows = 0usize;
        for id in &ids {
            let batch = query.query_map([id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            rows += batch.len();
        }
        let elapsed = round(started.elapsed().as_secs_f64() * 1000.0);
        Ok(if rows == 0 { 0.0 } else { elapsed })
    };
    let tools_ms = timed_over_sessions(tools_sql)?;
    let tools_ids_ms = timed_over_sessions("SELECT id FROM tool_calls WHERE session_id=?1 ORDER BY rowid")?;
    let files_ms = timed_over_sessions(files_sql)?;
    // The messages read is the other per-conversation query. These two proxies
    // separate the message row itself from the per-message reaction lookup.
    let messages_plain_ms = timed_over_sessions("SELECT json_object('id',id,'content',content) FROM messages WHERE session_id=?1 ORDER BY sequence")?;
    let reactions_per_session_ms = timed_over_sessions("SELECT json_group_array(emoji) FROM message_reactions WHERE session_id=?1")?;
    // The whole detail read the window does when a conversation is opened
    // (`session.get`), and the same thing for every conversation: together they
    // say whether a snapshot's cost is per conversation or elsewhere.
    let detail_started = Instant::now();
    for id in ids.iter().take(5) { let _ = store.session_detail(id)?; }
    let detail_five_ms = round(detail_started.elapsed().as_secs_f64() * 1000.0);
    let detail_all_started = Instant::now();
    let mut per_session: Vec<(String, f64)> = Vec::new();
    for id in &ids {
        let started = Instant::now();
        let _ = store.session_detail(id)?;
        per_session.push((id.clone(), round(started.elapsed().as_secs_f64() * 1000.0)));
    }
    let detail_all_ms = round(detail_all_started.elapsed().as_secs_f64() * 1000.0);
    per_session.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    // The slowest conversation, and each of its parts read on its own, so a
    // cost that is NOT the parts shows up as a gap.
    let slowest = per_session.first().cloned();
    let mut slowest_parts = Value::Null;
    if let Some((id, ms)) = &slowest {
        let one = |sql: &str| -> f64 {
            let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).expect("probe");
            let mut query = read.prepare(sql).expect("probe query");
            let started = Instant::now();
            let rows = query.query_map([id], |row| row.get::<_, String>(0)).map(|rows| rows.collect::<Result<Vec<_>, _>>()).unwrap_or(Ok(Vec::new())).unwrap_or_default();
            let _ = rows;
            round(started.elapsed().as_secs_f64() * 1000.0)
        };
        let max_data_kb = {
            let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).expect("probe");
            read.query_row("SELECT COALESCE(MAX(length(data)),0)/1024 FROM messages WHERE session_id=?1", [id], |row| row.get::<_, i64>(0)).unwrap_or(-1)
        };
        // What the snapshot pays on top of the SQL: parsing each row's JSON, and
        // the extra `json!()` round trip the assembly does over the same values.
        let json_cost = {
            let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).expect("probe");
            let mut query = read.prepare(tools_sql).expect("probe query");
            let rows: Vec<String> = query.query_map([id], |row| row.get::<_, String>(0)).map(|rows| rows.collect::<Result<Vec<_>, _>>()).unwrap_or(Ok(Vec::new())).unwrap_or_default();
            let parse_started = Instant::now();
            let values: Vec<Value> = rows.iter().filter_map(|text| serde_json::from_str(text).ok()).collect();
            let parse_ms = round(parse_started.elapsed().as_secs_f64() * 1000.0);
            let round_started = Instant::now();
            let _ = json!(values);
            json!({"parseMs": parse_ms, "jsonMacroMs": round(round_started.elapsed().as_secs_f64() * 1000.0), "rows": rows.len()})
        };
        slowest_parts = json!({
            "sessionMs": ms,
            "baseQueryMs": one(base_sql()),
            "toolsMs": one(tools_sql),
            "messagesMs": one("SELECT json_object('id',id,'content',content) FROM messages WHERE session_id=?1 ORDER BY sequence"),
            "messagesFullMs": one(messages_sql()),
            "turnsMs": one("SELECT json_object('id',id) FROM turns WHERE session_id=?1 ORDER BY created_at"),
            "maxMessageDataKb": max_data_kb,
            "toolsJson": json_cost,
        });
    }
    // The detail read each turn does in a detailed conversation: another
    // `json_extract` over the whole event log, one full scan per turn.
    let (turns_total, turns_ms, turns_plan) = {
        let turn_ids = turn_ids(&path)?;
        let started = Instant::now();
        let _ = turn_details(&path, &turn_ids)?;
        let ms = round(started.elapsed().as_secs_f64() * 1000.0);
        (turn_ids.len(), ms, plan_of(&path, TURN_DETAIL_SQL)?)
    };
    let plan = context_plan(&path)?;

    // What one streamed token costs: the write `append_typed_message_delta`
    // does, then the `message.delta` event row the daemon persists with it.
    let delta = {
        let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        read.query_row("SELECT id FROM sessions WHERE archived=0 ORDER BY updated_at DESC LIMIT 1", [], |row| row.get::<_, String>(0)).ok()
    };
    let mut delta_ms = Value::Null;
    if let Some(session) = delta {
        let started = Instant::now();
        let rounds = 200;
        for index in 0..rounds {
            let bytes = if index % 2 == 0 { "The migration adds the accounts " } else { "table, then rewrites two queries. " };
            let _ = store.append_message_delta(&session, "", bytes);
            let _ = store.push_event("message.delta", &json!({"sessionId":session,"probe":true}));
        }
        delta_ms = json!(round(started.elapsed().as_secs_f64() * 1000.0 / rounds as f64));
    }

    // What a read waits for while a snapshot is being built. A snapshot holds
    // the one connection lock for its whole run; `settings.get` is what Settings
    // opens with.
    let stop = Arc::new(AtomicBool::new(false));
    let worker = {
        let store = Arc::clone(&store);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut done = 0usize;
            while !stop.load(Ordering::Relaxed) {
                if store.snapshot_with(None).is_ok() { done += 1; }
            }
            done
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(50));
    let mut waits = Vec::new();
    for _ in 0..concurrent {
        let started = Instant::now();
        let _ = store.settings()?;
        waits.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    stop.store(true, Ordering::Relaxed);
    let snapshots_during = worker.join().unwrap_or(0);
    waits.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    println!("{}", json!({
        "db": path.display().to_string(),
        "shape": shape,
        "oncePerSnapshotMs": once_ms,
        "openMs": open_ms,
        "lazyMs": times(&lazy),
        "lazyMedianMs": median(times(&lazy)),
        "lazyBytes": lazy.first().map(|row| row["bytes"].clone()),
        "lazyPartial": lazy.first().map(|row| row["partial"].clone()),
        "fullMs": times(&full),
        "fullMedianMs": median(times(&full)),
        "fullBytes": full.first().map(|row| row["bytes"].clone()),
        "contextLookupTotalMs": context_ms,
        "contextQueryPlan": plan,
        "contextSessions": ids.len(),
        "contextIndex": index,
        "toolsAllSessionsMs": tools_ms,
        "toolsIdsOnlyMs": tools_ids_ms,
        "filesAllSessionsMs": files_ms,
        "messagesPlainAllSessionsMs": messages_plain_ms,
        "reactionsPerSessionMs": reactions_per_session_ms,
        "sessionDetailFiveMs": detail_five_ms,
        "sessionDetailAllMs": detail_all_ms,
        "slowestSession": slowest_parts,
        "perSessionMs": per_session.iter().map(|(_, ms)| *ms).collect::<Vec<_>>(),
        "turnErrorLookup": {"turns": turns_total, "ms": turns_ms, "plan": turns_plan},
        "deltaWriteMs": delta_ms,
        "settingsWhileSnapshotting": {
            "requests": waits.len(),
            "snapshotsCompleted": snapshots_during,
            "medianMs": round(waits.get(waits.len() / 2).copied().unwrap_or(0.0)),
            "maxMs": round(waits.last().copied().unwrap_or(0.0)),
        },
    }));
    Ok(())
}
