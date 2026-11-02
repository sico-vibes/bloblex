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
//! - one message delta write, which is what every streamed token pays;
//! - what changing effort and assigning a task cost, idle and while every
//!   conversation is read back to back, and the same again with
//!   `synchronous=NORMAL` (the shipped value stays `FULL`);
//! - one conversation opened on its own, cold and warm, and the same row read
//!   without its transcript.
//!
//! `--plans` prints only the query plans of the per-turn `turn.error` lookup in
//! its several shapes; it answered why a conversation cost 250 to 400 ms while
//! each statement measured under 10 ms (2026-11-01).
//!
//! It is an example, not a test, so `cargo test` never runs it. Point it at a
//! file you copied yourself; it opens the file for writing.
//!
//! ```text
//! cargo run --release -p bloblex-storage --example snapshot-timing -- <db> [--runs 3] [--concurrent 20] [--index] [--plans]
//! ```
//!
//! `--index` creates the context-event index first (the way the next launch
//! will), reports how long that took, its query plan before and after, and
//! whether every session's answer is unchanged. It prints one JSON line and
//! never prints row content.
#![recursion_limit = "512"]

use bloblex_storage::Storage;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;

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

/// The `turns` read `session_detail_parts` runs, read out of `lib.rs` for the
/// same reason: it is the one statement whose shape (a correlated subquery over
/// the event log, once per turn) can quietly become a scan.
fn turns_sql() -> &'static str {
    const MARK: &str = "turns=query_jsons(c,\"";
    let start = LIB_RS.find(MARK).expect("the turns query in lib.rs") + MARK.len();
    let rest = &LIB_RS[start..];
    let end = rest.find("\",id)?;").expect("the end of the turns query in lib.rs");
    &rest[..end]
}

fn arg(args: &[String], name: &str) -> Option<String> {    args.iter().position(|value| value == name).and_then(|at| args.get(at + 1)).cloned()
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

/// The correlated form the code used before 2026-11-01, asked for one turn the
/// way `session_detail_parts` asked for it. Used only to prove the per-turn
/// lookup answers the same thing.
const TURN_DETAIL_CORRELATED_SQL: &str = "SELECT (SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_valid(e.payload) AND json_extract(e.payload,'$.turnId')=t.id ORDER BY e.sequence DESC LIMIT 1) FROM turns t WHERE t.id=?1";

fn turn_details_correlated(path: &std::path::Path, ids: &[String]) -> Result<Vec<Option<String>>, Box<dyn std::error::Error>> {
    details_with(path, TURN_DETAIL_CORRELATED_SQL, ids)
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
        .ok_or("usage: snapshot-timing <db path> [--runs 3] [--concurrent 20] [--index] [--plans]")?;
    let runs = positive(&args, "--runs", 3)?;
    let concurrent = positive(&args, "--concurrent", 20)?;
    let path = std::path::PathBuf::from(&path);

    // `--plans` answers one question only: which shape of the per-turn
    // `turn.error` lookup the planner will run as an index search rather than a
    // full scan of the event log. It prints plans and exits.
    if args.iter().any(|value| value == "--plans") {
        let candidates: [(&str, &str); 5] = [
            ("current (alias, ORDER BY sequence DESC, LIMIT 1)", "SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_valid(e.payload) AND json_extract(e.payload,'$.turnId')=?1 ORDER BY e.sequence DESC LIMIT 1"),
            ("no alias, ORDER BY sequence DESC, LIMIT 1", "SELECT json_extract(payload,'$.detail') FROM app_events WHERE event_type='turn.error' AND json_valid(payload) AND json_extract(payload,'$.turnId')=?1 ORDER BY sequence DESC LIMIT 1"),
            ("alias, no ORDER BY", "SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_valid(e.payload) AND json_extract(e.payload,'$.turnId')=?1"),
            ("alias, MAX(sequence) form", "SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_valid(e.payload) AND e.sequence=(SELECT MAX(x.sequence) FROM app_events x WHERE x.event_type='turn.error' AND json_valid(x.payload) AND json_extract(x.payload,'$.turnId')=?1) AND json_extract(e.payload,'$.turnId')=?1"),
            ("correlated, no alias, ORDER BY sequence DESC, LIMIT 1", "SELECT json_extract(payload,'$.detail') FROM app_events WHERE event_type='turn.error' AND json_valid(payload) AND json_extract(payload,'$.turnId')=t.id ORDER BY sequence DESC LIMIT 1"),
        ];
        let read = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut out = serde_json::Map::new();
        for (name, sql) in candidates {
            let probe = if sql.contains("t.id") {
                "SELECT (SELECT json_object('x',(SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_valid(e.payload) AND json_extract(e.payload,'$.turnId')=t.id ORDER BY e.sequence DESC LIMIT 1))) FROM turns t LIMIT 1".to_owned()
            } else { format!("SELECT ({sql})") };
            let plan = {
                let probe = probe.replace("?1", "'probe'");
                let mut q = read.prepare(&format!("EXPLAIN QUERY PLAN {probe}"))?;
                let rows = q.query_map([], |row| row.get::<_, String>(3))?;
                let collected: Result<Vec<_>, _> = rows.collect();
                collected?
            };
            out.insert(name.to_owned(), json!(plan));
        }
        println!("{}", json!(out));
        return Ok(());
    }

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
    let mut lazy_keep15 = Vec::new();
    let mut full = Vec::new();
    // With `--index`, the index is created first, the way the next launch will
    // create it, so the snapshot times below are the steady state after it.
    let index = if args.iter().any(|value| value == "--index") { Some(create_indexes(&path)?) } else { None };
    for _ in 0..runs {
        // 0 is what ships since 2026-11-01: every at-rest conversation as a
        // summary. 15 is what it was, kept here for the comparison.
        lazy.push(one_snapshot(&store, Some(0))?);
        lazy_keep15.push(one_snapshot(&store, Some(15))?);
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
    let turns_real_ms = timed_over_sessions(turns_sql())?;
    let turns_real_plan = plan_of(&path, turns_sql())?;
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
    // The same loop again, with the page cache now holding these rows. The gap
    // between the two passes is disk I/O on the tool payloads; the gap between
    // this pass and the id-only read below is what parsing them costs.
    let mut warm_session: Vec<f64> = Vec::new();
    for id in &ids {
        let started = Instant::now();
        let _ = store.session_detail(id)?;
        warm_session.push(round(started.elapsed().as_secs_f64() * 1000.0));
    }
    warm_session.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let warm_median = warm_session.get(warm_session.len() / 2).copied().unwrap_or(0.0);
    // The slowest conversation opened ten times in a row, and the same row read
    // without its transcript. If the repeats stay slow while the page cache is
    // holding the rows, the cost is the work SQLite does on the payloads, not
    // getting them off the disk.
    let mut repeat_ms: Vec<f64> = Vec::new();
    let mut row_only_ms: Vec<f64> = Vec::new();
    if let Some((id, _)) = per_session.first() {
        for _ in 0..10 {
            let started = Instant::now();
            let _ = store.session_detail(id)?;
            repeat_ms.push(round(started.elapsed().as_secs_f64() * 1000.0));
            let started = Instant::now();
            let _ = store.session_execution_row(id)?;
            row_only_ms.push(round(started.elapsed().as_secs_f64() * 1000.0));
        }
    }
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
    // The same answer, from the form that scanned the event log once per turn.
    let (turns_correlated_ms, turns_identical) = {
        let turn_ids = turn_ids(&path)?;
        let started = Instant::now();
        let correlated = turn_details_correlated(&path, &turn_ids)?;
        let correlated_ms = round(started.elapsed().as_secs_f64() * 1000.0);
        let per_turn = turn_details(&path, &turn_ids)?;
        (correlated_ms, correlated == per_turn)
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

    // ── 2026-11-01: what a save costs, idle and behind a background load ────
    //
    // The storage work behind the two actions the owner named. `agent.update`
    // and `session.model.update` are one RPC each; what is timed here is every
    // storage call those RPCs make, in the order they make them, including the
    // writer-lock waits. The daemon's own wrapper (catalog cache, JSON) is not
    // in it, and is reported as not measured. `task.create` plus
    // `task.dispatch` is the same for assigning a task; the dispatch is claimed
    // as `queued`, because the other branch starts a provider session and this
    // tool never starts one.
    let probe = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let effort_agent = probe.query_row("SELECT id FROM agents WHERE archived=0 AND locked=0 ORDER BY sort_order LIMIT 1", [], |row| row.get::<_, String>(0)).ok();
    let effort_session = probe.query_row("SELECT s.id FROM sessions s JOIN agents a ON a.id=s.agent_id WHERE s.archived=0 AND a.archived=0 AND a.locked=0 ORDER BY s.updated_at DESC LIMIT 1", [], |row| row.get::<_, String>(0)).ok();
    let effort_model = store.snapshot().ok().and_then(|s| s["agents"].as_array().and_then(|rows| rows.iter().find(|row| Some(row["id"].as_str().unwrap_or("")) == effort_agent.as_deref()).and_then(|row| row["model"].as_str().map(str::to_owned))));
    let assign_bot = effort_agent.clone();

    let median5 = |values: &[f64]| -> Value {
        if values.is_empty() { return Value::Null; }
        let mut sorted = values.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        json!(round(sorted[sorted.len() / 2]))
    };
    let run_five = |flow: &dyn Fn(usize) -> Result<(), String>| -> Vec<f64> {
        let mut out = Vec::new();
        for index in 0..5 {
            let started = Instant::now();
            if flow(index).is_err() { return Vec::new(); }
            out.push(round(started.elapsed().as_secs_f64() * 1000.0));
        }
        out
    };

    let effort_flow = |index: usize| -> Result<(), String> {
        let (agent_id, session_id) = match (&effort_agent, &effort_session) { (Some(a), Some(s)) => (a.clone(), s.clone()), _ => return Err("no writable bot or conversation".into()) };
        let level = if index.is_multiple_of(2) { "high" } else { "low" };
        // agent.update: the row, then the settings the execution gates read.
        store.agent_get(&agent_id).map_err(|e| e.to_string())?;
        store.settings().map_err(|e| e.to_string())?;
        store.default_approval_mode().map_err(|e| e.to_string())?;
        // session.model.update: the conversation's row and context only.
        let row = store.session_execution_row(&session_id).map_err(|e| e.to_string())?;
        let model = row["modelLock"]["model"].as_str().or(effort_model.as_deref()).unwrap_or("").to_owned();
        store.agent_update(&agent_id, &json!({"thinking": level})).map_err(|e| e.to_string())?;
        store.session_apply_model_change(&session_id, &json!({"model": model, "thinking": level}), false).map_err(|e| e.to_string())?;
        store.session_event_summary(&session_id).map_err(|e| e.to_string())?;
        Ok(())
    };
    // The same flow as it was before 2026-11-01, reading the whole conversation
    // to get its model lock. The difference is the cost of that read.
    let effort_flow_full = |index: usize| -> Result<(), String> {
        let (agent_id, session_id) = match (&effort_agent, &effort_session) { (Some(a), Some(s)) => (a.clone(), s.clone()), _ => return Err("no writable bot or conversation".into()) };
        let level = if index.is_multiple_of(2) { "high" } else { "low" };
        store.agent_get(&agent_id).map_err(|e| e.to_string())?;
        store.settings().map_err(|e| e.to_string())?;
        store.default_approval_mode().map_err(|e| e.to_string())?;
        let row = store.session_detail(&session_id).map_err(|e| e.to_string())?;
        let model = row["modelLock"]["model"].as_str().or(effort_model.as_deref()).unwrap_or("").to_owned();
        store.agent_update(&agent_id, &json!({"thinking": level})).map_err(|e| e.to_string())?;
        store.session_apply_model_change(&session_id, &json!({"model": model, "thinking": level}), false).map_err(|e| e.to_string())?;
        store.session_event_summary(&session_id).map_err(|e| e.to_string())?;
        Ok(())
    };
    let assign_flow = |index: usize| -> Result<(), String> {
        let bot = assign_bot.clone().ok_or("no writable bot")?;
        let task = store.task_create(&json!({"title": format!("timing probe {index}"), "brief": "one measurement", "doneGoal": "", "reportBack": ""})).map_err(|e| e.to_string())?;
        let id = task["id"].as_str().unwrap_or("").to_owned();
        let version = task["version"].as_i64().unwrap_or(1);
        store.task_get(&id).map_err(|e| e.to_string())?;
        store.agent_get(&bot).map_err(|e| e.to_string())?;
        store.settings().map_err(|e| e.to_string())?;
        let key = format!("timing-{index}-{}", Uuid::new_v4());
        store.task_dispatch_claim(&id, &bot, version, &key, true, Some("timing_probe")).map_err(|e| e.to_string())?;
        Ok(())
    };

    let effort_idle = run_five(&effort_flow);
    let effort_full_read_idle = run_five(&effort_flow_full);
    let assign_idle = run_five(&assign_flow);

    // The background load the window used to run: every conversation read back
    // to back. While it runs, the same two flows are timed again, and a cheap
    // writer-lock read is sampled to show what a save would wait for.
    let stop_load = Arc::new(AtomicBool::new(false));
    let load = {
        let store = Arc::clone(&store);
        let stop = Arc::clone(&stop_load);
        let ids = ids.clone();
        std::thread::spawn(move || {
            let mut rounds = 0usize;
            while !stop.load(Ordering::Relaxed) {
                for id in &ids { let _ = store.session_detail(id); }
                rounds += 1;
            }
            rounds
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(50));
    let lock_probe_session = ids.first().cloned();
    let mut lock_waits: Vec<f64> = Vec::new();
    let mut effort_loaded: Vec<f64> = Vec::new();
    let mut effort_full_read_loaded: Vec<f64> = Vec::new();
    let mut assign_loaded: Vec<f64> = Vec::new();
    for index in 0..5 {
        if let Some(id) = &lock_probe_session {
            let started = Instant::now();
            let _ = store.session_state(id);
            lock_waits.push(round(started.elapsed().as_secs_f64() * 1000.0));
        }
        let started = Instant::now();
        if effort_flow(index).is_ok() { effort_loaded.push(round(started.elapsed().as_secs_f64() * 1000.0)); }
        let started = Instant::now();
        if effort_flow_full(index).is_ok() { effort_full_read_loaded.push(round(started.elapsed().as_secs_f64() * 1000.0)); }
        if let Some(id) = &lock_probe_session {
            let started = Instant::now();
            let _ = store.session_state(id);
            lock_waits.push(round(started.elapsed().as_secs_f64() * 1000.0));
        }
        let started = Instant::now();
        if assign_flow(index + 100).is_ok() { assign_loaded.push(round(started.elapsed().as_secs_f64() * 1000.0)); }
    }
    stop_load.store(true, Ordering::Relaxed);
    let load_rounds = load.join().unwrap_or(0);
    lock_waits.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    // The owner's decision is `synchronous=FULL`; this only reports what NORMAL
    // would save on the same flows, on this copy.
    store.set_write_synchronous("NORMAL").map_err(|e| e.to_string())?;
    let effort_normal = run_five(&effort_flow);
    let assign_normal = run_five(&assign_flow);
    store.set_write_synchronous("FULL").map_err(|e| e.to_string())?;

    // One conversation opened on its own: the median of every conversation, so
    // `session.get` has a per-conversation figure next to the snapshot's.
    let session_open_ms = median5(&per_session.iter().map(|(_, ms)| *ms).collect::<Vec<_>>());

    println!("{}", json!({

        "db": path.display().to_string(),
        "shape": shape,
        "oncePerSnapshotMs": once_ms,
        "openMs": open_ms,
        "lazyMs": times(&lazy),
        "lazyMedianMs": median(times(&lazy)),
        "lazyBytes": lazy.first().map(|row| row["bytes"].clone()),
        "lazyPartial": lazy.first().map(|row| row["partial"].clone()),
        "lazyKeep15Ms": times(&lazy_keep15),
        "lazyKeep15MedianMs": median(times(&lazy_keep15)),
        "lazyKeep15Bytes": lazy_keep15.first().map(|row| row["bytes"].clone()),
        "fullMs": times(&full),
        "fullMedianMs": median(times(&full)),
        "fullBytes": full.first().map(|row| row["bytes"].clone()),
        "contextLookupTotalMs": context_ms,
        "contextQueryPlan": plan,
        "contextSessions": ids.len(),
        "contextIndex": index,
        "toolsAllSessionsMs": tools_ms,
        "turnsRealAllSessionsMs": turns_real_ms,
        "turnsRealPlan": turns_real_plan,
        "toolsIdsOnlyMs": tools_ids_ms,
        "filesAllSessionsMs": files_ms,
        "messagesPlainAllSessionsMs": messages_plain_ms,
        "reactionsPerSessionMs": reactions_per_session_ms,
        "sessionDetailFiveMs": detail_five_ms,
        "sessionDetailAllMs": detail_all_ms,
        "slowestSession": slowest_parts,
        "perSessionMs": per_session.iter().map(|(_, ms)| *ms).collect::<Vec<_>>(),
        "turnErrorLookup": {"turns": turns_total, "ms": turns_ms, "plan": turns_plan},
        "turnDetailProof": {
            "turns": turns_total,
            "correlatedMs": turns_correlated_ms,
            "perTurnMs": turns_ms,
            "answersIdentical": turns_identical,
        },
        "deltaWriteMs": delta_ms,
        "settingsWhileSnapshotting": {
            "requests": waits.len(),
            "snapshotsCompleted": snapshots_during,
            "medianMs": round(waits.get(waits.len() / 2).copied().unwrap_or(0.0)),
            "maxMs": round(waits.last().copied().unwrap_or(0.0)),
        },
        "saveCases": ["effort (agent.update + session.model.update)", "assign (task.create + task.dispatch claim)"],
        "effortIdleMs": effort_idle,
        "effortIdleMedianMs": median5(&effort_idle),
        "effortFullReadIdleMs": effort_full_read_idle,
        "effortFullReadIdleMedianMs": median5(&effort_full_read_idle),
        "assignIdleMs": assign_idle,
        "assignIdleMedianMs": median5(&assign_idle),
        "effortDuringLoadMs": effort_loaded,
        "effortDuringLoadMedianMs": median5(&effort_loaded),
        "effortFullReadDuringLoadMs": effort_full_read_loaded,
        "effortFullReadDuringLoadMedianMs": median5(&effort_full_read_loaded),
        "assignDuringLoadMs": assign_loaded,
        "assignDuringLoadMedianMs": median5(&assign_loaded),
        "effortNormalMs": effort_normal,
        "effortNormalMedianMs": median5(&effort_normal),
        "assignNormalMs": assign_normal,
        "assignNormalMedianMs": median5(&assign_normal),
        "loadRounds": load_rounds,
        "writerLockWaitMedianMs": round(lock_waits.get(lock_waits.len() / 2).copied().unwrap_or(0.0)),
        "writerLockWaitMaxMs": round(lock_waits.last().copied().unwrap_or(0.0)),
        "writerLockWaitSamples": lock_waits.len(),
        "sessionOpenMedianMs": session_open_ms,
        "sessionOpenWarmMedianMs": round(warm_median),
        "perSessionWarmMs": warm_session,
        "slowestOpenedTenTimesMs": repeat_ms,
        "slowestRowOnlyMs": row_only_ms,
    }));
    Ok(())
}
