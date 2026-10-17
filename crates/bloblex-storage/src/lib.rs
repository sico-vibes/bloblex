use chrono::{DateTime, Datelike, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{backup::Backup, params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};
use thiserror::Error;
use uuid::Uuid;

mod experiments;
pub mod cron;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("storage lock poisoned")]
    Poisoned,
    #[error("invalid budget policy")]
    InvalidBudget,
    #[error("invalid pricing rule")]
    InvalidPricing,
    #[error("invalid agent")]
    InvalidAgent,
    #[error("invalid analytics request")]
    InvalidAnalytics,
    #[error("agent not found")]
    AgentNotFound,
    #[error("agent conflict")]
    AgentConflict,
    #[error("session is active")]
    SessionActive,
    #[error("filesystem: {0}")]
    Io(#[from] std::io::Error),
}

fn schema_v3_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger:i64=c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
    let pragma:i64=c.query_row("PRAGMA user_version",[],|r|r.get(0))?;
    let integrity:String=c.query_row("PRAGMA integrity_check",[],|r|r.get(0))?;
    let required=[("exec_snapshots","id"),("exec_snapshots","requested_json"),("sessions","first_exec_snapshot_id"),("sessions","latest_exec_snapshot_id"),("sessions","claude_instruction_sha256"),("sessions","codex_thread_instruction_sha256"),("sessions","opencode_cost_total"),("usage_events","exec_snapshot_id"),("usage_events","provider_update_id"),("usage_events","usage_status"),("usage_events","context_used"),("usage_events","context_size"),("usage_events","reported_cost_decimal"),("active_turn_reservations","turn_id")];
    if ledger!=3||pragma!=3||integrity!="ok"||c.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0))?!=0 { return Ok(false); }
    for (table,column) in required { if !c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",params![table,column],|r|r.get::<_,bool>(0))? { return Ok(false); } }
    for index in ["idx_exec_snapshots_session_time","idx_exec_snapshots_agent_time","idx_exec_snapshots_runtime_time","idx_usage_exec_snapshot","idx_usage_provider_update","idx_active_reservations_session","idx_active_reservations_agent"] {
        if !c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",[index],|r|r.get::<_,bool>(0))? { return Ok(false); }
    }
    Ok(true)
}

fn migrate_exec_snapshots(c:&mut Connection,path:Option<&Path>,backup_done:bool)->Result<(),StorageError>{
    let ledger:i64=c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
    let pragma:i64=c.query_row("PRAGMA user_version",[],|r|r.get(0))?;
    if ledger==3 { return if schema_v3_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger>3 { return if pragma==ledger { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger!=2||pragma!=2 { return Err(StorageError::InvalidAgent); }
    if let Some(p)=path { if !backup_done {verified_backup(c,p,2)?;} }
    let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let locked:i64=tx.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
    let locked_pragma:i64=tx.query_row("PRAGMA user_version",[],|r|r.get(0))?;
    if locked==3 { tx.commit()?; return if locked_pragma==3 { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if locked!=2||locked_pragma!=2 { return Err(StorageError::InvalidAgent); }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS exec_snapshots (id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,runtime_id TEXT NOT NULL,provider TEXT NOT NULL,created_at TEXT NOT NULL,requested_json TEXT NOT NULL CHECK(json_valid(requested_json)),applied_json TEXT NOT NULL CHECK(json_valid(applied_json)),evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),instruction_sha256 TEXT,adapter_flags_json TEXT NOT NULL CHECK(json_valid(adapter_flags_json)),status TEXT NOT NULL CHECK(status IN ('applied','partial','rejected','runtime_default')),UNIQUE(turn_id));
      CREATE INDEX IF NOT EXISTS idx_exec_snapshots_session_time ON exec_snapshots(session_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_exec_snapshots_agent_time ON exec_snapshots(agent_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_exec_snapshots_runtime_time ON exec_snapshots(runtime_id,created_at);
      CREATE TABLE IF NOT EXISTS active_turn_reservations(turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_reservations_session ON active_turn_reservations(session_id);
      CREATE INDEX IF NOT EXISTS idx_active_reservations_agent ON active_turn_reservations(agent_id);")?;
    for (table,column,ddl) in [
        ("sessions","first_exec_snapshot_id","ALTER TABLE sessions ADD COLUMN first_exec_snapshot_id TEXT REFERENCES exec_snapshots(id) ON DELETE SET NULL"),
        ("sessions","latest_exec_snapshot_id","ALTER TABLE sessions ADD COLUMN latest_exec_snapshot_id TEXT REFERENCES exec_snapshots(id) ON DELETE SET NULL"),
        ("sessions","claude_instruction_sha256","ALTER TABLE sessions ADD COLUMN claude_instruction_sha256 TEXT"),
        ("sessions","codex_thread_instruction_sha256","ALTER TABLE sessions ADD COLUMN codex_thread_instruction_sha256 TEXT"),
        ("sessions","opencode_cost_total","ALTER TABLE sessions ADD COLUMN opencode_cost_total TEXT"),
        ("usage_events","exec_snapshot_id","ALTER TABLE usage_events ADD COLUMN exec_snapshot_id TEXT REFERENCES exec_snapshots(id) ON DELETE SET NULL"),
        ("usage_events","provider_update_id","ALTER TABLE usage_events ADD COLUMN provider_update_id TEXT"),
        ("usage_events","usage_status","ALTER TABLE usage_events ADD COLUMN usage_status TEXT NOT NULL DEFAULT 'unreported' CHECK(usage_status IN ('reported','partial','unreported'))"),
        ("usage_events","context_used","ALTER TABLE usage_events ADD COLUMN context_used INTEGER"),
        ("usage_events","context_size","ALTER TABLE usage_events ADD COLUMN context_size INTEGER"),
        ("usage_events","reported_cost_decimal","ALTER TABLE usage_events ADD COLUMN reported_cost_decimal TEXT"),
    ] {
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",params![table,column],|r|r.get(0))?;
        if !exists { tx.execute(ddl,[])?; }
    }
    tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_usage_exec_snapshot ON usage_events(exec_snapshot_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_provider_update ON usage_events(runtime_id,provider_update_id) WHERE provider_update_id IS NOT NULL;")?;
    let gates=[("exec_gate.claude.model",true),("exec_gate.claude.thinking",true),("exec_gate.claude.instructions",true),("exec_gate.codex.model",true),("exec_gate.codex.thinking",true),("exec_gate.codex.serviceTier",true),("exec_gate.codex.instructions",true),("exec_gate.codex.steer",false),("exec_gate.opencode.model",true),("exec_gate.opencode.thinking",true),("exec_gate.opencode.instructions",true)];
    for (key,enabled) in gates {
        let changed=tx.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?1,?2)",params![key,if enabled{"true"}else{"false"}])?;
        if changed>0 { push_settings_event(&tx,key,enabled)?; }
    }
    let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(3,?1)",[now])?;
    tx.pragma_update(None,"user_version",3)?;
    if !schema_v3_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v3_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

fn schema_v4_valid(c:&Connection)->Result<bool,StorageError>{
    let ledger:i64=c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
    let pragma:i64=c.query_row("PRAGMA user_version",[],|r|r.get(0))?;
    let agent:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='approval_mode')",[],|r|r.get(0))?;
    let resolved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('permission_requests') WHERE name='resolved_by')",[],|r|r.get(0))?;
    let setting:Option<String>=c.query_row("SELECT value FROM settings WHERE key='permissions.default_mode'",[],|r|r.get(0)).optional()?;
    Ok(ledger==4&&pragma==4&&agent&&resolved&&setting.as_deref()==Some("\"ask\""))
}
fn schema_v5_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let started: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='started_at')", [], |r| r.get(0))?;
    let failure: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='failure_class')", [], |r| r.get(0))?;
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(ledger == 5 && pragma == 5 && started && failure && integrity == "ok"
        && c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0))? == 0)
}

fn migrate_turn_analytics(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 5 {
        return if schema_v5_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) };
    }
    if ledger > 5 { return if pragma == ledger { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger != 4 || pragma != 4 { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path {
        if !backup_done { verified_backup(c, database_path, 4)?; }
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let has_started: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='started_at')", [], |r| r.get(0))?;
    if !has_started { tx.execute("ALTER TABLE turns ADD COLUMN started_at TEXT", [])?; }
    let has_failure: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='failure_class')", [], |r| r.get(0))?;
    if !has_failure {
        tx.execute("ALTER TABLE turns ADD COLUMN failure_class TEXT CHECK(failure_class IS NULL OR failure_class IN ('provider_error','permission_denied','cancelled','timeout','budget_stop','config_unsupported','other'))", [])?;
    }
    tx.execute("UPDATE turns SET started_at=created_at WHERE started_at IS NULL AND state IN ('completed','error','cancelled')", [])?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(5,?1)", [now])?;
    tx.pragma_update(None, "user_version", 5)?;
    if !schema_v5_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v5_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

fn schema_v6_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let title: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='title_override')", [], |r| r.get(0))?;
    let archived: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='archived')", [], |r| r.get(0))?;
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(ledger == 6 && pragma == 6 && title && archived && integrity == "ok"
        && c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0))? == 0)
}

fn schema_v8_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let outfit: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='outfit' AND dflt_value=quote('auto'))", [], |r| r.get(0))?;
    let values_ok: bool = c.query_row("SELECT NOT EXISTS(SELECT 1 FROM agents WHERE outfit NOT IN ('auto','none','party-hat','beanie','crown','sunglasses','round-glasses','bow','scarf','witch-hat','santa-hat','pumpkin','bunny-ears'))", [], |r| r.get(0))?;
    let columns = ["input_rate", "output_rate", "cache_read_rate", "cache_write_rate"];
    for column in columns {
        let kind: String = c.query_row("SELECT type FROM pragma_table_info('user_pricing_rules') WHERE name=?1", [column], |r| r.get(0))?;
        if !kind.eq_ignore_ascii_case("TEXT") { return Ok(false); }
    }
    let rows: Vec<String> = {
        let mut q = c.prepare("SELECT data FROM user_pricing_rules")?;
        let rows = q.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for row in rows {
        let Ok(value) = serde_json::from_str::<Value>(&row) else { return Ok(false); };
        for field in ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] {
            if !value[field].is_null() && value[field].as_str().is_none_or(|rate| !bloblex_usage::valid_rate_decimal(rate)) { return Ok(false); }
        }
    }
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok((ledger == 8 || ledger == 9) && pragma == ledger && outfit && values_ok && integrity == "ok"
        && c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0))? == 0)
}

fn migrate_exact_price_overrides(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 8 { return if schema_v8_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger != 7 || pragma != 7 { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path { if !backup_done { verified_backup(c, database_path, 7)?; } }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Flat tuple of the v7 pricing-rule columns; a named type would only rename the same fields.
    #[allow(clippy::type_complexity)]
    let old_rows: Vec<(String, String, String, String, String, String, Option<String>, Option<String>, String)> = {
        let mut q = tx.prepare("SELECT id,provider,model,aliases,currency,effective_from,effective_to,source_url,data FROM user_pricing_rules")?;
        let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))?.collect::<Result<Vec<_>, _>>()?;
        rows
    };
    tx.execute_batch("CREATE TABLE user_pricing_rules_v8(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate TEXT,output_rate TEXT,cache_read_rate TEXT,cache_write_rate TEXT,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL);")?;
    for (id, provider, model, aliases, currency, from, to, source_url, data) in old_rows {
        let mut value: Value = serde_json::from_str(&data).map_err(|_| StorageError::InvalidPricing)?;
        let mut converted: [Option<String>; 4] = [None, None, None, None];
        for (index, field) in ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"].into_iter().enumerate() {
            converted[index] = match &value[field] {
                Value::Null => None,
                Value::Number(number) => {
                    let minor = number.as_i64().ok_or(StorageError::InvalidPricing)?;
                    Some(bloblex_usage::minor_units_to_major_decimal(minor, &currency).ok_or(StorageError::InvalidPricing)?)
                }
                Value::String(rate) if bloblex_usage::valid_rate_decimal(rate) => Some(rate.clone()),
                _ => return Err(StorageError::InvalidPricing),
            };
            value[field] = converted[index].as_ref().map_or(Value::Null, |rate| Value::String(rate.clone()));
        }
        tx.execute("INSERT INTO user_pricing_rules_v8(id,provider,model,aliases,input_rate,output_rate,cache_read_rate,cache_write_rate,currency,effective_from,effective_to,source_url,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", params![id,provider,model,aliases,converted[0],converted[1],converted[2],converted[3],currency,from,to,source_url,value.to_string()])?;
    }
    tx.execute_batch("DROP TABLE user_pricing_rules; ALTER TABLE user_pricing_rules_v8 RENAME TO user_pricing_rules;")?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(8,?1)", [now])?;
    tx.pragma_update(None, "user_version", 8)?;
    if !schema_v8_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v8_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

fn schema_v9_valid(c: &Connection) -> Result<bool, StorageError> {
    let sql: Option<String> = c.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'", [], |r| r.get(0)).optional()?;
    let v8_valid = schema_v8_valid(c)?;
    let ids_in_constraint = sql.is_some_and(|ddl| ddl.contains("'pumpkin'") && ddl.contains("'bunny-ears'"));
    Ok(v8_valid && ids_in_constraint)
}

fn migrate_agent_outfit_ids(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 9 { return if schema_v9_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    let source_valid = schema_v8_valid(c)?;
    if ledger != 8 || pragma != 8 || !source_valid { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path { if !backup_done { verified_backup(c, database_path, 8)?; } }

    c.pragma_update(None, "foreign_keys", "OFF")?;
    let result = (|| -> Result<(), StorageError> {
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let indexes: Vec<String> = {
            let mut q = tx.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='agents' AND sql IS NOT NULL ORDER BY name")?;
            let rows = q.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
            rows
        };
        tx.execute_batch("CREATE TABLE agents_v9 (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
            name_key TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 255),
            instructions TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT 'mint' CHECK(color IN ('coral','orange','amber','lemon','lime','mint','teal','cyan','sky','blue','violet','pink') OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
            runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
            model TEXT,
            thinking TEXT,
            service_tier TEXT,
            custom_args TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(custom_args) AND json_type(custom_args)='array'),
            custom_env TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(custom_env) AND json_type(custom_env)='object'),
            max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 50),
            default_project TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0),
            archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            approval_mode TEXT CHECK(approval_mode IS NULL OR approval_mode IN ('ask','auto','bypass')),
            outfit TEXT NOT NULL DEFAULT 'auto' CHECK(outfit IN ('auto','none','party-hat','beanie','crown','sunglasses','round-glasses','bow','scarf','witch-hat','santa-hat','pumpkin','bunny-ears'))
        );
        INSERT INTO agents_v9 SELECT id,name,name_key,description,instructions,color,runtime_id,model,thinking,service_tier,custom_args,custom_env,max_concurrency,default_project,sort_order,archived,created_at,updated_at,approval_mode,outfit FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_v9 RENAME TO agents;")?;
        for index_sql in indexes { tx.execute_batch(&index_sql)?; }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(9,?1)", [now])?;
        tx.pragma_update(None, "user_version", 9)?;
        if !schema_v9_valid(&tx)? { return Err(StorageError::InvalidAgent); }
        tx.commit()?;
        Ok(())
    })();
    c.pragma_update(None, "foreign_keys", "ON")?;
    result?;
    if !schema_v9_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

fn schema_v10_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let table: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='quota_snapshots')", [], |r| r.get(0))?;
    let columns = ["provider", "runtime_id", "snapshot_json", "fetched_at", "last_attempt_at", "failure_count", "retry_after", "last_error"];
    if ledger != 10 || pragma != 10 || !table { return Ok(false); }
    for column in columns {
        if !c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('quota_snapshots') WHERE name=?1)", [column], |r| r.get::<_, bool>(0))? { return Ok(false); }
    }
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(integrity == "ok" && c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0))? == 0)
}

fn migrate_quota_snapshots(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 10 { return if schema_v10_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger != 9 || pragma != 9 || !schema_v9_valid(c)? { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path { if !backup_done { verified_backup(c, database_path, 9)?; } }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE TABLE quota_snapshots(
        provider TEXT PRIMARY KEY NOT NULL,
        runtime_id TEXT NOT NULL,
        snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
        fetched_at TEXT,
        last_attempt_at TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0),
        retry_after TEXT,
        last_error TEXT
    );")?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(10,?1)", [now])?;
    tx.pragma_update(None, "user_version", 10)?;
    if !schema_v10_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v10_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

fn schema_v11_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let column: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='model_lock_json')", [], |r| r.get(0))?;
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(ledger == 11 && pragma == 11 && column && integrity == "ok"
        && c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0))? == 0
        && c.query_row("SELECT count(*) FROM sessions WHERE model_lock_json IS NOT NULL AND (NOT json_valid(model_lock_json) OR json_type(model_lock_json)!='object')", [], |r| r.get::<_, i64>(0))? == 0)
}

fn migrate_session_model_lock(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 11 { return if schema_v11_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger != 10 || pragma != 10 || !schema_v10_valid(c)? { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path { if !backup_done { verified_backup(c, database_path, 10)?; } }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("ALTER TABLE sessions ADD COLUMN model_lock_json TEXT CHECK(model_lock_json IS NULL OR (json_valid(model_lock_json) AND json_type(model_lock_json)='object'));")?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(11,?1)", [now])?;
    tx.pragma_update(None, "user_version", 11)?;
    if !schema_v11_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v11_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

const USER_REACTIONS: &[&str] = &["👍", "👎", "❤️", "😂", "🎉", "😮"];

fn schema_v12_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let table: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_reactions')", [], |r| r.get(0))?;
    if ledger != 12 || pragma != 12 || !table { return Ok(false); }
    for column in ["session_id", "message_id", "emoji", "created_at"] {
        if !c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('message_reactions') WHERE name=?1)", [column], |r| r.get::<_, bool>(0))? { return Ok(false); }
    }
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(integrity == "ok"
        && c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0))? == 0
        && c.query_row("SELECT count(*) FROM message_reactions WHERE emoji NOT IN ('👍','👎','❤️','😂','🎉','😮')", [], |r| r.get::<_, i64>(0))? == 0)
}

fn migrate_message_reactions(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 12 { return if schema_v12_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger != 11 || pragma != 11 || !schema_v11_valid(c)? { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path { if !backup_done { verified_backup(c, database_path, 11)?; } }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_id_id ON messages(session_id,id);
        CREATE TABLE message_reactions(
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            message_id TEXT NOT NULL,
            emoji TEXT NOT NULL CHECK(emoji IN ('👍','👎','❤️','😂','🎉','😮')),
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id,message_id,emoji),
            FOREIGN KEY(session_id,message_id) REFERENCES messages(session_id,id) ON DELETE CASCADE
        );
        CREATE INDEX idx_message_reactions_session_message ON message_reactions(session_id,message_id);")?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(12,?1)", [now])?;
    tx.pragma_update(None, "user_version", 12)?;
    if !schema_v12_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v12_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

/// Team schema: projects own blobs; blobs gain a project, a role label, a
/// leader flag and a sidebar visibility flag. Additive and idempotent, so it
/// runs on every open after the versioned migrations.
fn ensure_team_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );")?;
    for (column, ddl) in [
        ("project_id", "ALTER TABLE agents ADD COLUMN project_id TEXT"),
        ("role", "ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT ''"),
        ("leader", "ALTER TABLE agents ADD COLUMN leader INTEGER NOT NULL DEFAULT 0"),
        ("hidden", "ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"),
        ("look", "ALTER TABLE agents ADD COLUMN look TEXT"),
        ("notification_level", "ALTER TABLE agents ADD COLUMN notification_level TEXT"),
    ] {
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name=?1)", [column], |r| r.get(0))?;
        if !exists { c.execute(ddl, [])?; }
    }
    Ok(())
}

/// Durable prompt queue schema. Additive and idempotent like the team schema,
/// so it runs on every open after the versioned migrations.
fn ensure_queue_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS queued_prompts(
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        params_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        due_at TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queued_prompts_session ON queued_prompts(session_id,status,position);
    CREATE INDEX IF NOT EXISTS idx_queued_prompts_due ON queued_prompts(status,due_at);")?;
    Ok(())
}

/// Scheduled-automation schema. Additive and idempotent like the team/queue
/// schemas, so it runs on every open after the versioned migrations. The
/// partial unique index enforces single-flight: at most one `running` run per
/// automation.
fn ensure_automation_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS automations(
        id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('cron','once')),
        cron TEXT,
        timezone TEXT NOT NULL,
        once_at TEXT,
        session_mode TEXT NOT NULL DEFAULT 'new' CHECK(session_mode IN ('new','reuse')),
        approval_mode TEXT NOT NULL DEFAULT 'auto' CHECK(approval_mode IN ('plan','auto')),
        max_runtime_secs INTEGER NOT NULL DEFAULT 1800 CHECK(max_runtime_secs BETWEEN 60 AND 14400),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        created_by TEXT NOT NULL DEFAULT 'user' CHECK(created_by IN ('user','agent')),
        reuse_session_id TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
        pause_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled,next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automations_agent ON automations(agent_id);
    CREATE TABLE IF NOT EXISTS automation_runs(
        id TEXT PRIMARY KEY NOT NULL,
        automation_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','skipped','cancelled','timeout','interrupted')),
        reason TEXT,
        scheduled_for TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_single_flight ON automation_runs(automation_id) WHERE status='running';
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id,started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_session ON automation_runs(session_id);")?;
    Ok(())
}

/// Memory schema (Phase 5A). Additive and idempotent like the team/queue
/// schemas. `memory_fts` is a standalone FTS5 table over `title`, `body` and
/// `tags`, kept in sync by explicit writes inside the same transaction as the
/// `memory_records` change (no triggers, so soft deletes can drop the row).
/// One-time: OpenCode effort is catalog-validated now, but databases seeded
/// earlier carry `exec_gate.opencode.thinking = false`, a value nobody could
/// have chosen (no screen exposes that gate). Open it once; the marker keeps any
/// later operator choice intact.
fn ensure_opencode_effort_gate_open(c: &Connection) -> Result<(), StorageError> {
    const MARKER: &str = "migration.opencodeEffortGateOpened";
    let done: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1)", [MARKER], |r| r.get(0))?;
    if done { return Ok(()); }
    c.execute("UPDATE settings SET value='true' WHERE key='exec_gate.opencode.thinking' AND value='false'", [])?;
    c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?1,'true')", [MARKER])?;
    Ok(())
}

/// One-time, idempotent backfill of `sessions.data.projectId` for rows created
/// before conversations carried a project stamp. It matches `project_path`
/// against the projects table and never overwrites a stamp that is already
/// present. The settings marker keeps it to a single run and preserves any
/// later choice.
fn ensure_session_project_backfill(c: &Connection) -> Result<(), StorageError> {
    const MARKER: &str = "migration.sessionProjectBackfill";
    let done: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key=?1)", [MARKER], |r| r.get(0))?;
    if done { return Ok(()); }
    c.execute(
        "UPDATE sessions SET data=json_set(COALESCE(NULLIF(data,''),'{}'),'$.projectId',(SELECT p.id FROM projects p WHERE p.path=sessions.project_path LIMIT 1)) WHERE json_extract(data,'$.projectId') IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.path=sessions.project_path)",
        [],
    )?;
    c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?1,'true')", [MARKER])?;
    Ok(())
}

fn ensure_memory_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_records(
            id TEXT PRIMARY KEY NOT NULL,
            scope TEXT NOT NULL CHECK(scope IN ('blob','project','shared')),
            scope_id TEXT,
            kind TEXT NOT NULL CHECK(kind IN ('fact','preference','decision','procedure','reference')),
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            importance INTEGER NOT NULL DEFAULT 50 CHECK(importance BETWEEN 0 AND 100),
            pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
            origin TEXT NOT NULL CHECK(origin IN ('user','agent')),
            reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0,1)),
            source_session_id TEXT,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_records_scope ON memory_records(scope,scope_id,deleted_at);
        CREATE INDEX IF NOT EXISTS idx_memory_records_updated ON memory_records(deleted_at,updated_at);
        CREATE TABLE IF NOT EXISTS memory_versions(
            record_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            changed_by TEXT NOT NULL,
            changed_at TEXT NOT NULL,
            PRIMARY KEY(record_id,version)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(record_id UNINDEXED, title, body, tags);",
    )?;
    Ok(())
}

const MEMORY_COLUMNS: &str = "id,scope,scope_id,kind,title,body,tags,importance,pinned,origin,reviewed,source_session_id,version,created_at,updated_at,deleted_at";

/// Model catalog cache schema. Additive and idempotent like the other
/// `ensure_*` functions, so it runs on every open without a `user_version` bump.
fn ensure_model_catalog_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS model_catalog_cache(
            key TEXT PRIMARY KEY,
            runtime_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            value_json TEXT NOT NULL CHECK(json_valid(value_json))
        );",
    )?;
    Ok(())
}

/// Shared skills pool schema (FIX32). Additive and idempotent like the other
/// `ensure_*` functions, so it runs on every open without a `user_version`
/// bump. `skills` is the one pool every bot shares; `skill_agent_settings`
/// holds the per-bot opt-out (`enabled = 0`) rows.
fn ensure_skills_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS skills(
            name TEXT PRIMARY KEY NOT NULL CHECK(name GLOB '[a-z0-9]*'),
            description TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('claude','codex','opencode','folder','backup')),
            source_path TEXT,
            content_sha256 TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
            file_count INTEGER NOT NULL,
            total_bytes INTEGER NOT NULL,
            imported_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS skill_agent_settings(
            skill_name TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
            PRIMARY KEY(skill_name, agent_id)
        );",
    )?;
    Ok(())
}

const SKILL_COLUMNS: &str = "name,description,source,source_path,content_sha256,enabled,file_count,total_bytes,imported_at,updated_at";

/// Remote mode (FIX29 WP6b) schema: paired devices and the host-side activity
/// log. Additive and idempotent like the other `ensure_*` functions, so it runs
/// on every open without a `user_version` bump. Only `sha256(token)` is ever
/// stored: the token itself lives in the device's cookie.
fn ensure_remote_schema(c: &Connection) -> Result<(), StorageError> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS remote_devices(
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            platform TEXT NOT NULL,
            tier TEXT NOT NULL CHECK(tier IN ('viewer','chat','operator')),
            login TEXT,
            token_sha256 TEXT UNIQUE,
            paired_at TEXT NOT NULL,
            last_seen_at TEXT,
            revoked_at TEXT,
            signed_out_at TEXT
        );
        CREATE TABLE IF NOT EXISTS remote_activity(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            device_id TEXT,
            kind TEXT NOT NULL,
            summary TEXT NOT NULL
        );",
    )?;
    Ok(())
}

/// The newest `REMOTE_ACTIVITY_LIMIT` activity rows are kept; older rows are
/// dropped on every insert so the table cannot grow without bound.
pub const REMOTE_ACTIVITY_LIMIT: usize = 500;

const REMOTE_DEVICE_COLUMNS: &str =
    "id,name,kind,platform,tier,login,paired_at,last_seen_at,revoked_at,signed_out_at";

fn remote_device_dto_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "kind": row.get::<_, String>(2)?,
        "platform": row.get::<_, String>(3)?,
        "tier": row.get::<_, String>(4)?,
        "login": row.get::<_, Option<String>>(5)?,
        "pairedAt": row.get::<_, String>(6)?,
        "lastSeenAt": row.get::<_, Option<String>>(7)?,
        "revokedAt": row.get::<_, Option<String>>(8)?,
        "signedOutAt": row.get::<_, Option<String>>(9)?,
        // Derived by the gateway from its live event sockets; never stored.
        "online": false,
    }))
}

fn remote_activity_dto_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?.to_string(),
        "at": row.get::<_, String>(1)?,
        "deviceId": row.get::<_, Option<String>>(2)?,
        "deviceName": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        "kind": row.get::<_, String>(4)?,
        "summary": row.get::<_, String>(5)?,
    }))
}

fn valid_skill_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    name.len() <= 64 && chars.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

fn skill_dto_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "name": row.get::<_, String>(0)?,
        "description": row.get::<_, String>(1)?,
        "source": row.get::<_, String>(2)?,
        "sourcePath": row.get::<_, Option<String>>(3)?,
        "contentSha256": row.get::<_, String>(4)?,
        "enabled": row.get::<_, bool>(5)?,
        "fileCount": row.get::<_, i64>(6)?,
        "totalBytes": row.get::<_, i64>(7)?,
        "importedAt": row.get::<_, String>(8)?,
        "updatedAt": row.get::<_, String>(9)?,
        "disabledFor": [],
    }))
}

/// The skills whose per-bot opt-out row is set (enabled = 0), as
/// `(skill_name, agent_id)` pairs.
fn skill_disabled_pairs(c: &Connection) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = c.prepare("SELECT skill_name,agent_id FROM skill_agent_settings WHERE enabled=0")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn skill_rows(c: &Connection) -> Result<Vec<Value>, StorageError> {
    let mut statement = c.prepare(&format!("SELECT {SKILL_COLUMNS} FROM skills ORDER BY name"))?;
    let mut rows = statement.query_map([], skill_dto_from_row)?.collect::<Result<Vec<_>, _>>()?;
    let disabled = skill_disabled_pairs(c)?;
    for row in rows.iter_mut() {
        let name = row["name"].as_str().unwrap_or("").to_owned();
        let list = disabled.iter().filter(|(skill, _)| *skill == name).map(|(_, agent)| json!(agent)).collect::<Vec<_>>();
        row["disabledFor"] = json!(list);
    }
    Ok(rows)
}

fn memory_dto_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let tags: String = row.get(6)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "scope": row.get::<_, String>(1)?,
        "scopeId": row.get::<_, Option<String>>(2)?,
        "kind": row.get::<_, String>(3)?,
        "title": row.get::<_, String>(4)?,
        "body": row.get::<_, String>(5)?,
        "tags": serde_json::from_str::<Value>(&tags).unwrap_or_else(|_| json!([])),
        "importance": row.get::<_, i64>(7)?,
        "pinned": row.get::<_, bool>(8)?,
        "origin": row.get::<_, String>(9)?,
        "reviewed": row.get::<_, bool>(10)?,
        "sourceSessionId": row.get::<_, Option<String>>(11)?,
        "version": row.get::<_, i64>(12)?,
        "createdAt": row.get::<_, String>(13)?,
        "updatedAt": row.get::<_, String>(14)?,
        "deletedAt": row.get::<_, Option<String>>(15)?,
    }))
}

fn memory_read(c: &Connection, id: &str) -> Result<Option<Value>, StorageError> {
    c.query_row(&format!("SELECT {MEMORY_COLUMNS} FROM memory_records WHERE id=?1"), [id], memory_dto_from_row).optional().map_err(StorageError::from)
}

fn memory_all(c: &Connection) -> Result<Vec<Value>, StorageError> {
    let mut query = c.prepare(&format!("SELECT {MEMORY_COLUMNS} FROM memory_records"))?;
    let rows = query.query_map([], memory_dto_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn memory_valid_scope(scope: &str) -> bool { matches!(scope, "blob" | "project" | "shared") }
fn memory_valid_kind(kind: &str) -> bool { matches!(kind, "fact" | "preference" | "decision" | "procedure" | "reference") }

fn memory_validate_title(title: &str) -> Result<String, StorageError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 { return Err(StorageError::InvalidAgent); }
    Ok(title.to_owned())
}
fn memory_validate_body(body: &str) -> Result<String, StorageError> {
    let body = body.trim();
    if body.is_empty() || body.chars().count() > 2000 { return Err(StorageError::InvalidAgent); }
    Ok(body.to_owned())
}
fn memory_validate_tags(tags: &Value) -> Result<String, StorageError> {
    let items = tags.as_array().ok_or(StorageError::InvalidAgent)?;
    if items.len() > 8 { return Err(StorageError::InvalidAgent); }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let tag = item.as_str().map(str::trim).ok_or(StorageError::InvalidAgent)?;
        if tag.is_empty() || tag.chars().count() > 32 { return Err(StorageError::InvalidAgent); }
        out.push(tag.to_owned());
    }
    Ok(serde_json::to_string(&out)?)
}
fn memory_validate_importance(value: Option<&Value>) -> Result<i64, StorageError> {
    match value {
        None | Some(Value::Null) => Ok(50),
        Some(value) => value.as_i64().filter(|number| (0..=100).contains(number)).ok_or(StorageError::InvalidAgent),
    }
}
fn memory_resolve_scope_id(c: &Connection, scope: &str, scope_id: Option<&str>) -> Result<Option<String>, StorageError> {
    match scope {
        "shared" => Ok(None),
        "blob" => {
            let id = scope_id.map(str::trim).filter(|value| !value.is_empty()).ok_or(StorageError::InvalidAgent)?;
            if !c.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [id], |r| r.get::<_, bool>(0))? { return Err(StorageError::InvalidAgent); }
            Ok(Some(id.to_owned()))
        }
        "project" => {
            let id = scope_id.map(str::trim).filter(|value| !value.is_empty()).ok_or(StorageError::InvalidAgent)?;
            if !c.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [id], |r| r.get::<_, bool>(0))? { return Err(StorageError::InvalidAgent); }
            Ok(Some(id.to_owned()))
        }
        _ => Err(StorageError::InvalidAgent),
    }
}

/// Turn a user query into a safe FTS5 MATCH expression: each term becomes a
/// quoted prefix, so punctuation cannot change the query grammar.
fn memory_fts_expression(query: &str) -> String {
    let mut terms = Vec::new();
    for raw in query.split_whitespace() {
        let cleaned = raw.chars().filter(|ch| ch.is_alphanumeric() || *ch == '_').collect::<String>();
        if cleaned.is_empty() { continue; }
        terms.push(format!("\"{}\"*", cleaned.replace('"', "\"\"")));
    }
    terms.join(" ")
}

fn memory_search_ids(c: &Connection, query: &str) -> Result<Vec<String>, StorageError> {
    let expression = memory_fts_expression(query);
    if expression.is_empty() { return Ok(Vec::new()); }
    let mut statement = c.prepare("SELECT record_id FROM memory_fts WHERE memory_fts MATCH ?1 ORDER BY bm25(memory_fts)")?;
    let ids = statement.query_map([expression], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

fn memory_visible_to(row: &Value, agent_id: &str, project_id: Option<&str>) -> bool {
    match row["scope"].as_str() {
        Some("blob") => row["scopeId"].as_str() == Some(agent_id),
        Some("project") => project_id.is_some_and(|project| row["scopeId"].as_str() == Some(project)),
        Some("shared") => true,
        _ => false,
    }
}

fn memory_is_live_reviewed(row: &Value) -> bool { row["reviewed"] == true && row["deletedAt"].is_null() }

fn memory_catalog_order(rows: &mut [Value]) {
    rows.sort_by(|a, b| {
        b["pinned"].as_bool().unwrap_or(false).cmp(&a["pinned"].as_bool().unwrap_or(false))
            .then_with(|| b["importance"].as_i64().unwrap_or(0).cmp(&a["importance"].as_i64().unwrap_or(0)))
            .then_with(|| b["updatedAt"].as_str().unwrap_or("").cmp(a["updatedAt"].as_str().unwrap_or("")))
    });
}

/// The `schedule` object a caller and the DTO share. `once` keeps its zone so
/// the UI can show the wall clock the user picked.
fn automation_schedule(kind: &str, cron: Option<&str>, timezone: &str, once_at: Option<&str>) -> Value {
    match kind {
        "cron" => json!({"kind":"cron","cron":cron.unwrap_or(""),"timezone":timezone}),
        "once" => json!({"kind":"once","timezone":timezone,"at":once_at}),
        _ => json!({"kind":kind,"timezone":timezone}),
    }
}

fn automation_run_dto(c: &Connection, id: &str) -> Result<Value, StorageError> {
    c.query_row(
        "SELECT id,automation_id,session_id,status,reason,scheduled_for,started_at,finished_at FROM automation_runs WHERE id=?1",
        [id],
        |r| Ok(json!({
            "id":r.get::<_,String>(0)?,
            "automationId":r.get::<_,String>(1)?,
            "sessionId":r.get::<_,Option<String>>(2)?,
            "status":r.get::<_,String>(3)?,
            "reason":r.get::<_,Option<String>>(4)?,
            "scheduledFor":r.get::<_,Option<String>>(5)?,
            "startedAt":r.get::<_,String>(6)?,
            "finishedAt":r.get::<_,Option<String>>(7)?,
        })),
    )
    .optional()?
    .ok_or(StorageError::AgentNotFound)
}

fn automation_read(c: &Connection, id: &str) -> Result<Value, StorageError> {
    let row = c
        .query_row(
            "SELECT id,agent_id,name,prompt,schedule_kind,cron,timezone,once_at,session_mode,approval_mode,max_runtime_secs,enabled,created_by,reuse_session_id,next_run_at,last_run_at,consecutive_failures,pause_reason,created_at,updated_at FROM automations WHERE id=?1",
            [id],
            |r| Ok((
                r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
                r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, String>(6)?, r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?, r.get::<_, String>(9)?, r.get::<_, i64>(10)?, r.get::<_, bool>(11)?,
                r.get::<_, String>(12)?, r.get::<_, Option<String>>(13)?, r.get::<_, Option<String>>(14)?, r.get::<_, Option<String>>(15)?,
                r.get::<_, i64>(16)?, r.get::<_, Option<String>>(17)?, r.get::<_, String>(18)?, r.get::<_, String>(19)?,
            )),
        )
        .optional()?
        .ok_or(StorageError::AgentNotFound)?;
    let (id, agent_id, name, prompt, schedule_kind, cron, timezone, once_at, session_mode, approval_mode, max_runtime_secs, enabled, created_by, reuse_session_id, next_run_at, last_run_at, consecutive_failures, pause_reason, created_at, updated_at) = row;
    let running: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM automation_runs WHERE automation_id=?1 AND status='running')", [&id], |r| r.get(0))?;
    let last_run_id: Option<String> = c.query_row("SELECT id FROM automation_runs WHERE automation_id=?1 ORDER BY started_at DESC,id DESC LIMIT 1", [&id], |r| r.get(0)).optional()?;
    let mut dto = json!({
        "id":id,"agentId":agent_id,"name":name,"prompt":prompt,
        "schedule":automation_schedule(&schedule_kind,cron.as_deref(),&timezone,once_at.as_deref()),
        "sessionMode":session_mode,"approvalMode":approval_mode,"maxRuntimeSecs":max_runtime_secs,"enabled":enabled,
        "createdBy":created_by,"reuseSessionId":reuse_session_id,"nextRunAt":next_run_at,"lastRunAt":last_run_at,
        "consecutiveFailures":consecutive_failures,"pauseReason":pause_reason,"running":running,
        "createdAt":created_at,"updatedAt":updated_at,
    });
    if let Some(last) = last_run_id {
        dto["lastRun"] = automation_run_dto(c, &last)?;
    }
    Ok(dto)
}

/// Validate an `approvalMode` request field. Automations may only ever be
/// `plan` or `auto`; `bypass`, `ask` and anything else are invalid.
fn automation_approval_mode(input: &Value, default: &str) -> Result<String, StorageError> {
    match input.get("approvalMode") {
        None | Some(Value::Null) => Ok(default.to_owned()),
        Some(Value::String(mode)) if mode == "plan" || mode == "auto" => Ok(mode.clone()),
        _ => Err(StorageError::InvalidAgent),
    }
}

fn automation_session_mode(input: &Value) -> Result<String, StorageError> {
    match input.get("sessionMode") {
        None | Some(Value::Null) => Ok("new".to_owned()),
        Some(Value::String(mode)) if mode == "new" || mode == "reuse" => Ok(mode.clone()),
        _ => Err(StorageError::InvalidAgent),
    }
}

fn automation_runtime_secs(input: &Value) -> Result<i64, StorageError> {
    match input.get("maxRuntimeSecs") {
        None | Some(Value::Null) => Ok(1800),
        Some(value) => value.as_i64().filter(|secs| (60..=14_400).contains(secs)).ok_or(StorageError::InvalidAgent),
    }
}

fn migrate_session_controls(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 6 { return if schema_v6_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger > 6 { return if pragma == ledger { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger != 5 || pragma != 5 { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path { if !backup_done { verified_backup(c, database_path, 5)?; } }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (column, ddl) in [
        ("title_override", "ALTER TABLE sessions ADD COLUMN title_override TEXT"),
        ("archived", "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))"),
    ] {
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name=?1)", [column], |r| r.get(0))?;
        if !exists { tx.execute(ddl, [])?; }
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(6,?1)", [now])?;
    tx.pragma_update(None, "user_version", 6)?;
    if !schema_v6_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v6_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

fn schema_v7_valid(c: &Connection) -> Result<bool, StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let outfit: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='outfit' AND dflt_value=quote('auto'))", [], |r| r.get(0))?;
    let values_ok: bool = c.query_row("SELECT NOT EXISTS(SELECT 1 FROM agents WHERE outfit NOT IN ('auto','none','party-hat','beanie','crown','sunglasses','round-glasses','bow','scarf','witch-hat','santa-hat'))", [], |r| r.get(0))?;
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(ledger == 7 && pragma == 7 && outfit && values_ok && integrity == "ok"
        && c.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0))? == 0)
}

fn migrate_agent_outfits(c: &mut Connection, path: Option<&Path>, backup_done: bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger == 7 { return if schema_v7_valid(c)? { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if ledger != 6 || pragma != 6 { return Err(StorageError::InvalidAgent); }
    if let Some(database_path) = path { if !backup_done { verified_backup(c, database_path, 6)?; } }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='outfit')", [], |r| r.get(0))?;
    if !exists {
        tx.execute("ALTER TABLE agents ADD COLUMN outfit TEXT NOT NULL DEFAULT 'auto' CHECK(outfit IN ('auto','none','party-hat','beanie','crown','sunglasses','round-glasses','bow','scarf','witch-hat','santa-hat'))", [])?;
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(7,?1)", [now])?;
    tx.pragma_update(None, "user_version", 7)?;
    if !schema_v7_valid(&tx)? { return Err(StorageError::InvalidAgent); }
    tx.commit()?;
    if !schema_v7_valid(c)? { return Err(StorageError::InvalidAgent); }
    Ok(())
}

fn migrate_context_failure_class(c: &mut Connection) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    if ledger < 5 {
        return Err(StorageError::InvalidAgent);
    }
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='failure_class_v2')",
        [],
        |r| r.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let has_v2: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='failure_class_v2')",
        [],
        |r| r.get(0),
    )?;
    if !has_v2 {
        tx.execute("ALTER TABLE turns ADD COLUMN failure_class_v2 TEXT", [])?;
    }
    tx.commit()?;
    Ok(())
}
fn migrate_approval_modes(c:&mut Connection,path:Option<&Path>,backup_done:bool)->Result<(),StorageError>{
    let ledger:i64=c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
    let pragma:i64=c.query_row("PRAGMA user_version",[],|r|r.get(0))?;
    if ledger==4{return if schema_v4_valid(c)?{Ok(())}else{Err(StorageError::InvalidAgent)}}
    if ledger>4{return if pragma==ledger{Ok(())}else{Err(StorageError::InvalidAgent)}}
    if ledger!=3||pragma!=3{return Err(StorageError::InvalidAgent)}
    if let Some(p)=path{if !backup_done{verified_backup(c,p,3)?}}
    let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let has_agent:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='approval_mode')",[],|r|r.get(0))?;
    if !has_agent{tx.execute("ALTER TABLE agents ADD COLUMN approval_mode TEXT CHECK(approval_mode IS NULL OR approval_mode IN ('ask','auto','bypass'))",[])?;}
    let has_resolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('permission_requests') WHERE name='resolved_by')",[],|r|r.get(0))?;
    if !has_resolved{tx.execute("ALTER TABLE permission_requests ADD COLUMN resolved_by TEXT",[])?;}
    tx.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('permissions.default_mode','\"ask\"')",[])?;
    let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(4,?1)",[now])?;
    tx.pragma_update(None,"user_version",4)?;
    if !schema_v4_valid(&tx)?{return Err(StorageError::InvalidAgent)}
    tx.commit()?;
    if !schema_v4_valid(c)?{return Err(StorageError::InvalidAgent)}
    Ok(())
}

/// The value validation a setting must pass before it is written. Shared by
/// `settings.set` and the backup importer, so a restored value is held to
/// exactly the same rules as one the user typed.
fn validate_setting_value(k:&str,v:&Value)->Result<(),StorageError>{
    if k=="permissions.default_mode" && !v.as_str().is_some_and(|s|["ask","auto"].contains(&s)){return Err(StorageError::InvalidAgent)}
    if k=="notifications.enabled" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="experimental.autoRetry" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="retry.maxWaitSecs" && !v.as_u64().is_some_and(|secs| secs<=86_400){return Err(StorageError::InvalidAgent)}
    if k=="automations.paused" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="automations.maxConcurrent" && !v.as_u64().is_some_and(|count| (1..=3).contains(&count)){return Err(StorageError::InvalidAgent)}
    if k=="experimental.usageTips" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="experimental.usageTipDismissals" && !valid_usage_tip_dismissals(v){return Err(StorageError::InvalidAgent)}
    if k=="experimental.memory" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="memory.sharedAgentWrites" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="skills.enabled" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="appearance.style" && !v.as_str().is_some_and(|s| ["bitbots","blobots"].contains(&s)){return Err(StorageError::InvalidAgent)}
    if k=="appearance.accent" && !v.as_str().is_some_and(|s| s.is_empty() || (s.len()==7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit()))){return Err(StorageError::InvalidAgent)}
    if k=="appearance.density" && !v.as_str().is_some_and(|s| ["compact","default","roomy"].contains(&s)){return Err(StorageError::InvalidAgent)}
    if k=="hints.seen" && !valid_hints_seen(v){return Err(StorageError::InvalidAgent)}
    if k=="onboarding.tour" && !valid_tour_state(v){return Err(StorageError::InvalidAgent)}
    if k=="companion.focusMode" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    if k=="companion.positions" && !valid_companion_positions(v){return Err(StorageError::InvalidAgent)}
    if k=="profile.about" && !v.as_str().is_some_and(|text| text.trim().chars().count()<=1500){return Err(StorageError::InvalidAgent)}
    if k=="conversations.autoTitle" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
    Ok(())
}

/// Writes one setting row inside an existing transaction and returns the
/// `settings.changed` envelopes it produced. A no-op write produces no event.
fn write_setting(tx:&Transaction<'_>,k:&str,v:&Value)->Result<Vec<Value>,StorageError>{
    validate_setting_value(k,v)?;
    let previous:Option<String>=tx.query_row("SELECT value FROM settings WHERE key=?1",[k],|r|r.get(0)).optional()?;
    tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![k,v.to_string()])?;
    let mut events=Vec::new();
    if k.starts_with("exec_gate.") {
        let enabled=v.as_bool().ok_or(StorageError::InvalidAgent)?;
        let same=previous.as_deref().and_then(|old|serde_json::from_str::<Value>(old).ok()).as_ref()==Some(v);
        if !same { events.push(push_settings_event(tx,k,enabled)?); }
    } else if k.starts_with("experimental.") || k.starts_with("companion.") || k.starts_with("speech.") || k.starts_with("automations.") || k.starts_with("memory.") || k.starts_with("appearance.") || k.starts_with("hints.") || k.starts_with("onboarding.") || k.starts_with("conversations.") {
        // Window-level preferences: the main window and the companion both follow them live.
        let same=previous.as_deref().and_then(|old|serde_json::from_str::<Value>(old).ok()).as_ref()==Some(v);
        if !same {
            let payload=json!({"key":k,"value":v});
            let id=Uuid::new_v4().to_string();
            let ts=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
            tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'settings.changed',?3)",params![id,ts,payload.to_string()])?;
            events.push(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":"settings.changed","payload":payload}));
        }
    } else if k=="permissions.default_mode" {
        let same=previous.as_deref().and_then(|old|serde_json::from_str::<Value>(old).ok()).as_ref()==Some(v);
        if !same {let payload=json!({"key":k,"mode":v});let id=Uuid::new_v4().to_string();let ts=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'settings.changed',?3)",params![id,ts,payload.to_string()])?;events.push(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":"settings.changed","payload":payload}));}
    }
    Ok(events)
}

fn push_settings_event(tx:&Transaction<'_>,key:&str,enabled:bool)->Result<Value,StorageError>{
    let payload=json!({"key":key,"enabled":enabled});let id=Uuid::new_v4().to_string();let ts=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
    tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'settings.changed',?3)",params![id,ts,payload.to_string()])?;
    Ok(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":"settings.changed","payload":payload}))
}

pub struct Storage {
    conn: Mutex<Connection>,
}

/// Shapes one durable queue row into the wire DTO. `params_json` holds only
/// the allowlisted prompt keys the daemon stored. `lateBySecs` is derived here
/// and never persisted.
#[allow(clippy::too_many_arguments)]
fn queued_prompt_dto(id:&str,session_id:&str,position:i64,params_json:&str,kind:&str,due_at:Option<&str>,status:&str,error:Option<&str>,created_at:&str,now:DateTime<Utc>)->Value{
    let params: Value = serde_json::from_str(params_json).unwrap_or(Value::Null);
    let mut item = json!({
        "id": id,
        "sessionId": session_id,
        "text": params.get("text").cloned().unwrap_or_else(|| json!("")),
        "attachments": params.get("attachments").cloned().unwrap_or_else(|| json!([])),
        "conversationRefs": params.get("conversationRefs").cloned().unwrap_or_else(|| json!([])),
        "kind": kind,
        "dueAt": due_at,
        "status": status,
        "error": error,
        "position": position,
        "createdAt": created_at,
    });
    if let Some(reply) = params.get("replyTo").filter(|value| !value.is_null()) { item["replyTo"] = reply.clone(); }
    // Internal auto-retry items carry daemon-generated meta so the send path can
    // rebuild the allowlisted prompt without re-reading the storage row.
    if let Some(meta) = params.get("meta").filter(|value| value.is_object()) { item["meta"] = meta.clone(); }
    if kind == "send_later" {
        if let Some(due) = due_at.and_then(|value| DateTime::parse_from_rfc3339(value).ok()) {
            let late = now.signed_duration_since(due.with_timezone(&Utc)).num_seconds();
            if late > 0 { item["lateBySecs"] = json!(late); }
        }
    }
    item
}

fn table_counts(c: &Connection) -> Result<std::collections::BTreeMap<String, i64>, StorageError> {
    let mut q = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
    let names = q.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    let mut counts = std::collections::BTreeMap::new();
    for name in names {
        let sql = format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\""));
        counts.insert(name, c.query_row(&sql, [], |r| r.get(0))?);
    }
    Ok(counts)
}
fn verify_backup_file(path:&Path,expected_version:i64,expected_counts:&std::collections::BTreeMap<String,i64>)->Result<(),StorageError>{
    let read=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity:String=read.query_row("PRAGMA integrity_check",[],|r|r.get(0))?;
    let version:i64=read.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
    let user:i64=read.query_row("PRAGMA user_version",[],|r|r.get(0))?;
    let marker_ok=if expected_version==1{user==0||user==1}else{user==expected_version};
    if integrity!="ok"||version!=expected_version||!marker_ok||read.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0))?!=0||table_counts(&read)?!=*expected_counts{return Err(StorageError::InvalidAgent)}
    Ok(())
}
fn title_case_provider(provider:&str)->String{provider.split(|c:char|!c.is_alphanumeric()).filter(|w|!w.is_empty()).map(|word|{let mut chars=word.chars();chars.next().map(|first|first.to_uppercase().collect::<String>()+&chars.as_str().to_lowercase()).unwrap_or_default()}).collect::<Vec<_>>().join(" ")}

fn ensure_default_agents_tx(tx:&Transaction<'_>,now:&str,emit_events:bool)->Result<Vec<Value>,StorageError>{
    let runtimes={let mut q=tx.prepare("SELECT id,provider FROM runtimes ORDER BY provider,id")?;let rows=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;rows};
    let mut events=Vec::new();
    for(runtime,provider)in runtimes{
        let existing:i64=tx.query_row("SELECT count(*) FROM agents WHERE runtime_id=?1",[&runtime],|r|r.get(0))?;
        if existing>0{continue;}
        let base=match provider.as_str(){"claude"=>"Claude".to_owned(),"codex"=>"Codex".to_owned(),"opencode"=>"OpenCode".to_owned(),_=>{let name=title_case_provider(&provider);if name.is_empty(){"Other".into()}else{name}}};
        let mut name=base.clone();let mut n=2;
        loop{let key=name.to_lowercase();let found:i64=tx.query_row("SELECT count(*) FROM agents WHERE name_key=?1 AND archived=0",[&key],|r|r.get(0))?;if found==0{break;}name=format!("{base} ({n})");n+=1;}
        let color=match provider.as_str(){"claude"=>"#F38C6F","codex"=>"#82AAFF","opencode"=>"#BF9CFF",_=>"#89D6B3"};
        let pos:i64=tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM agents WHERE runtime_id=?1 AND archived=0",[&runtime],|r|r.get(0))?;
        let id=Uuid::new_v4().to_string();
        tx.execute("INSERT INTO agents(id,name,name_key,description,color,runtime_id,sort_order,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8)",params![id,name,name.to_lowercase(),format!("Default agent for {base}."),color,runtime,pos,now])?;
        if emit_events{let agent=agent_read(tx,&id)?;events.push(push_agent_event(tx,"created",&agent)?);}
    }
    Ok(events)
}

fn verified_backup(c: &Connection, db_path: &Path, expected_pre_migration_version: i64) -> Result<(), StorageError> {
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    let dir = parent.join("backups");
    fs::create_dir_all(&dir)?;
    let instant=Utc::now();let stamp=format!("{}.{:07}Z",instant.format("%Y%m%dT%H%M%S"),instant.timestamp_subsec_nanos()/100);let timestamp=instant.to_rfc3339_opts(SecondsFormat::Nanos,true);
    let stem = format!("bloblex-pre-v{}-{stamp}", expected_pre_migration_version);
    let backup_path = dir.join(format!("{stem}.db"));
    let manifest_path = dir.join(format!("{stem}.manifest.json"));
    let source_counts = table_counts(c)?;
    let mut copy = Connection::open(&backup_path)?;
    Backup::new(c, &mut copy)?.run_to_completion(128, std::time::Duration::from_millis(10), None)?;
    let _:String=copy.query_row("PRAGMA journal_mode=DELETE",[],|r|r.get(0))?;
    drop(copy);
    verify_backup_file(&backup_path,expected_pre_migration_version,&source_counts)?;
    let manifest = json!({"sourcePath":db_path,"backupPath":backup_path,"timestamp":timestamp,"schemaVersion":expected_pre_migration_version,"integrity":"ok","tableRowCounts":source_counts});
    fs::write(manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

fn migrate_agents(c: &mut Connection, path: Option<&Path>, backup_done:bool) -> Result<(), StorageError> {
    let ledger: i64 = c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let pragma: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ledger > 7 || (pragma != 0 && pragma != ledger) { return Err(StorageError::InvalidAgent); }
    if ledger >= 2 { return if pragma == ledger { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if let Some(p) = path { if !backup_done {verified_backup(c, p, 1)?;} }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let locked_ledger: i64 = tx.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
    let locked_pragma: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if locked_ledger >= 2 { tx.commit()?; return if locked_ledger == locked_pragma { Ok(()) } else { Err(StorageError::InvalidAgent) }; }
    if locked_ledger != 1 || (locked_pragma != 0 && locked_pragma != locked_ledger) { return Err(StorageError::InvalidAgent); }
    tx.execute_batch("CREATE TABLE agents (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60), name_key TEXT NOT NULL, description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 255), instructions TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'mint' CHECK(color IN ('coral','orange','amber','lemon','lime','mint','teal','cyan','sky','blue','violet','pink') OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'), runtime_id TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT, model TEXT, thinking TEXT, service_tier TEXT, custom_args TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(custom_args) AND json_type(custom_args)='array'), custom_env TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(custom_env) AND json_type(custom_env)='object'), max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 50), default_project TEXT, sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order>=0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_agents_active_name ON agents(name_key) WHERE archived=0;
      CREATE UNIQUE INDEX idx_agents_active_runtime_order ON agents(runtime_id,sort_order) WHERE archived=0;
      CREATE INDEX idx_agents_runtime_archived_order ON agents(runtime_id,archived,sort_order,created_at,id);
      ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
      ALTER TABLE usage_events ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
      CREATE INDEX idx_sessions_agent_updated ON sessions(agent_id,updated_at);
      CREATE INDEX idx_usage_agent_time ON usage_events(agent_id,timestamp);")?;
    let before_sessions: i64 = tx.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?;
    let before_usage: i64 = tx.query_row("SELECT count(*) FROM usage_events", [], |r| r.get(0))?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
    ensure_default_agents_tx(&tx,&now,false)?;
    tx.execute("UPDATE sessions SET agent_id=(SELECT id FROM agents WHERE agents.runtime_id=sessions.runtime_id AND archived=0 ORDER BY created_at,id LIMIT 1) WHERE agent_id IS NULL AND EXISTS(SELECT 1 FROM agents WHERE agents.runtime_id=sessions.runtime_id AND archived=0)",[])?;
    tx.execute("UPDATE usage_events SET agent_id=(SELECT agent_id FROM sessions WHERE sessions.id=usage_events.session_id) WHERE agent_id IS NULL",[])?;
    if tx.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0))?!=0
        || tx.query_row("SELECT count(*) FROM sessions WHERE agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents)",[],|r|r.get::<_,i64>(0))?!=0
        || tx.query_row("SELECT count(*) FROM usage_events WHERE agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents)",[],|r|r.get::<_,i64>(0))?!=0
        || tx.query_row("SELECT count(*) FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.agent_id IS NULL",[],|r|r.get::<_,i64>(0))?!=0
        || tx.query_row("SELECT count(*) FROM usage_events u JOIN sessions s ON s.id=u.session_id WHERE u.agent_id IS NOT s.agent_id",[],|r|r.get::<_,i64>(0))?!=0
        || tx.query_row("SELECT count(*) FROM sessions",[],|r|r.get::<_,i64>(0))?!=before_sessions
        || tx.query_row("SELECT count(*) FROM usage_events",[],|r|r.get::<_,i64>(0))?!=before_usage { return Err(StorageError::InvalidAgent); }
    tx.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(2,?1)",[now])?;
    tx.pragma_update(None,"user_version",2)?;
    tx.commit()?;
    if let Some(path)=path { let ro=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY)?; let v:i64=ro.query_row("PRAGMA user_version",[],|r|r.get(0))?; let i:String=ro.query_row("PRAGMA integrity_check",[],|r|r.get(0))?; if v!=2||i!="ok"||ro.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0))?!=0||ro.query_row("SELECT count(*) FROM sessions s JOIN runtimes r ON r.id=s.runtime_id WHERE s.agent_id IS NULL",[],|r|r.get::<_,i64>(0))?!=0||ro.query_row("SELECT count(*) FROM usage_events u JOIN sessions s ON s.id=u.session_id WHERE u.agent_id IS NOT s.agent_id",[],|r|r.get::<_,i64>(0))?!=0{return Err(StorageError::InvalidAgent);} }
    Ok(())
}

/// Restores a verified pre-migration backup to an isolated or stopped database path.
/// Callers must close every SQLite connection first; this helper never touches WAL/SHM sidecars.
pub fn restore_verified_backup(backup_path:&Path,destination:&Path,expected_version:i64)->Result<PathBuf,StorageError>{
    let backup=Connection::open_with_flags(backup_path,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity:String=backup.query_row("PRAGMA integrity_check",[],|r|r.get(0))?;
    let version:i64=backup.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
    let pragma:i64=backup.query_row("PRAGMA user_version",[],|r|r.get(0))?;
    let marker_ok=if expected_version==1{pragma==0||pragma==1}else{pragma==expected_version};
    if integrity!="ok"||version!=expected_version||!marker_ok||backup.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0))?!=0{return Err(StorageError::InvalidAgent)}
    let expected=table_counts(&backup)?;drop(backup);
    let parent=destination.parent().unwrap_or_else(||Path::new("."));fs::create_dir_all(parent)?;
    let temp=parent.join(format!("bloblex-restore-{}.tmp",Uuid::new_v4()));fs::copy(backup_path,&temp)?;
    let check=Connection::open_with_flags(&temp,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if table_counts(&check)?!=expected||check.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0))?!="ok"{let _=fs::remove_file(&temp);return Err(StorageError::InvalidAgent)}drop(check);
    let instant=Utc::now();let stamp=format!("{}.{:07}Z",instant.format("%Y%m%dT%H%M%S"),instant.timestamp_subsec_nanos()/100);let failed=parent.join(format!("failed-migration-{stamp}.db"));
    if destination.exists(){fs::rename(destination,&failed)?;}
    fs::rename(&temp,destination)?;
    let restored=Connection::open_with_flags(destination,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if restored.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0))?!="ok"||restored.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get::<_,i64>(0))?!=expected_version||table_counts(&restored)?!=expected{return Err(StorageError::InvalidAgent)}
    Ok(failed)
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref();
        let conn = Connection::open(path)?;
        Self::migrate(conn, Some(path))
    }
    pub fn open_in_memory() -> Result<Self, StorageError> {
        Self::migrate(Connection::open_in_memory()?, None)
    }
    fn migrate(mut conn: Connection, path: Option<&Path>) -> Result<Self, StorageError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let has_ledger:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",[],|r|r.get(0))?;
        if has_ledger {
            let ledger:i64=conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
            let user:i64=conn.query_row("PRAGMA user_version",[],|r|r.get(0))?;
            if ledger>12||(user!=0&&user!=ledger)||(ledger>=2&&user!=ledger){return Err(StorageError::InvalidAgent)}
            if ledger==12 {
                if !schema_v12_valid(&conn)? { return Err(StorageError::InvalidAgent); }
                ensure_team_schema(&conn)?;
                ensure_queue_schema(&conn)?;
                ensure_automation_schema(&conn)?;
                ensure_memory_schema(&conn)?;
                ensure_opencode_effort_gate_open(&conn)?;
                ensure_session_project_backfill(&conn)?;
                ensure_model_catalog_schema(&conn)?;
                ensure_skills_schema(&conn)?;
                ensure_remote_schema(&conn)?;
                return Ok(Self { conn: Mutex::new(conn) });
            }
            if ledger==11 {
                if !schema_v11_valid(&conn)? { return Err(StorageError::InvalidAgent); }
                migrate_message_reactions(&mut conn, path, false)?;
                ensure_team_schema(&conn)?;
                ensure_queue_schema(&conn)?;
                ensure_automation_schema(&conn)?;
                ensure_memory_schema(&conn)?;
                ensure_opencode_effort_gate_open(&conn)?;
                ensure_session_project_backfill(&conn)?;
                ensure_model_catalog_schema(&conn)?;
                ensure_skills_schema(&conn)?;
                ensure_remote_schema(&conn)?;
                return Ok(Self { conn: Mutex::new(conn) });
            }
            if ledger==10 {
                if !schema_v10_valid(&conn)? { return Err(StorageError::InvalidAgent); }
                let backup_done = if let Some(path) = path { verified_backup(&conn, path, 10)?; true } else { false };
                migrate_session_model_lock(&mut conn, path, backup_done)?;
                ensure_team_schema(&conn)?;
                ensure_queue_schema(&conn)?;
                ensure_automation_schema(&conn)?;
                ensure_memory_schema(&conn)?;
                ensure_opencode_effort_gate_open(&conn)?;
                ensure_session_project_backfill(&conn)?;
                ensure_model_catalog_schema(&conn)?;
                ensure_skills_schema(&conn)?;
                ensure_remote_schema(&conn)?;
                migrate_message_reactions(&mut conn, path, false)?;
                return Ok(Self { conn: Mutex::new(conn) });
            }
            if ledger==9 {
                if !schema_v9_valid(&conn)? { return Err(StorageError::InvalidAgent); }
                let backup_done = if let Some(path) = path { verified_backup(&conn, path, 9)?; true } else { false };
                migrate_quota_snapshots(&mut conn, path, backup_done)?;
                let model_lock_backup = if let Some(path) = path { verified_backup(&conn, path, 10)?; true } else { false };
                migrate_session_model_lock(&mut conn, path, model_lock_backup)?;
                ensure_team_schema(&conn)?;
                ensure_queue_schema(&conn)?;
                ensure_automation_schema(&conn)?;
                ensure_memory_schema(&conn)?;
                ensure_opencode_effort_gate_open(&conn)?;
                ensure_session_project_backfill(&conn)?;
                ensure_model_catalog_schema(&conn)?;
                ensure_skills_schema(&conn)?;
                ensure_remote_schema(&conn)?;
                migrate_message_reactions(&mut conn, path, false)?;
                return Ok(Self { conn: Mutex::new(conn) });
            }
            if ledger==8 && !schema_v8_valid(&conn)? { return Err(StorageError::InvalidAgent); }
            if ledger==7 && !schema_v7_valid(&conn)? { return Err(StorageError::InvalidAgent); }
            if ledger==6 && !schema_v6_valid(&conn)? { return Err(StorageError::InvalidAgent); }
            if ledger==5 && !schema_v5_valid(&conn)? { return Err(StorageError::InvalidAgent); }
        }
        let has_ledger:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",[],|r|r.get(0))?;
        let mut backup_done=false;let mut backup_v2_done=false;let mut backup_v5_done=false;let mut backup_v6_done=false;
        if has_ledger {
            let ledger:i64=conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?;
            let user:i64=conn.query_row("PRAGMA user_version",[],|r|r.get(0))?;
            if ledger>12||(user!=0&&user!=ledger)||(ledger>=2&&user!=ledger){return Err(StorageError::InvalidAgent)}
            if ledger==1 {if let Some(p)=path{verified_backup(&conn,p,1)?;backup_done=true;}}
            if ledger==2 {if let Some(p)=path{verified_backup(&conn,p,2)?;backup_v2_done=true;}}
            if ledger==5 {if let Some(p)=path{verified_backup(&conn,p,5)?;backup_v5_done=true;}}
            if ledger==6 {if let Some(p)=path{verified_backup(&conn,p,6)?;backup_v6_done=true;}}
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS runtimes(id TEXT PRIMARY KEY, host_id TEXT NOT NULL, provider TEXT NOT NULL, protocol TEXT NOT NULL, executable TEXT NOT NULL, version TEXT, auth_state TEXT NOT NULL DEFAULT 'unknown', status TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, provider TEXT NOT NULL, provider_session_id TEXT, project_path TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, resumable INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, data TEXT NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, sequence INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', UNIQUE(session_id, sequence));
          CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS permission_requests(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider_request_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL, expires_at TEXT);
          CREATE TABLE IF NOT EXISTS file_changes(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, path TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS usage_events(id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, provider TEXT NOT NULL, model TEXT, timestamp TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, reported_cost_minor INTEGER, reported_currency TEXT, source TEXT NOT NULL, raw TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS usage_valuations(usage_event_id TEXT PRIMARY KEY REFERENCES usage_events(id) ON DELETE CASCADE,basis TEXT NOT NULL,amount_minor INTEGER,currency TEXT,pricing_rule_id TEXT,status TEXT NOT NULL,valued_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS pricing_rules(id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, currency TEXT NOT NULL, input_per_million INTEGER, output_per_million INTEGER, cache_read_per_million INTEGER, cache_write_per_million INTEGER, effective_from TEXT NOT NULL, effective_to TEXT, source_url TEXT, aliases TEXT NOT NULL DEFAULT '[]');
          CREATE TABLE IF NOT EXISTS subscription_plans(id TEXT PRIMARY KEY, provider TEXT NOT NULL, currency TEXT NOT NULL, monthly_minor INTEGER, renewal_day INTEGER, quota_state TEXT NOT NULL DEFAULT 'unknown', data TEXT NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS budget_policies(id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT, period TEXT NOT NULL, metric TEXT NOT NULL, hard_limit INTEGER NOT NULL, warning_json TEXT NOT NULL DEFAULT '[50,80,95,100]', created_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, currency TEXT NOT NULL DEFAULT 'USD');
          CREATE TABLE IF NOT EXISTS budget_reservations(id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, turn_id TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, reconciled_amount INTEGER, metric TEXT NOT NULL DEFAULT 'tokens');
          CREATE TABLE IF NOT EXISTS budget_violations(id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, turn_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS runtime_profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL,protocol TEXT NOT NULL,executable TEXT NOT NULL,args TEXT NOT NULL,host_id TEXT NOT NULL,working_directory_policy TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS subscription_plans(id TEXT PRIMARY KEY,provider TEXT NOT NULL,currency TEXT NOT NULL,monthly_minor INTEGER,renewal_day INTEGER,quota_state TEXT NOT NULL DEFAULT 'unknown',data TEXT NOT NULL DEFAULT '{}');
          CREATE TABLE IF NOT EXISTS user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate TEXT,output_rate TEXT,cache_read_rate TEXT,cache_write_rate TEXT,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS app_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, timestamp TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS idx_sessions_runtime_updated ON sessions(runtime_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence);
          CREATE INDEX IF NOT EXISTS idx_usage_runtime_time ON usage_events(runtime_id, timestamp);
          CREATE INDEX IF NOT EXISTS idx_usage_session_time ON usage_events(session_id, timestamp);
          CREATE INDEX IF NOT EXISTS idx_permissions_session_status ON permission_requests(session_id, status);
          CREATE INDEX IF NOT EXISTS idx_reservations_policy_status ON budget_reservations(policy_id, status);
          INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));")?;
        let has_currency: bool = conn.query_row(
            "SELECT COUNT(*)>0 FROM pragma_table_info('budget_policies') WHERE name='currency'",
            [],
            |r| r.get(0),
        )?;
        if !has_currency {
            conn.execute(
                "ALTER TABLE budget_policies ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'",
                [],
            )?;
        }
        let has_reservation_metric: bool = conn.query_row(
            "SELECT COUNT(*)>0 FROM pragma_table_info('budget_reservations') WHERE name='metric'",
            [],
            |r| r.get(0),
        )?;
        if !has_reservation_metric {
            conn.execute(
                "ALTER TABLE budget_reservations ADD COLUMN metric TEXT NOT NULL DEFAULT 'tokens'",
                [],
            )?;
        }
        migrate_agents(&mut conn, path,backup_done)?;
        migrate_exec_snapshots(&mut conn, path,backup_v2_done)?;
        let mut backup_v3_done=false;
        if let Some(database_path) = path { let ledger:i64=conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?; if ledger==3 { verified_backup(&conn,database_path,3)?; backup_v3_done=true; } }
        migrate_approval_modes(&mut conn,path,backup_v3_done)?;
        let mut backup_v4_done = false;
        if let Some(database_path) = path {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 4 { verified_backup(&conn, database_path, 4)?; backup_v4_done = true; }
        }
        migrate_turn_analytics(&mut conn, path, backup_v4_done)?;
        migrate_context_failure_class(&mut conn)?;
        migrate_session_controls(&mut conn, path, backup_v5_done)?;
        migrate_agent_outfits(&mut conn, path, backup_v6_done)?;
        let backup_v7_done = if let Some(database_path) = path {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 7 { verified_backup(&conn, database_path, 7)?; true } else { false }
        } else { false };
        migrate_exact_price_overrides(&mut conn, path, backup_v7_done)?;
        let backup_v8_done = if let Some(database_path) = path {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 8 { verified_backup(&conn, database_path, 8)?; true } else { false }
        } else { false };
        migrate_agent_outfit_ids(&mut conn, path, backup_v8_done)?;
        let backup_v9_done = if let Some(database_path) = path {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 9 { verified_backup(&conn, database_path, 9)?; true } else { false }
        } else { false };
        migrate_quota_snapshots(&mut conn, path, backup_v9_done)?;
        let backup_v10_done = if let Some(database_path) = path {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 10 { verified_backup(&conn, database_path, 10)?; true } else { false }
        } else { false };
        migrate_session_model_lock(&mut conn, path, backup_v10_done)?;
        ensure_team_schema(&conn)?;
        ensure_queue_schema(&conn)?;
                ensure_automation_schema(&conn)?;
                ensure_memory_schema(&conn)?;
                ensure_opencode_effort_gate_open(&conn)?;
                ensure_session_project_backfill(&conn)?;
                ensure_model_catalog_schema(&conn)?;
                ensure_skills_schema(&conn)?;
                ensure_remote_schema(&conn)?;
        migrate_message_reactions(&mut conn, path, false)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
    pub fn push_event(
        &self,
        event_type: &str,
        payload: &Value,
    ) -> Result<(u64, String, String), StorageError> {
        let conn = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let id = Uuid::new_v4().to_string();
        let ts = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        conn.execute(
            "INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,?3,?4)",
            params![id, ts, event_type, serde_json::to_string(payload)?],
        )?;
        Ok((conn.last_insert_rowid() as u64, id, ts))
    }
    pub fn quota_snapshots(&self) -> Result<Vec<Value>, StorageError> {
        let conn = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut query = conn.prepare("SELECT provider,runtime_id,snapshot_json,fetched_at,last_attempt_at,failure_count,retry_after,last_error FROM quota_snapshots ORDER BY provider")?;
        let rows = query.query_map([], |row| {
            let snapshot: Option<String> = row.get(2)?;
            let snapshot = snapshot.map(|value| serde_json::from_str::<Value>(&value)).transpose().map_err(|error| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error)))?;
            Ok(json!({
                "provider": row.get::<_, String>(0)?,
                "runtimeId": row.get::<_, String>(1)?,
                "snapshot": snapshot,
                "fetchedAt": row.get::<_, Option<String>>(3)?,
                "lastAttemptAt": row.get::<_, String>(4)?,
                "failureCount": row.get::<_, u32>(5)?,
                "retryAfter": row.get::<_, Option<String>>(6)?,
                "lastError": row.get::<_, Option<String>>(7)?,
            }))
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn save_quota_snapshot(&self, provider: &str, runtime_id: &str, snapshot: &Value, fetched_at: &str) -> Result<(), StorageError> {
        if snapshot.is_null() || !snapshot.is_object() { return Err(StorageError::InvalidAnalytics); }
        let conn = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        conn.execute(
            "INSERT INTO quota_snapshots(provider,runtime_id,snapshot_json,fetched_at,last_attempt_at,failure_count,retry_after,last_error) VALUES(?1,?2,?3,?4,?4,0,NULL,NULL) ON CONFLICT(provider) DO UPDATE SET runtime_id=excluded.runtime_id,snapshot_json=excluded.snapshot_json,fetched_at=excluded.fetched_at,last_attempt_at=excluded.last_attempt_at,failure_count=0,retry_after=NULL,last_error=NULL",
            params![provider, runtime_id, snapshot.to_string(), fetched_at],
        )?;
        Ok(())
    }
    pub fn record_quota_failure(&self, provider: &str, runtime_id: &str, attempted_at: &str, failure_count: u32, retry_after: &str, error_code: &str) -> Result<(), StorageError> {
        if !["timeout", "unavailable", "protocol", "other", "no_credentials", "unauthorized", "no_subscription"].contains(&error_code) { return Err(StorageError::InvalidAnalytics); }
        let conn = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        conn.execute(
            "INSERT INTO quota_snapshots(provider,runtime_id,snapshot_json,fetched_at,last_attempt_at,failure_count,retry_after,last_error) VALUES(?1,?2,NULL,NULL,?3,?4,?5,?6) ON CONFLICT(provider) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,failure_count=excluded.failure_count,retry_after=excluded.retry_after,last_error=excluded.last_error",
            params![provider, runtime_id, attempted_at, failure_count, retry_after, error_code],
        )?;
        Ok(())
    }
    pub fn agent_list(&self, include_archived: bool, runtime_id: Option<&str>) -> Result<Vec<Value>, StorageError> {
        let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;
        {
            let mut q=c.prepare("SELECT json_object('id',id,'name',name,'description',description,'instructions',instructions,'color',color,'outfit',outfit,'runtimeId',runtime_id,'model',model,'thinking',thinking,'serviceTier',service_tier,'approvalMode',approval_mode,'effectiveApprovalMode',COALESCE(approval_mode,(SELECT json_extract(value,'$') FROM settings WHERE key='permissions.default_mode'),'ask'),'customArgs',json(custom_args),'customEnv',json(custom_env),'maxConcurrency',max_concurrency,'defaultProject',default_project,'sortOrder',sort_order,'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at,'projectId',project_id,'role',role,'leader',json(CASE WHEN leader=1 THEN 'true' ELSE 'false' END),'hidden',json(CASE WHEN hidden=1 THEN 'true' ELSE 'false' END),'look',json(look),'notificationLevel',COALESCE(notification_level,'all')) FROM agents WHERE (?1 OR archived=0) AND (?2 IS NULL OR runtime_id=?2) ORDER BY runtime_id,sort_order,created_at,id")?;
            let vals=q.query_map(params![include_archived,runtime_id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            vals.into_iter().map(|v|Ok(serde_json::from_str(&v)?)).collect()
        }
    }
    // ── Team: projects, blob placement and side conversations ─────────────
    pub fn project_list(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        project_rows(&c)
    }
    pub fn project_get(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        project_rows(&c)?.into_iter().find(|project| project["id"] == id).ok_or(StorageError::AgentNotFound)
    }
    pub fn project_create(&self, name: &str, path: Option<&str>) -> Result<(Value, Vec<Value>), StorageError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 { return Err(StorageError::InvalidAgent); }
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM projects", [], |r| r.get(0))?;
        tx.execute("INSERT INTO projects(id,name,path,sort_order,collapsed,created_at,updated_at) VALUES(?1,?2,?3,?4,0,?5,?5)", params![id, name, path.map(str::trim).filter(|p| !p.is_empty()), order, now])?;
        let project = project_rows(&tx)?.into_iter().find(|project| project["id"] == id.as_str()).ok_or(StorageError::AgentNotFound)?;
        let event = push_team_event(&tx, "project.changed", &json!({"action":"created","project":project}))?;
        tx.commit()?;
        Ok((project, vec![event]))
    }
    pub fn project_update(&self, id: &str, input: &Value) -> Result<(Value, Vec<Value>), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [id], |r| r.get(0))?;
        if !exists { return Err(StorageError::AgentNotFound); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        if let Some(name) = input.get("name") {
            let name = name.as_str().map(str::trim).filter(|n| !n.is_empty() && n.chars().count() <= 80).ok_or(StorageError::InvalidAgent)?;
            tx.execute("UPDATE projects SET name=?2,updated_at=?3 WHERE id=?1", params![id, name, now])?;
        }
        if let Some(path) = input.get("path") {
            let path = match path { Value::Null => None, Value::String(p) if !p.trim().is_empty() => Some(p.trim().to_owned()), _ => return Err(StorageError::InvalidAgent) };
            tx.execute("UPDATE projects SET path=?2,updated_at=?3 WHERE id=?1", params![id, path, now])?;
        }
        if let Some(collapsed) = input.get("collapsed") {
            tx.execute("UPDATE projects SET collapsed=?2 WHERE id=?1", params![id, collapsed.as_bool().ok_or(StorageError::InvalidAgent)?])?;
        }
        if let Some(order) = input.get("sortOrder") {
            tx.execute("UPDATE projects SET sort_order=?2 WHERE id=?1", params![id, order.as_i64().ok_or(StorageError::InvalidAgent)?])?;
        }
        let project = project_rows(&tx)?.into_iter().find(|project| project["id"] == id).ok_or(StorageError::AgentNotFound)?;
        let event = push_team_event(&tx, "project.changed", &json!({"action":"updated","project":project}))?;
        tx.commit()?;
        Ok((project, vec![event]))
    }
    /// Deleting a project keeps its blobs; they become casual (no project).
    pub fn project_delete(&self, id: &str) -> Result<Vec<Value>, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute("DELETE FROM projects WHERE id=?1", [id])? == 0 { return Err(StorageError::AgentNotFound); }
        tx.execute("UPDATE agents SET project_id=NULL WHERE project_id=?1", [id])?;
        let event = push_team_event(&tx, "project.changed", &json!({"action":"deleted","projectId":id}))?;
        tx.commit()?;
        Ok(vec![event])
    }
    /// Placement and identity of a blob in the team: project, role label,
    /// leader flag (one leader at a time), sidebar visibility and order.
    pub fn agent_set_team(&self, id: &str, input: &Value) -> Result<(Value, Vec<Value>), StorageError> {
        validate_agent_id(id)?;
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old = agent_read(&tx, id)?;
        if old["archived"] == true { return Err(StorageError::AgentConflict); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        if let Some(project) = input.get("projectId") {
            let project = match project { Value::Null => None, Value::String(p) => Some(p.clone()), _ => return Err(StorageError::InvalidAgent) };
            if let Some(project) = project.as_deref() {
                let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [project], |r| r.get(0))?;
                if !exists { return Err(StorageError::AgentNotFound); }
            }
            tx.execute("UPDATE agents SET project_id=?2,updated_at=?3 WHERE id=?1", params![id, project, now])?;
        }
        if let Some(role) = input.get("role") {
            let role = role.as_str().map(str::trim).filter(|r| r.chars().count() <= 40).ok_or(StorageError::InvalidAgent)?;
            tx.execute("UPDATE agents SET role=?2,updated_at=?3 WHERE id=?1", params![id, role, now])?;
        }
        if let Some(hidden) = input.get("hidden") {
            tx.execute("UPDATE agents SET hidden=?2,updated_at=?3 WHERE id=?1", params![id, hidden.as_bool().ok_or(StorageError::InvalidAgent)?, now])?;
        }
        if let Some(order) = input.get("sortOrder") {
            tx.execute("UPDATE agents SET sort_order=?2,updated_at=?3 WHERE id=?1", params![id, order.as_i64().ok_or(StorageError::InvalidAgent)?, now])?;
        }
        if let Some(leader) = input.get("leader") {
            let leader = leader.as_bool().ok_or(StorageError::InvalidAgent)?;
            if leader { tx.execute("UPDATE agents SET leader=0 WHERE leader=1 AND id!=?1", [id])?; }
            tx.execute("UPDATE agents SET leader=?2,updated_at=?3 WHERE id=?1", params![id, leader, now])?;
        }
        let agent = agent_read(&tx, id)?;
        let event = push_agent_event(&tx, "updated", &agent)?;
        tx.commit()?;
        Ok((agent, vec![event]))
    }
    pub fn leader_agent(&self) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let id: Option<String> = c.query_row("SELECT id FROM agents WHERE leader=1 AND archived=0 LIMIT 1", [], |r| r.get(0)).optional()?;
        id.map(|id| agent_read(&c, &id)).transpose()
    }
    /// Marks a session as a side conversation between two blobs.
    pub fn set_session_link(&self, id: &str, link: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE sessions SET data=json_set(COALESCE(NULLIF(data,''),'{}'),'$.link',json(?2)) WHERE id=?1", params![id, link.to_string()])?;
        if changed == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }
    /// The open side conversation in which `peer` talks to `agent`, if any.
    pub fn side_session(&self, agent_id: &str, peer_agent_id: &str) -> Result<Option<String>, StorageError> {
        self.side_session_for(agent_id, peer_agent_id, "")
    }
    /// The open side conversation `peer` started with `agent`, preferring the
    /// one spawned from `origin_session` so a reply lands in its own thread,
    /// then the newest. An empty `origin_session` merely keeps the newest.
    pub fn side_session_for(&self, agent_id: &str, peer_agent_id: &str, origin_session: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT id FROM sessions WHERE agent_id=?1 AND archived=0 AND json_extract(data,'$.link.kind')='side' AND json_extract(data,'$.link.peerAgentId')=?2 ORDER BY (CASE WHEN json_extract(data,'$.link.spawnedFromSessionId')=?3 THEN 0 ELSE 1 END),updated_at DESC LIMIT 1", params![agent_id, peer_agent_id, origin_session], |r| r.get(0)).optional()?)
    }
    /// Open side conversations a blob takes part in, either as the one asked
    /// (`agentId`) or the one asking (`peerAgentId`), newest first.
    pub fn side_conversations(&self, agent_id: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT s.id, s.agent_id, json_extract(s.data,'$.link.peerAgentId'), s.title, json_extract(s.data,'$.link.topic'), s.updated_at, (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant')) FROM sessions s WHERE s.archived=0 AND json_extract(s.data,'$.link.kind')='side' AND (s.agent_id=?1 OR json_extract(s.data,'$.link.peerAgentId')=?1) ORDER BY s.updated_at DESC LIMIT 40")?;
        let rows = q.query_map([agent_id], |r| Ok(json!({
            "id": r.get::<_, String>(0)?, "agentId": r.get::<_, Option<String>>(1)?, "peerAgentId": r.get::<_, Option<String>>(2)?,
            "title": r.get::<_, String>(3)?, "topic": r.get::<_, Option<String>>(4)?, "updatedAt": r.get::<_, String>(5)?, "messages": r.get::<_, i64>(6)?,
        })))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    /// The newest assistant text in a session, for short recaps.
    pub fn last_reply(&self, session: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT content FROM messages WHERE session_id=?1 AND role='assistant' AND trim(content)<>'' ORDER BY sequence DESC LIMIT 1", [session], |r| r.get(0)).optional()?)
    }
    /// A blob's main conversation: its newest open session that is neither a
    /// side conversation, an automation run, nor a hand-off draft. Bitbots keeps
    /// exactly one main conversation per blob, so none of those may replace it.
    pub fn main_session(&self, agent_id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT id FROM sessions WHERE agent_id=?1 AND archived=0 AND (json_extract(data,'$.link') IS NULL OR json_extract(data,'$.link.kind') NOT IN ('side','automation','handoff')) ORDER BY updated_at DESC LIMIT 1", [agent_id], |r| r.get(0)).optional()?)
    }
    /// Every conversation a blob has, newest first: the main conversations in
    /// its own sessions (`agent_id`) plus the side conversations it started as
    /// the asking peer (`link.peerAgentId`). Automation and hand-off sessions
    /// are never conversations. `project_id` filters on the stored or inferred
    /// project; archived rows appear only with `include_archived`.
    pub fn agent_conversations(&self, agent_id: &str, project_id: Option<&str>, include_archived: bool) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare(
            "SELECT json_object(
                'id',s.id,
                'title',COALESCE(s.title_override,s.title),
                'state',s.state,
                'createdAt',s.created_at,
                'updatedAt',s.updated_at,
                'archived',json(CASE WHEN s.archived=1 THEN 'true' ELSE 'false' END),
                'projectId',COALESCE(json_extract(s.data,'$.projectId'),(SELECT p.id FROM projects p WHERE p.path=s.project_path LIMIT 1)),
                'kind',CASE WHEN json_extract(s.data,'$.link.kind')='side' THEN 'side' ELSE 'main' END,
                'agentId',s.agent_id,
                'peerAgentId',json_extract(s.data,'$.link.peerAgentId'),
                'topic',json_extract(s.data,'$.link.topic'),
                'spawnedFromSessionId',json_extract(s.data,'$.link.spawnedFromSessionId'),
                'originSessionId',json_extract(s.data,'$.link.originSessionId'),
                'messageCount',(SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant'))
            ) FROM sessions s
            WHERE ((s.agent_id=?1 AND (json_extract(s.data,'$.link.kind') IS NULL OR json_extract(s.data,'$.link.kind') NOT IN ('automation','handoff')))
                OR (json_extract(s.data,'$.link.kind')='side' AND json_extract(s.data,'$.link.peerAgentId')=?1))
              AND (?2 OR s.archived=0)
              AND (?3 IS NULL OR COALESCE(json_extract(s.data,'$.projectId'),(SELECT p2.id FROM projects p2 WHERE p2.path=s.project_path LIMIT 1))=?3)
            ORDER BY s.updated_at DESC",
        )?;
        let rows = q.query_map(params![agent_id, include_archived, project_id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|raw| Ok(serde_json::from_str(&raw)?)).collect()
    }
    pub fn insert_question(&self, id: &str, session: &str, provider_id: &str, title: &str, questions: &Value, expires_at: Option<&str>) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(()); }
        let data = json!({"id":id,"sessionId":session,"kind":"question","title":title,"detail":null,"choices":["answer","dismiss"],"questions":questions,"status":"pending"});
        c.execute("INSERT INTO permission_requests(id,session_id,provider_request_id,status,data,expires_at) VALUES(?1,?2,?3,'pending',?4,?5)", params![id, session, provider_id, data.to_string(), expires_at])?;
        Ok(())
    }
    /// The provider request id stored for a permission or question card.
    pub fn permission_provider_id(&self, id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT provider_request_id FROM permission_requests WHERE id=?1", [id], |r| r.get(0)).optional()?.flatten())
    }
    /// The stored normalized `data` object for a permission or question card.
    pub fn permission_get(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let raw: Option<String> = c.query_row("SELECT data FROM permission_requests WHERE id=?1", [id], |r| r.get(0)).optional()?;
        Ok(serde_json::from_str(&raw.ok_or(StorageError::AgentNotFound)?)?)
    }
    /// Marks a resolving question answered or dismissed. The row must be in the
    /// resolving state set by `begin_permission_reply`.
    pub fn resolve_question(&self, id: &str, status: &str) -> Result<(), StorageError> {
        if !["answered", "dismissed"].contains(&status) { return Err(StorageError::InvalidAgent); }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE permission_requests SET status='resolved',data=json_set(data,'$.status',?2) WHERE id=?1 AND status='resolving'", params![id, status])?;
        if changed != 1 { return Err(StorageError::AgentConflict); }
        Ok(())
    }
    /// Marks every pending card whose expiry has passed as `expired`, returning
    /// `{id,sessionId}` for each so the caller can announce the change. Expired
    /// cards are never treated as answered.
    pub fn expire_due_questions(&self, now: &str) -> Result<Vec<Value>, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows: Vec<(String, String)> = {
            let mut q = tx.prepare("SELECT id,session_id FROM permission_requests WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?1")?;
            let collected = q.query_map([now], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            collected
        };
        for (id, _) in &rows {
            tx.execute("UPDATE permission_requests SET status='expired',data=json_set(data,'$.status','expired') WHERE id=?1 AND status='pending'", [id])?;
        }
        tx.commit()?;
        Ok(rows.into_iter().map(|(id, session_id)| json!({"id":id,"sessionId":session_id})).collect())
    }
    pub fn permission_kind(&self, id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT json_extract(data,'$.kind') FROM permission_requests WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0)).optional()?.flatten())
    }
    /// The latest assistant text of a turn, used to relay a side reply.
    pub fn turn_reply(&self, session: &str, turn: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let rows: Vec<String> = {
            let mut q = c.prepare("SELECT content FROM messages WHERE session_id=?1 AND turn_id=?2 AND role='assistant' ORDER BY sequence")?;
            let collected = q.query_map(params![session, turn], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            collected
        };
        let text = rows.join("\n\n").trim().to_owned();
        Ok((!text.is_empty()).then_some(text))
    }

    pub fn agent_get(&self, id:&str)->Result<Value,StorageError>{ validate_agent_id(id)?;let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?; agent_read(&c,id) }
    pub fn agent_create(&self, input:&Value)->Result<(Value,Vec<Value>),StorageError>{
        validate_agent_fields(input,true)?;
        let mut c=self.conn.lock().map_err(|_|StorageError::Poisoned)?; let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let runtime=input["runtimeId"].as_str().unwrap(); if !runtime_exists(&tx,runtime)?{return Err(StorageError::AgentNotFound)}
        let id=Uuid::new_v4().to_string(); let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
        let name=trimmed(input,"name"); let key=name.to_lowercase(); ensure_name_free(&tx,&key,None)?;
        let pos:i64=tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM agents WHERE runtime_id=?1 AND archived=0",[runtime],|r|r.get(0))?;
        insert_agent(&tx,&id,input,&name,&key,pos,&now)?;
        let agent=agent_read(&tx,&id)?; let event=push_agent_event(&tx,"created",&agent)?; tx.commit()?; Ok((agent,vec![event]))
    }
    pub fn agent_update(&self,id:&str,input:&Value)->Result<(Value,Vec<Value>),StorageError>{
        validate_agent_id(id)?;validate_agent_fields(input,false)?; let mut c=self.conn.lock().map_err(|_|StorageError::Poisoned)?; let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut old=agent_read(&tx,id)?; if old["archived"]==true{return Err(StorageError::AgentConflict)}
        let mut next=old.clone(); for k in ["name","runtimeId","description","instructions","color","outfit","look","model","thinking","serviceTier","approvalMode","customArgs","customEnv","maxConcurrency","defaultProject","notificationLevel"]{if let Some(v)=input.get(k){next[k]=v.clone();}}
        let name=next["name"].as_str().unwrap_or("").trim().to_owned(); let key=name.to_lowercase(); ensure_name_free(&tx,&key,Some(id))?;
        let old_runtime=old["runtimeId"].as_str().unwrap_or("").to_owned(); let runtime=next["runtimeId"].as_str().unwrap_or("").to_owned(); if !runtime_exists(&tx,&runtime)?{return Err(StorageError::AgentNotFound)}
        let old_order=if runtime!=old_runtime{active_order(&tx,&old_runtime)?}else{vec![]};
        let unchanged= ["name","runtimeId","description","instructions","color","outfit","look","model","thinking","serviceTier","approvalMode","customArgs","customEnv","maxConcurrency","defaultProject","notificationLevel"].iter().all(|k|next[*k]==old[*k]);
        if unchanged { tx.commit()?; return Ok((old,vec![])); }
        let color=next["color"].as_str().unwrap_or("mint");let color=if color.starts_with('#'){color.to_ascii_uppercase()}else{color.to_owned()};
        let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
        if runtime!=old_runtime { let pos:i64=tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM agents WHERE runtime_id=?1 AND archived=0",[&runtime],|r|r.get(0))?;tx.execute("UPDATE agents SET runtime_id=?2,sort_order=?3 WHERE id=?1",params![id,runtime,pos])?;shift_active(&tx,&old_runtime)?;let old_ids=old_order.iter().filter(|a|a["id"]!=id).map(|a|a["id"].as_str().unwrap_or("").to_owned()).collect::<Vec<_>>();assign_active_order(&tx,&old_ids,&old_order,&now)?; }
        tx.execute("UPDATE agents SET name=?2,name_key=?3,description=?4,instructions=?5,color=?6,outfit=?7,model=?8,thinking=?9,service_tier=?10,approval_mode=?11,custom_args=?12,custom_env=?13,max_concurrency=?14,default_project=?15,notification_level=?16,updated_at=?17 WHERE id=?1",params![id,name,key,next["description"].as_str().unwrap_or(""),next["instructions"].as_str().unwrap_or(""),color,next["outfit"].as_str().unwrap_or("auto"),nullable(&next["model"]),nullable(&next["thinking"]),nullable(&next["serviceTier"]),nullable(&next["approvalMode"]),next["customArgs"].to_string(),next["customEnv"].to_string(),next["maxConcurrency"].as_i64().unwrap_or(1),nullable(&next["defaultProject"]),nullable(&next["notificationLevel"]),now])?;
        tx.execute("UPDATE agents SET look=?2 WHERE id=?1",params![id,look_column(&next["look"])])?;
        old=agent_read(&tx,id)?; let mut events=Vec::new();
        if runtime!=old_runtime {
            let after=active_order(&tx,&old_runtime)?;
            for previous in old_order {
                if previous["id"]==id {continue;}
                if let Some(current)=after.iter().find(|a|a["id"]==previous["id"]) {
                    if current["sortOrder"]!=previous["sortOrder"] {events.push(push_agent_event(&tx,"reordered",current)?);}
                }
            }
        }
        events.push(push_agent_event(&tx,"updated",&old)?);tx.commit()?; Ok((old,events))
    }
    pub fn agent_archive(&self,id:&str)->Result<(Value,Vec<Value>),StorageError>{
        validate_agent_id(id)?;let mut c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;let old=agent_read(&tx,id)?;
        if old["archived"]==true{tx.commit()?;return Ok((old,vec![]));} let rt=old["runtimeId"].as_str().unwrap_or("").to_owned(); let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
        let before=active_order(&tx,&rt)?;shift_active_except(&tx,&rt,id)?; tx.execute("UPDATE agents SET archived=1,updated_at=?2 WHERE id=?1",params![id,now])?;
        let remaining=active_ids(&tx,&rt)?;assign_active_order(&tx,&remaining,&before,&now)?;
        let mut events=Vec::new();let archived=agent_read(&tx,id)?;events.push(push_agent_event(&tx,"archived",&archived)?);
        for a in changed_agents(&tx,&rt)?{if before.iter().find(|previous|previous["id"]==a["id"]).is_some_and(|previous|previous["sortOrder"]!=a["sortOrder"]){events.push(push_agent_event(&tx,"reordered",&a)?);}}
        tx.commit()?;Ok((archived,events))
    }
    pub fn agent_reorder(&self,runtime:&str,ids:&[String])->Result<(Vec<Value>,Vec<Value>),StorageError>{
        let mut c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;if !runtime_exists(&tx,runtime)?{return Err(StorageError::AgentNotFound)}
        let current=active_ids(&tx,runtime)?; let mut supplied=ids.to_vec(); supplied.sort();let mut sorted=current.clone();sorted.sort(); if supplied!=sorted{return Err(StorageError::InvalidAgent)}
        let before=active_order(&tx,runtime)?;let before_ids=before.iter().map(|a|a["id"].as_str().unwrap_or("").to_owned()).collect::<Vec<_>>();if before_ids==ids{tx.commit()?;return Ok((before,vec![]));}let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);shift_active(&tx,runtime)?;
        assign_active_order(&tx,ids,&before,&now)?;
        let after=active_order(&tx,runtime)?;let mut events=Vec::new();for a in &after{let oldpos=before.iter().find(|x|x["id"]==a["id"]).and_then(|x|x["sortOrder"].as_i64());if oldpos!=a["sortOrder"].as_i64(){events.push(push_agent_event(&tx,"reordered",a)?);}}
        tx.commit()?;Ok((after,events))
    }
    pub fn replay_events(&self, after: u64, limit: usize) -> Result<Vec<Value>, StorageError> {
        let conn = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let min: Option<u64> = conn
            .query_row("SELECT MIN(sequence) FROM app_events", [], |r| r.get(0))
            .optional()?
            .flatten();
        let rows = {
            let mut s=conn.prepare("SELECT sequence,event_id,timestamp,event_type,payload FROM app_events WHERE sequence>?1 ORDER BY sequence LIMIT ?2")?;
            let iter = s.query_map(params![after, limit as u64], |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?;
            iter.collect::<Result<Vec<_>, _>>()?
        };
        if let Some(m) = min {
            if after + 1 < m && after != 0 {
                return Ok(vec![json!({"replayAvailable":false,"earliestSequence":m})]);
            }
        }
        rows.into_iter().map(|(sequence,event_id,timestamp,event_type,payload)|Ok(json!({"v":1,"eventId":event_id,"sequence":sequence,"timestamp":timestamp,"type":event_type,"payload":serde_json::from_str::<Value>(&payload)?}))).collect()
    }
    pub fn latest_sequence(&self) -> Result<u64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM app_events",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn upsert_runtime(&self, runtime: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("INSERT INTO runtimes(id,host_id,provider,protocol,executable,version,auth_state,status,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id,provider=excluded.provider,protocol=excluded.protocol,executable=excluded.executable,version=excluded.version,auth_state=excluded.auth_state,status=excluded.status,data=excluded.data",params![runtime["id"].as_str().unwrap_or(""),runtime["hostId"].as_str().unwrap_or("host_windows_local"),runtime["provider"].as_str().unwrap_or(""),runtime["protocolFamily"].as_str().unwrap_or(""),runtime["executablePath"].as_str().unwrap_or(""),runtime["version"].as_str(),runtime["authState"].as_str().unwrap_or("unknown"),runtime["status"].as_str().unwrap_or("offline"),runtime.to_string()])?;
        Ok(())
    }
    pub fn runtimes(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut s = c.prepare("SELECT data FROM runtimes ORDER BY provider")?;
        let vals = s
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        vals.into_iter()
            .map(|v| Ok(serde_json::from_str(&v)?))
            .collect()
    }
    /// Read one persisted model catalog. A hit counts as stale downstream.
    pub fn catalog_cache_get(&self, key: &str) -> Result<Option<(String, Value)>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT fetched_at,value_json FROM model_catalog_cache WHERE key=?1")?;
        let row = q.query_row([key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()?;
        row.map(|(fetched_at, value)| Ok((fetched_at, serde_json::from_str::<Value>(&value)?))).transpose()
    }
    /// Persist one model catalog under its cache key.
    pub fn catalog_cache_put(&self, key: &str, runtime_id: &str, provider: &str, fetched_at: &str, value: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "INSERT INTO model_catalog_cache(key,runtime_id,provider,fetched_at,value_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(key) DO UPDATE SET runtime_id=excluded.runtime_id,provider=excluded.provider,fetched_at=excluded.fetched_at,value_json=excluded.value_json",
            params![key, runtime_id, provider, fetched_at, value.to_string()],
        )?;
        Ok(())
    }
    /// Drop persisted catalogs for one runtime, or every runtime when `None`.
    pub fn catalog_cache_clear(&self, runtime_id: Option<&str>) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        match runtime_id {
            Some(runtime_id) => { c.execute("DELETE FROM model_catalog_cache WHERE runtime_id=?1", [runtime_id])?; }
            None => { c.execute("DELETE FROM model_catalog_cache", [])?; }
        }
        Ok(())
    }
    pub fn create_session(
        &self,
        id: &str,
        runtime_id: &str,
        provider: &str,
        project: &str,
        title: &str,
    ) -> Result<(), StorageError> {
        self.create_session_for_agent(id,runtime_id,provider,project,title,None)
    }
    pub fn create_session_for_agent(
        &self,
        id: &str,
        runtime_id: &str,
        provider: &str,
        project: &str,
        title: &str,
        agent_id: Option<&str>,
    ) -> Result<(), StorageError> {
        self.create_session_for_agent_with_model_lock(id, runtime_id, provider, project, title, agent_id, None)
    }
    // Session creation mirrors the persisted column set; a struct would only relocate the fields.
    #[allow(clippy::too_many_arguments)]
    pub fn create_session_for_agent_with_model_lock(
        &self,
        id: &str,
        runtime_id: &str,
        provider: &str,
        project: &str,
        title: &str,
        agent_id: Option<&str>,
        model_lock: Option<&Value>,
    ) -> Result<(), StorageError> {
        if model_lock.is_some_and(|lock| {
            !lock.is_object()
                || !["model", "thinking"].iter().all(|key| lock.get(*key).is_some_and(|value| value.is_null() || value.as_str().is_some()))
        }) { return Err(StorageError::InvalidAgent); }
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(agent_id)=agent_id {
            let row:Option<(String,bool)>=tx.query_row("SELECT runtime_id,archived FROM agents WHERE id=?1",[agent_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let (agent_runtime,archived)=row.ok_or(StorageError::AgentNotFound)?;
            if archived {return Err(StorageError::AgentConflict)}
            if agent_runtime!=runtime_id {return Err(StorageError::InvalidAgent)}
        }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
        tx.execute("INSERT INTO sessions(id,runtime_id,provider,project_path,title,state,created_at,updated_at,agent_id,model_lock_json) VALUES(?1,?2,?3,?4,?5,'starting',?6,?6,?7,?8)",params![id,runtime_id,provider,project,title,now,agent_id,model_lock.map(Value::to_string)])?;tx.commit()?;
        Ok(())
    }
    pub fn set_session_model_lock(&self, id: &str, model_lock: &Value) -> Result<Value, StorageError> {
        if !model_lock.is_object()
            || !["model", "thinking"].iter().all(|key| model_lock.get(*key).is_some_and(|value| value.is_null() || value.as_str().is_some()))
        { return Err(StorageError::InvalidAgent); }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute(
            "UPDATE sessions SET model_lock_json=?2,updated_at=?3 WHERE id=?1",
            params![id, model_lock.to_string(), Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)],
        )?;
        if changed == 0 { return Err(StorageError::AgentNotFound); }
        session_event_summary_locked(&c, id)
    }
    pub fn set_session_exec_snapshot(&self,session_id:&str,snapshot_id:&str,first:bool)->Result<(),StorageError>{
        let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session_id], |r| r.get(0))?;
        if !exists { return Ok(()); }
        if first { c.execute("UPDATE sessions SET first_exec_snapshot_id=COALESCE(first_exec_snapshot_id,?2) WHERE id=?1",params![session_id,snapshot_id])?; }
        else { c.execute("UPDATE sessions SET latest_exec_snapshot_id=?2 WHERE id=?1",params![session_id,snapshot_id])?; }
        Ok(())
    }
    pub fn claude_instruction_sha256(&self,session_id:&str)->Result<Option<String>,StorageError>{
        let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;Ok(c.query_row("SELECT claude_instruction_sha256 FROM sessions WHERE id=?1",[session_id],|r|r.get(0))?)
    }
    pub fn codex_thread_instruction_sha256(&self,session_id:&str)->Result<Option<String>,StorageError>{
        let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;Ok(c.query_row("SELECT codex_thread_instruction_sha256 FROM sessions WHERE id=?1",[session_id],|r|r.get(0))?)
    }
    // Snapshot creation mirrors the persisted columns; a struct would only relocate the fields.
    #[allow(clippy::too_many_arguments)]
    pub fn create_exec_snapshot(&self,session_id:&str,turn_id:&str,id:&str,requested:&Value,applied:&Value,evidence:&Value,instruction_sha256:Option<&str>,adapter_flags:&Value,status:&str)->Result<Value,StorageError>{
        let mut c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session:Option<(String,String,Option<String>)>=tx.query_row("SELECT runtime_id,provider,agent_id FROM sessions WHERE id=?1",[session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (runtime,provider,agent)=session.ok_or(StorageError::AgentNotFound)?;
        let belongs:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM turns WHERE id=?1 AND session_id=?2)",params![turn_id,session_id],|r|r.get(0))?;
        if !belongs||!matches!(status,"applied"|"partial"|"rejected"|"runtime_default"){return Err(StorageError::InvalidAgent)}
        let requested=snapshot_requested(requested);let applied=snapshot_outcomes(applied);let evidence=snapshot_evidence(evidence);let adapter_flags=snapshot_flags(adapter_flags);
        let instruction_sha256=instruction_sha256.filter(|hash|hash.len()==64&&hash.bytes().all(|b|b.is_ascii_hexdigit()));
        let created=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
        tx.execute("INSERT INTO exec_snapshots(id,session_id,turn_id,agent_id,runtime_id,provider,created_at,requested_json,applied_json,evidence_json,instruction_sha256,adapter_flags_json,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![id,session_id,turn_id,agent,runtime,provider,created,requested.to_string(),applied.to_string(),evidence.to_string(),instruction_sha256,adapter_flags.to_string(),status])?;
        tx.execute("UPDATE sessions SET first_exec_snapshot_id=COALESCE(first_exec_snapshot_id,?2),latest_exec_snapshot_id=?2 WHERE id=?1",params![session_id,id])?;
        let value=exec_snapshot_read(&tx,id)?.ok_or(StorageError::InvalidAgent)?;tx.commit()?;Ok(value)
    }
    /// Atomically records a preflight-rejected turn, user message, rejected
    /// snapshot and rejection event. This path intentionally creates no capacity reservation.
    // Rejected-turn recording mirrors the persisted columns; a struct would only relocate the fields.
    #[allow(clippy::too_many_arguments)]
    pub fn reject_exec_turn(&self,session_id:&str,turn_id:&str,snapshot_id:&str,text:&str,requested:&Value,applied:&Value,evidence:&Value,instruction_sha256:Option<&str>,adapter_flags:&Value,event_payload:&Value)->Result<(Value,Value),StorageError>{
        let mut c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (runtime,provider,agent):(String,String,Option<String>)=tx.query_row("SELECT runtime_id,provider,agent_id FROM sessions WHERE id=?1",[session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
        tx.execute("INSERT INTO turns(id,session_id,state,created_at,completed_at,failure_class) VALUES(?1,?2,'error',?3,?3,'config_unsupported')",params![turn_id,session_id,now])?;
        let sequence:i64=tx.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE session_id=?1",[session_id],|r|r.get(0))?;
        let message_id=Uuid::new_v4().to_string();tx.execute("INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at) VALUES(?1,?2,?3,?4,'user',?5,?6)",params![message_id,session_id,turn_id,sequence,text,now])?;
        let requested=snapshot_requested(requested);let applied=snapshot_outcomes(applied);let evidence=snapshot_evidence(evidence);let flags=snapshot_flags(adapter_flags);
        let hash=instruction_sha256.filter(|h|h.len()==64&&h.bytes().all(|b|b.is_ascii_hexdigit()));
        tx.execute("INSERT INTO exec_snapshots(id,session_id,turn_id,agent_id,runtime_id,provider,created_at,requested_json,applied_json,evidence_json,instruction_sha256,adapter_flags_json,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'rejected')",params![snapshot_id,session_id,turn_id,agent,runtime,provider,now,requested.to_string(),applied.to_string(),evidence.to_string(),hash,flags.to_string()])?;
        tx.execute("UPDATE sessions SET first_exec_snapshot_id=COALESCE(first_exec_snapshot_id,?2),latest_exec_snapshot_id=?2 WHERE id=?1",params![session_id,snapshot_id])?;
        let mut payload=event_payload.clone();payload["sessionId"]=json!(session_id);payload["turnId"]=json!(turn_id);payload["snapshotId"]=json!(snapshot_id);
        let event_id=Uuid::new_v4().to_string();tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'exec.options.rejected',?3)",params![event_id,now,payload.to_string()])?;
        let event=json!({"v":1,"eventId":event_id,"sequence":tx.last_insert_rowid(),"timestamp":now,"type":"exec.options.rejected","payload":payload});
        let snapshot=exec_snapshot_read(&tx,snapshot_id)?.ok_or(StorageError::InvalidAgent)?;tx.commit()?;Ok((snapshot,event))
    }
    /// Adds normalized adapter evidence to an admitted snapshot and persists
    /// the corresponding options event in the same transaction.
    pub fn update_exec_snapshot_evidence(&self,turn_id:&str,outcomes:&Value)->Result<(Value,Value),StorageError>{
        let mut c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id:Option<String>=tx.query_row("SELECT id FROM exec_snapshots WHERE turn_id=?1",[turn_id],|r|r.get(0)).optional()?;let id=id.ok_or(StorageError::AgentNotFound)?;
        let snapshot=exec_snapshot_read(&tx,&id)?.ok_or(StorageError::AgentNotFound)?;
        let applied=snapshot_outcomes(outcomes);let evidence=snapshot_evidence(outcomes);
        let failed=outcomes.as_object().is_some_and(|m|m.values().any(|v|v["applied"]==false));
        let pending=outcomes.as_object().is_some_and(|m|m.values().any(|v|v["applied"].is_null()));
        let status=if failed||pending{"partial"}else{"applied"};
        tx.execute("UPDATE exec_snapshots SET applied_json=?2,evidence_json=?3,status=?4 WHERE id=?1",params![id,applied.to_string(),evidence.to_string(),status])?;
        if snapshot["provider"]=="claude"&&outcomes["instructions"]["applied"]==true { tx.execute("UPDATE sessions SET claude_instruction_sha256=?2 WHERE id=?1",params![snapshot["sessionId"].as_str().unwrap_or(""),snapshot["instructionSha256"].as_str()])?; }
        if snapshot["provider"]=="codex"&&outcomes["instructions"]["applied"]==true {
            // A successful new-thread turn proves the text installed at
            // thread/start: keep the first write only (COALESCE). An
            // applied-with-evidence change on an existing thread proves the
            // installed text moved, so it takes the explicit overwrite path.
            let session=snapshot["sessionId"].as_str().unwrap_or("");let hash=snapshot["instructionSha256"].as_str();
            if outcomes["instructions"]["evidenceKind"].as_str()==Some("provider_echo") {
                tx.execute("UPDATE sessions SET codex_thread_instruction_sha256=?2 WHERE id=?1",params![session,hash])?;
            } else {
                tx.execute("UPDATE sessions SET codex_thread_instruction_sha256=COALESCE(codex_thread_instruction_sha256,?2) WHERE id=?1",params![session,hash])?;
            }
        }
        let payload=json!({"sessionId":snapshot["sessionId"],"turnId":turn_id,"agentId":snapshot["agentId"],"runtimeId":snapshot["runtimeId"],"requested":snapshot["requested"],"applied":outcomes,"snapshotId":id});
        let event_id=Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'exec.options.changed',?3)",params![event_id,now,payload.to_string()])?;
        let event=json!({"v":1,"eventId":event_id,"sequence":tx.last_insert_rowid(),"timestamp":now,"type":"exec.options.changed","payload":payload});
        let updated=exec_snapshot_read(&tx,&id)?.ok_or(StorageError::InvalidAgent)?;tx.commit()?;Ok((updated,event))
    }
    pub fn exec_snapshot_get(&self,id:&str)->Result<Option<Value>,StorageError>{let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;exec_snapshot_read(&c,id)}
    pub fn exec_snapshot_latest(&self,session_id:&str)->Result<Option<Value>,StorageError>{let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;let id:Option<String>=c.query_row("SELECT latest_exec_snapshot_id FROM sessions WHERE id=?1",[session_id],|r|r.get(0)).optional()?.flatten();match id{Some(id)=>exec_snapshot_read(&c,&id),None=>Ok(None)}}
    pub fn exec_snapshot_list(&self,session_id:&str,after:Option<&str>,limit:u32)->Result<(Vec<Value>,Option<String>),StorageError>{
        let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;let limit=limit.clamp(1,200) as i64;
        let mut q=c.prepare("SELECT id FROM exec_snapshots WHERE session_id=?1 AND (?2 IS NULL OR (created_at,id)>(SELECT created_at,id FROM exec_snapshots WHERE id=?2)) ORDER BY created_at,id LIMIT ?3")?;
        let ids=q.query_map(params![session_id,after,limit+1],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        let next=if ids.len()>limit as usize{ids.get(limit as usize-1).cloned()}else{None};let ids=ids.into_iter().take(limit as usize).collect::<Vec<_>>();let mut values=Vec::new();for id in ids{if let Some(v)=exec_snapshot_read(&c,&id)?{values.push(v)}}Ok((values,next))
    }
    pub fn set_session_provider_id(
        &self,
        id: &str,
        provider_id: &str,
        resumable: bool,
    ) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [id], |r| r.get(0))?;
        if !exists { return Ok(()); }
        c.execute("UPDATE sessions SET provider_session_id=?2,resumable=?3 WHERE id=?1",params![id,provider_id,resumable])?;
        Ok(())
    }
    pub fn sessions(&self) -> Result<Vec<Value>, StorageError> { self.session_list(false) }
    pub fn session_list(&self, include_archived: bool) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut s=c.prepare("SELECT id,runtime_id,provider,provider_session_id,project_path,COALESCE(title_override,title),state,resumable,created_at,updated_at,agent_id,archived,model_lock_json,json_extract(data,'$.link'),COALESCE((SELECT p.name FROM projects p WHERE p.id=json_extract(sessions.data,'$.projectId')),(SELECT p.name FROM projects p WHERE p.path=sessions.project_path),'Casual') FROM sessions WHERE (?1 OR archived=0) ORDER BY updated_at DESC")?;
        let iter=s.query_map([include_archived],|r|Ok(json!({"id":r.get::<_,String>(0)?,"runtimeId":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?,"providerSessionId":r.get::<_,Option<String>>(3)?,"projectPath":r.get::<_,String>(4)?,"title":r.get::<_,String>(5)?,"state":r.get::<_,String>(6)?,"resumable":r.get::<_,bool>(7)?,"createdAt":r.get::<_,String>(8)?,"updatedAt":r.get::<_,String>(9)?,"agentId":r.get::<_,Option<String>>(10)?,"archived":r.get::<_,bool>(11)?,"modelLock":r.get::<_,Option<String>>(12)?.and_then(|value|serde_json::from_str::<Value>(&value).ok()),"link":r.get::<_,Option<String>>(13)?.and_then(|value|serde_json::from_str::<Value>(&value).ok()),"workspaceLabel":r.get::<_,String>(14)?})))?;
        iter.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }
    pub fn session_exists(&self, id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [id], |r| r.get(0))?)
    }
    pub fn session_state(&self, id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT state FROM sessions WHERE id=?1", [id], |r| r.get(0)).optional()?)
    }
    pub fn session_event_summary(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        session_event_summary_locked(&c, id)
    }
    pub fn session_rename(&self, id: &str, title: &str) -> Result<Value, StorageError> {
        let title = title.trim();
        let count = title.chars().count();
        if !(1..=120).contains(&count) { return Err(StorageError::InvalidAgent); }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE sessions SET title_override=?2,updated_at=?3 WHERE id=?1", params![id, title, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)])?;
        if changed == 0 { return Err(StorageError::AgentNotFound); }
        session_event_summary_locked(&c, id)
    }
    /// Writes a title derived from the first prompt, but only while the row
    /// still carries a default title (`'New chat'` or the agent's own name), no
    /// user message exists yet, the row is not a side conversation and the user
    /// has not renamed it. It writes `title`, never `title_override`, so a user
    /// rename always wins. Returns the summary when a row changed.
    pub fn session_auto_title(&self, id: &str, title: &str) -> Result<Option<Value>, StorageError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 { return Ok(None); }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute(
            "UPDATE sessions SET title=?2,updated_at=?3 WHERE id=?1 AND title_override IS NULL AND (title='New chat' OR title=COALESCE((SELECT name FROM agents WHERE agents.id=sessions.agent_id),'')) AND json_extract(data,'$.link.kind') IS NOT 'side' AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.session_id=sessions.id AND m.role='user')",
            params![id, title, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)],
        )?;
        if changed == 0 { return Ok(None); }
        Ok(Some(session_event_summary_locked(&c, id)?))
    }
    /// Merges top-level keys into a session's `data` object (RFC 7396 patch).
    pub fn merge_session_data(&self, id: &str, fields: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE sessions SET data=json_patch(COALESCE(NULLIF(data,''),'{}'),json(?2)) WHERE id=?1", params![id, fields.to_string()])?;
        if changed == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }
    /// Whether a conversation was created lazily and has not started its
    /// provider yet (`data.lazyStart`, cleared once the provider installs).
    pub fn session_lazy_start(&self, id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let flag: Option<i64> = c.query_row("SELECT json_extract(data,'$.lazyStart') FROM sessions WHERE id=?1", [id], |r| r.get(0)).optional()?.flatten();
        Ok(flag == Some(1))
    }
    /// Clears the lazy-start marker once the provider context is installed.
    pub fn clear_session_lazy_start(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE sessions SET data=json_remove(data,'$.lazyStart') WHERE id=?1", [id])?;
        Ok(())
    }
    /// The id of the project whose folder is exactly `path`, if any.
    pub fn project_id_for_path(&self, path: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT id FROM projects WHERE path=?1 LIMIT 1", [path], |r| r.get(0)).optional()?)
    }
    pub fn session_provider_title(&self, id: &str, title: &str) -> Result<Option<Value>, StorageError> {
        let title = title.trim();
        let count = title.chars().count();
        if !(1..=120).contains(&count) { return Err(StorageError::InvalidAgent); }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute(
            "UPDATE sessions SET title=?2,updated_at=?3 WHERE id=?1 AND title_override IS NULL",
            params![id, title, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)],
        )?;
        if changed == 0 {
            let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [id], |r| r.get(0))?;
            return if exists { Ok(None) } else { Err(StorageError::AgentNotFound) };
        }
        Ok(Some(session_event_summary_locked(&c, id)?))
    }
    pub fn session_archive(&self, id: &str, archived: bool) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE sessions SET archived=?2,updated_at=?3 WHERE id=?1", params![id, archived, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)])?;
        if changed == 0 { return Err(StorageError::AgentNotFound); }
        session_event_summary_locked(&c, id)
    }
    pub fn session_delete(&self, id: &str) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: Option<String> = tx.query_row("SELECT state FROM sessions WHERE id=?1", [id], |r| r.get(0)).optional()?;
        let state = state.ok_or(StorageError::AgentNotFound)?;
        if matches!(state.as_str(), "starting" | "working" | "cancelling" | "waiting_permission") { return Err(StorageError::SessionActive); }
        tx.execute("DELETE FROM active_turn_reservations WHERE session_id=?1", [id])?;
        tx.execute("DELETE FROM exec_snapshots WHERE session_id=?1", [id])?;
        tx.execute("DELETE FROM usage_valuations WHERE usage_event_id IN (SELECT id FROM usage_events WHERE session_id=?1)", [id])?;
        for table in ["messages", "tool_calls", "file_changes", "permission_requests", "usage_events", "turns"] {
            tx.execute(&format!("DELETE FROM {table} WHERE session_id=?1"), [id])?;
        }
        tx.execute("DELETE FROM queued_prompts WHERE session_id=?1", [id])?;
        tx.execute("DELETE FROM app_events WHERE json_valid(payload) AND (json_extract(payload,'$.sessionId')=?1 OR json_extract(payload,'$.session.id')=?1 OR (event_type='session.changed' AND json_extract(payload,'$.id')=?1))", [id])?;
        tx.execute("DELETE FROM sessions WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
    // ── Durable prompt queue ───────────────────────────────────────────────
    /// Append one validated prompt to a session's durable queue. The caller
    /// owns all user-facing validation; this only checks the session exists.
    pub fn queue_add(&self, session_id: &str, params: &Value, kind: &str, due_at: Option<&str>) -> Result<Value, StorageError> {
        if !["user", "send_later", "retry"].contains(&kind) { return Err(StorageError::InvalidAgent); }
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session_id], |r| r.get(0))?;
        if !exists { return Err(StorageError::AgentNotFound); }
        let position: i64 = tx.query_row("SELECT COALESCE(MAX(position)+1,0) FROM queued_prompts WHERE session_id=?1", [session_id], |r| r.get(0))?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let params_json = params.to_string();
        tx.execute("INSERT INTO queued_prompts(id,session_id,position,params_json,kind,due_at,status,error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'queued',NULL,?7,?7)", params![id,session_id,position,params_json,kind,due_at,now])?;
        tx.commit()?;
        Ok(queued_prompt_dto(&id,session_id,position,&params_json,kind,due_at,"queued",None,&now,Utc::now()))
    }
    /// Insert one plain prompt at the head of a session's queue, shifting the
    /// other rows down. Used when a steer falls back to the 2A queue so the
    /// user's text is tried again before anything already waiting.
    pub fn queue_add_front(&self, session_id: &str, params: &Value) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session_id], |r| r.get(0))?;
        if !exists { return Err(StorageError::AgentNotFound); }
        tx.execute("UPDATE queued_prompts SET position=position+1 WHERE session_id=?1", [session_id])?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let params_json = params.to_string();
        tx.execute("INSERT INTO queued_prompts(id,session_id,position,params_json,kind,due_at,status,error,created_at,updated_at) VALUES(?1,?2,0,?3,'user',NULL,'queued',NULL,?4,?4)", params![id,session_id,params_json,now])?;
        tx.commit()?;
        Ok(queued_prompt_dto(&id,session_id,0,&params_json,"user",None,"queued",None,&now,Utc::now()))
    }
    /// Full list for a session: scheduled items by due time first, then plain
    /// items by position. `lateBySecs` is derived here, never stored.
    pub fn queue_list(&self, session_id: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now();
        let mut q = c.prepare("SELECT id,position,params_json,kind,due_at,status,error,created_at FROM queued_prompts WHERE session_id=?1 ORDER BY CASE WHEN kind IN ('send_later','retry') THEN 0 ELSE 1 END,due_at,position,created_at,id")?;
        let rows = q.query_map([session_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,String>(7)?)))?.collect::<Result<Vec<_>,_>>()?;
        Ok(rows.into_iter().map(|(id,position,params,kind,due,status,error,created)| queued_prompt_dto(&id,session_id,position,&params,&kind,due.as_deref(),&status,error.as_deref(),&created,now)).collect())
    }
    pub fn queue_get(&self, session_id: &str, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now();
        let row = c.query_row("SELECT position,params_json,kind,due_at,status,error,created_at FROM queued_prompts WHERE session_id=?1 AND id=?2", params![session_id,id], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,String>(6)?))).optional()?;
        let (position,params,kind,due,status,error,created) = row.ok_or(StorageError::AgentNotFound)?;
        Ok(queued_prompt_dto(id,session_id,position,&params,&kind,due.as_deref(),&status,error.as_deref(),&created,now))
    }
    pub fn queue_count_queued(&self, session_id: &str) -> Result<i64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COUNT(*) FROM queued_prompts WHERE session_id=?1 AND status='queued'", [session_id], |r| r.get(0))?)
    }
    pub fn queue_has_queued(&self, session_id: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM queued_prompts WHERE session_id=?1 AND status='queued')", [session_id], |r| r.get(0))?)
    }
    /// Edit a still-queued item. `text` replaces the text; `due_at` is
    /// `None` to leave scheduling alone, `Some(None)` to convert to a plain
    /// item, and `Some(Some(at))` to schedule it.
    pub fn queue_update(&self, session_id: &str, id: &str, text: Option<&str>, due_at: Option<Option<&str>>) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(i64,String,String,String,Option<String>)> = tx.query_row("SELECT position,params_json,status,kind,due_at FROM queued_prompts WHERE session_id=?1 AND id=?2", params![session_id,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let (position,mut params_json,status,mut kind,mut due) = row.ok_or(StorageError::AgentNotFound)?;
        if status != "queued" { return Err(StorageError::AgentConflict); }
        if let Some(text) = text {
            let mut params: Value = serde_json::from_str(&params_json)?;
            params["text"] = json!(text);
            params_json = params.to_string();
        }
        if let Some(next) = due_at {
            match next {
                None => { kind = "user".to_owned(); due = None; }
                Some(value) => { kind = "send_later".to_owned(); due = Some(value.to_owned()); }
            }
        }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        tx.execute("UPDATE queued_prompts SET params_json=?2,kind=?3,due_at=?4,updated_at=?5 WHERE id=?1", params![id,&params_json,&kind,&due,&now])?;
        tx.commit()?;
        Ok(queued_prompt_dto(id,session_id,position,&params_json,&kind,due.as_deref(),"queued",None,&now,Utc::now()))
    }
    /// Replace the order of a session's queued plain items. `ids` must be
    /// exactly that set, otherwise the request is invalid.
    pub fn queue_reorder(&self, session_id: &str, ids: &[String]) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Vec<String> = {
            let mut q = tx.prepare("SELECT id FROM queued_prompts WHERE session_id=?1 AND status='queued' AND kind='user'")?;
            let rows = q.query_map([session_id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            rows
        };
        let mut requested = ids.to_vec(); requested.sort();
        let mut current = existing; current.sort();
        if requested != current { return Err(StorageError::InvalidAgent); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        for (index, id) in ids.iter().enumerate() {
            tx.execute("UPDATE queued_prompts SET position=?2,updated_at=?3 WHERE session_id=?4 AND id=?1 AND status='queued'", params![id,index as i64,now,session_id])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn queue_delete(&self, session_id: &str, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("DELETE FROM queued_prompts WHERE session_id=?1 AND id=?2 AND status IN ('queued','failed')", params![session_id,id])?;
        if changed == 0 {
            let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM queued_prompts WHERE session_id=?1 AND id=?2)", params![session_id,id], |r| r.get(0))?;
            return if exists { Err(StorageError::AgentConflict) } else { Err(StorageError::AgentNotFound) };
        }
        Ok(())
    }
    /// Move one queued plain item to the head of the plain queue.
    pub fn queue_move_to_front(&self, session_id: &str, id: &str) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status: Option<String> = tx.query_row("SELECT status FROM queued_prompts WHERE session_id=?1 AND id=?2", params![session_id,id], |r| r.get(0)).optional()?;
        match status.as_deref() {
            Some("queued") => {}
            Some(_) => return Err(StorageError::AgentConflict),
            None => return Err(StorageError::AgentNotFound),
        }
        let mut ordered: Vec<String> = {
            let mut q = tx.prepare("SELECT id FROM queued_prompts WHERE session_id=?1 AND status='queued' AND kind='user' ORDER BY position,created_at,id")?;
            let rows = q.query_map([session_id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            rows
        };
        if let Some(index) = ordered.iter().position(|candidate| candidate == id) { ordered.remove(index); }
        ordered.insert(0, id.to_owned());
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        for (index, item) in ordered.iter().enumerate() {
            tx.execute("UPDATE queued_prompts SET position=?2,updated_at=?3 WHERE session_id=?4 AND id=?1 AND status='queued'", params![item,index as i64,now,session_id])?;
        }
        tx.commit()?;
        Ok(())
    }
    /// Atomically claim the next eligible item. When `allow_plain` is false
    /// only due scheduled items are candidates, so a paused session never
    /// auto-sends a plain prompt.
    pub fn queue_claim_next(&self, session_id: &str, now: &str, allow_plain: bool) -> Result<Option<Value>, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String,i64,String,String,Option<String>)> = tx.query_row(
            "SELECT id,position,params_json,kind,due_at FROM queued_prompts WHERE session_id=?1 AND status='queued' AND ((kind IN ('send_later','retry') AND due_at IS NOT NULL AND due_at<=?2) OR (?3 AND kind='user')) ORDER BY CASE WHEN kind IN ('send_later','retry') THEN 0 ELSE 1 END,due_at,position,created_at,id LIMIT 1",
            params![session_id,now,allow_plain],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))
        ).optional()?;
        let Some((id,position,params,kind,due)) = row else { tx.commit()?; return Ok(None); };
        let changed = tx.execute("UPDATE queued_prompts SET status='sending',updated_at=?2 WHERE id=?1 AND status='queued'", params![id,now])?;
        tx.commit()?;
        if changed == 0 { return Ok(None); }
        Ok(Some(queued_prompt_dto(&id,session_id,position,&params,&kind,due.as_deref(),"sending",None,now,Utc::now())))
    }
    /// Claim one specific queued item (used by `send_now` on an idle session).
    /// A previously `failed` item can be retried: claiming it clears `error`
    /// and keeps its position.
    pub fn queue_claim(&self, session_id: &str, id: &str, now: &str) -> Result<Option<Value>, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute("UPDATE queued_prompts SET status='sending',error=NULL,updated_at=?3 WHERE session_id=?1 AND id=?2 AND status IN ('queued','failed')", params![session_id,id,now])?;
        if changed == 0 { tx.commit()?; return Ok(None); }
        let (position,params,kind,due): (i64,String,String,Option<String>) = tx.query_row("SELECT position,params_json,kind,due_at FROM queued_prompts WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        tx.commit()?;
        Ok(Some(queued_prompt_dto(id,session_id,position,&params,&kind,due.as_deref(),"sending",None,now,Utc::now())))
    }
    pub fn queue_mark_sent(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("DELETE FROM queued_prompts WHERE id=?1 AND status='sending'", [id])?;
        Ok(())
    }
    pub fn queue_mark_failed(&self, id: &str, error: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        c.execute("UPDATE queued_prompts SET status='failed',error=?2,updated_at=?3 WHERE id=?1 AND status='sending'", params![id,error,now])?;
        Ok(())
    }
    /// Return a claimed item to the queue without changing its position or
    /// flagging a failure. Used when a provider reports a transient conflict
    /// (for example a turn that started between the idle check and the send).
    pub fn queue_requeue(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        c.execute("UPDATE queued_prompts SET status='queued',error=NULL,updated_at=?2 WHERE id=?1 AND status='sending'", params![id,now])?;
        Ok(())
    }
    pub fn queue_due_sessions(&self, now: &str) -> Result<Vec<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT DISTINCT session_id FROM queued_prompts WHERE status='queued' AND kind IN ('send_later','retry') AND due_at IS NOT NULL AND due_at<=?1")?;
        let rows = q.query_map([now], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        Ok(rows)
    }
    pub fn queue_paused_sessions(&self) -> Result<Vec<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT DISTINCT session_id FROM queued_prompts WHERE status='queued' AND kind='user'")?;
        let rows = q.query_map([], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        Ok(rows)
    }
    /// The session's pending automatic-retry item, if one is queued or being sent.
    /// Returns `{id,retryOf,attempt}` or `None`.
    pub fn queue_pending_retry(&self, session_id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row: Option<(String, String)> = c.query_row(
            "SELECT id,params_json FROM queued_prompts WHERE session_id=?1 AND kind='retry' AND status IN ('queued','sending') ORDER BY created_at,id LIMIT 1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        Ok(row.map(|(id, params)| {
            let params: Value = serde_json::from_str(&params).unwrap_or(Value::Null);
            json!({"id":id,"retryOf":params["meta"]["retryOf"],"attempt":params["meta"]["attempt"]})
        }))
    }
    /// Remove every pending retry item for a session, returning what was removed
    /// so the caller can record the cancel in the original turn's audit data.
    pub fn queue_delete_retries(&self, session_id: &str) -> Result<Vec<Value>, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows = {
            let mut q = tx.prepare("SELECT id,params_json FROM queued_prompts WHERE session_id=?1 AND kind='retry' AND status IN ('queued','sending')")?;
            let collected = q.query_map([session_id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
            collected
        };
        tx.execute("DELETE FROM queued_prompts WHERE session_id=?1 AND kind='retry' AND status IN ('queued','sending')", [session_id])?;
        tx.commit()?;
        Ok(rows.into_iter().map(|(id, params)| {
            let params: Value = serde_json::from_str(&params).unwrap_or(Value::Null);
            json!({"id":id,"retryOf":params["meta"]["retryOf"],"attempt":params["meta"]["attempt"]})
        }).collect())
    }
    /// Sessions with a pending retry item (queued or being sent).
    pub fn queue_retry_sessions(&self) -> Result<Vec<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT DISTINCT session_id FROM queued_prompts WHERE kind='retry' AND status IN ('queued','sending')")?;
        let rows = q.query_map([], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        Ok(rows)
    }
    /// Queued retry items whose due time is at or before `cutoff`. Used after a
    /// restart to drop retries that are too overdue to fire safely.
    pub fn queue_stale_retries(&self, cutoff: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT id,session_id,params_json,due_at FROM queued_prompts WHERE kind='retry' AND status='queued' AND due_at IS NOT NULL AND due_at<=?1")?;
        let rows = q.query_map([cutoff], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
        Ok(rows.into_iter().map(|(id, session, params, due)| {
            let params: Value = serde_json::from_str(&params).unwrap_or(Value::Null);
            json!({"id":id,"sessionId":session,"retryOf":params["meta"]["retryOf"],"attempt":params["meta"]["attempt"],"dueAt":due})
        }).collect())
    }
    /// Rewrite a retry item's due time without changing its kind. Deterministic
    /// tests use this to fire a scheduled retry immediately.
    #[doc(hidden)]
    pub fn queue_set_retry_due(&self, id: &str, due_at: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        c.execute("UPDATE queued_prompts SET due_at=?2,updated_at=?3 WHERE id=?1 AND kind='retry'", params![id, due_at, now])?;
        Ok(())
    }
    /// Remove one queued or failed row by id (used to drop an overdue retry).
    pub fn queue_delete_by_id(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("DELETE FROM queued_prompts WHERE id=?1 AND status IN ('queued','failed')", [id])?;
        Ok(())
    }
    // ── Scheduled automations ──────────────────────────────────────────────
    /// Insert an automation after full validation. New automations are
    /// disabled unless the request explicitly sets `enabled:true`; run
    /// sessions are clamped to `plan`/`auto` at execution time.
    pub fn automation_create(&self, input: &Value) -> Result<Value, StorageError> {
        let agent_id = input["agentId"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or(StorageError::InvalidAgent)?.to_owned();
        let name = input["name"].as_str().map(str::trim).unwrap_or("");
        if !(1..=80).contains(&name.chars().count()) { return Err(StorageError::InvalidAgent); }
        let prompt = input["prompt"].as_str().unwrap_or("");
        if prompt.is_empty() || prompt.len() > 8000 { return Err(StorageError::InvalidAgent); }
        let session_mode = automation_session_mode(input)?;
        let approval_mode = automation_approval_mode(input, "auto")?;
        let max_runtime_secs = automation_runtime_secs(input)?;
        let enabled = match input.get("enabled") { None | Some(Value::Null) => false, Some(value) => value.as_bool().ok_or(StorageError::InvalidAgent)? };
        let created_by = match input.get("createdBy") { None | Some(Value::Null) => "user".to_owned(), Some(Value::String(value)) if value == "user" || value == "agent" => value.clone(), _ => return Err(StorageError::InvalidAgent) };
        let pause_reason = match input.get("pauseReason") { None | Some(Value::Null) => None, Some(Value::String(value)) => Some(value.clone()), _ => return Err(StorageError::InvalidAgent) };
        let now = Utc::now();
        let schedule = cron::parse_schedule(&input["schedule"], Some(now))?;
        let next_run_at = cron::next_run_at(&schedule, now)?;
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let agent: Option<(bool,)> = tx.query_row("SELECT archived FROM agents WHERE id=?1", [&agent_id], |r| Ok((r.get(0)?,))).optional()?;
        let (archived,) = agent.ok_or(StorageError::AgentNotFound)?;
        if archived { return Err(StorageError::AgentConflict); }
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM automations", [], |r| r.get(0))?;
        if count >= 50 { return Err(StorageError::AgentConflict); }
        let id = Uuid::new_v4().to_string();
        let now_text = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        tx.execute(
            "INSERT INTO automations(id,agent_id,name,prompt,schedule_kind,cron,timezone,once_at,session_mode,approval_mode,max_runtime_secs,enabled,created_by,reuse_session_id,next_run_at,last_run_at,consecutive_failures,pause_reason,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,?14,NULL,0,?15,?16,?16)",
            params![id, agent_id, name, prompt, schedule.kind, schedule.cron, schedule.timezone, schedule.once_at, session_mode, approval_mode, max_runtime_secs, enabled, created_by, next_run_at, pause_reason, now_text],
        )?;
        let dto = automation_read(&tx, &id)?;
        tx.commit()?;
        Ok(dto)
    }

    pub fn automation_get(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        automation_read(&c, id)
    }

    pub fn automation_list(&self, agent_id: Option<&str>) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let ids = {
            let mut q = c.prepare("SELECT id FROM automations WHERE (?1 IS NULL OR agent_id=?1) ORDER BY created_at,id")?;
            let rows = q.query_map(params![agent_id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            rows
        };
        ids.iter().map(|id| automation_read(&c, id)).collect()
    }

    /// Update mutable fields and recompute `next_run_at` from the (possibly new)
    /// schedule. `enabled` is the one toggle; pausing with a reason is a
    /// separate call so a scheduler race cannot silently re-enable a blob.
    pub fn automation_update(&self, id: &str, input: &Value) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = automation_read(&tx, id)?;
        let now = Utc::now();
        let name = match input.get("name") { None => existing["name"].as_str().unwrap_or("").to_owned(), Some(value) => value.as_str().map(str::trim).filter(|value| (1..=80).contains(&value.chars().count())).ok_or(StorageError::InvalidAgent)?.to_owned() };
        let prompt = match input.get("prompt") { None => existing["prompt"].as_str().unwrap_or("").to_owned(), Some(value) => value.as_str().filter(|value| !value.is_empty() && value.len() <= 8000).ok_or(StorageError::InvalidAgent)?.to_owned() };
        let session_mode = match input.get("sessionMode") { None => existing["sessionMode"].as_str().unwrap_or("new").to_owned(), Some(_) => automation_session_mode(input)? };
        let approval_mode = match input.get("approvalMode") { None => existing["approvalMode"].as_str().unwrap_or("auto").to_owned(), Some(_) => automation_approval_mode(input, "auto")? };
        let max_runtime_secs = match input.get("maxRuntimeSecs") { None => existing["maxRuntimeSecs"].as_i64().unwrap_or(1800), Some(_) => automation_runtime_secs(input)? };
        let enabled = match input.get("enabled") { None => existing["enabled"].as_bool().unwrap_or(false), Some(value) => value.as_bool().ok_or(StorageError::InvalidAgent)? };
        let schedule = match input.get("schedule") {
            None => cron::parse_schedule(&existing["schedule"], None)?,
            Some(value) => cron::parse_schedule(value, Some(now))?,
        };
        let next_run_at = cron::next_run_at(&schedule, now)?;
        let pause_reason: Option<String> = match input.get("pauseReason") {
            None => existing["pauseReason"].as_str().map(str::to_owned),
            Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.clone()),
            _ => return Err(StorageError::InvalidAgent),
        };
        let now_text = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        tx.execute(
            "UPDATE automations SET name=?2,prompt=?3,schedule_kind=?4,cron=?5,timezone=?6,once_at=?7,session_mode=?8,approval_mode=?9,max_runtime_secs=?10,enabled=?11,next_run_at=?12,pause_reason=?13,updated_at=?14 WHERE id=?1",
            params![id, name, prompt, schedule.kind, schedule.cron, schedule.timezone, schedule.once_at, session_mode, approval_mode, max_runtime_secs, enabled, next_run_at, pause_reason, now_text],
        )?;
        let dto = automation_read(&tx, id)?;
        tx.commit()?;
        Ok(dto)
    }

    pub fn automation_pause(&self, id: &str) -> Result<Value, StorageError> {
        self.automation_set_enabled(id, false, Some("user"), false)
    }

    /// Resume clears the failure counter and pause reason and recomputes the
    /// next occurrence from now.
    pub fn automation_resume(&self, id: &str) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = automation_read(&tx, id)?;
        let schedule = cron::parse_schedule(&existing["schedule"], None)?;
        let next_run_at = cron::next_run_at(&schedule, Utc::now())?;
        tx.execute(
            "UPDATE automations SET enabled=1,pause_reason=NULL,consecutive_failures=0,next_run_at=?2,updated_at=?3 WHERE id=?1",
            params![id, next_run_at, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)],
        )?;
        let dto = automation_read(&tx, id)?;
        tx.commit()?;
        Ok(dto)
    }

    fn automation_set_enabled(&self, id: &str, enabled: bool, pause_reason: Option<&str>, clear_failures: bool) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let changed = if clear_failures {
            c.execute("UPDATE automations SET enabled=?2,pause_reason=?3,consecutive_failures=0,updated_at=?4 WHERE id=?1", params![id, enabled, pause_reason, now])?
        } else {
            c.execute("UPDATE automations SET enabled=?2,pause_reason=?3,updated_at=?4 WHERE id=?1", params![id, enabled, pause_reason, now])?
        };
        if changed == 0 { return Err(StorageError::AgentNotFound); }
        automation_read(&c, id)
    }

    /// Delete the automation but keep its run history and run sessions.
    pub fn automation_delete(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if c.execute("DELETE FROM automations WHERE id=?1", [id])? == 0 { return Err(StorageError::AgentNotFound); }
        Ok(())
    }

    /// Pause every automation owned by an archived blob, returning the updated
    /// DTOs so the daemon can emit `automation.changed`.
    pub fn automation_pause_for_agent(&self, agent_id: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let ids = {
            let mut q = c.prepare("SELECT id FROM automations WHERE agent_id=?1 AND (enabled=1 OR pause_reason IS NULL)")?;
            let rows = q.query_map([agent_id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if ids.is_empty() { return Ok(Vec::new()); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut updated = Vec::new();
        for id in ids {
            c.execute("UPDATE automations SET enabled=0,pause_reason='user',updated_at=?2 WHERE id=?1", params![id, now])?;
            updated.push(automation_read(&c, &id)?);
        }
        Ok(updated)
    }

    pub fn automation_count(&self) -> Result<i64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COUNT(*) FROM automations", [], |r| r.get(0))?)
    }

    /// Enabled automations whose `next_run_at` has arrived.
    pub fn automation_due(&self, now: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let ids = {
            let mut q = c.prepare("SELECT id FROM automations WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?1 ORDER BY next_run_at,id")?;
            let rows = q.query_map([now], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            rows
        };
        ids.iter().map(|id| automation_read(&c, id)).collect()
    }

    /// Write the next occurrence. `None` clears it (once, or a schedule with no
    /// future occurrence).
    pub fn automation_set_next(&self, id: &str, next_run_at: Option<&str>) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE automations SET next_run_at=?2,updated_at=?3 WHERE id=?1", params![id, next_run_at, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)])?;
        automation_read(&c, id)
    }

    /// Record a completed occurrence: reset the failure counter and move to the
    /// next occurrence (or disable a `once` automation).
    pub fn automation_finish_success(&self, id: &str, next_run_at: Option<&str>, disable: bool) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        c.execute(
            "UPDATE automations SET consecutive_failures=0,last_run_at=?2,next_run_at=?3,enabled=CASE WHEN ?4 THEN 0 ELSE enabled END,pause_reason=NULL,updated_at=?2 WHERE id=?1",
            params![id, now, next_run_at, disable],
        )?;
        automation_read(&c, id)
    }

    /// Record a failed occurrence. Below the auto-pause threshold the caller
    /// passes the retry time; at three consecutive failures the automation is
    /// disabled with `pause_reason='auto_failures'`.
    pub fn automation_finish_failure(&self, id: &str, failures: i64, next_run_at: Option<&str>, auto_pause: bool) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        if auto_pause {
            c.execute(
                "UPDATE automations SET consecutive_failures=?2,last_run_at=?3,next_run_at=NULL,enabled=0,pause_reason='auto_failures',updated_at=?3 WHERE id=?1",
                params![id, failures, now],
            )?;
        } else {
            c.execute(
                "UPDATE automations SET consecutive_failures=?2,last_run_at=?3,next_run_at=?4,updated_at=?3 WHERE id=?1",
                params![id, failures, now, next_run_at],
            )?;
        }
        automation_read(&c, id)
    }

    pub fn automation_set_reuse_session(&self, id: &str, session_id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE automations SET reuse_session_id=?2,updated_at=?3 WHERE id=?1", params![id, session_id, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)])?;
        Ok(())
    }

    // ── Automation runs ────────────────────────────────────────────────────
    // Run insertion mirrors the persisted columns; a struct would only relocate the fields.
    #[allow(clippy::too_many_arguments)]
    pub fn automation_run_insert(&self, id: &str, automation_id: &str, session_id: Option<&str>, status: &str, reason: Option<&str>, scheduled_for: Option<&str>, started_at: &str) -> Result<Value, StorageError> {
        if !["running", "completed", "failed", "skipped", "cancelled", "timeout", "interrupted"].contains(&status) { return Err(StorageError::InvalidAgent); }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "INSERT INTO automation_runs(id,automation_id,session_id,status,reason,scheduled_for,started_at,finished_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, automation_id, session_id, status, reason, scheduled_for, started_at, if status == "running" { None } else { Some(started_at) }],
        )?;
        automation_run_dto(&c, id)
    }

    /// Finish a run only while it is still `running`, so a watchdog timeout is
    /// not overwritten by the later `turn.cancelled` event.
    pub fn automation_run_finish(&self, id: &str, status: &str, reason: Option<&str>) -> Result<Option<Value>, StorageError> {
        if !["completed", "failed", "skipped", "cancelled", "timeout", "interrupted"].contains(&status) { return Err(StorageError::InvalidAgent); }
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE automation_runs SET status=?2,reason=?3,finished_at=?4 WHERE id=?1 AND status='running'", params![id, status, reason, Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)])?;
        if changed == 0 { return Ok(None); }
        Ok(Some(automation_run_dto(&c, id)?))
    }

    pub fn automation_run_get(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        automation_run_dto(&c, id)
    }

    pub fn automation_run_running_for(&self, automation_id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let id: Option<String> = c.query_row("SELECT id FROM automation_runs WHERE automation_id=?1 AND status='running' LIMIT 1", [automation_id], |r| r.get(0)).optional()?;
        id.map(|id| automation_run_dto(&c, &id)).transpose()
    }

    /// The run a session belongs to, if it is still running.
    pub fn automation_run_running_for_session(&self, session_id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let id: Option<String> = c.query_row("SELECT id FROM automation_runs WHERE session_id=?1 AND status='running' ORDER BY started_at DESC LIMIT 1", [session_id], |r| r.get(0)).optional()?;
        id.map(|id| automation_run_dto(&c, &id)).transpose()
    }

    /// Running runs joined with their runtime cap, for the watchdog.
    pub fn automation_runs_running(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT r.id,r.automation_id,r.session_id,r.started_at,a.max_runtime_secs FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.status='running'")?;
        let rows = q.query_map([], |r| Ok(json!({
            "id":r.get::<_,String>(0)?,"automationId":r.get::<_,String>(1)?,"sessionId":r.get::<_,Option<String>>(2)?,
            "startedAt":r.get::<_,String>(3)?,"maxRuntimeSecs":r.get::<_,i64>(4)?,
        })))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn automation_running_count(&self) -> Result<i64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COUNT(*) FROM automation_runs WHERE status='running'", [], |r| r.get(0))?)
    }

    /// After a restart, running runs become `interrupted` (not failures) and
    /// their sessions are left untouched.
    pub fn automation_interrupt_running(&self) -> Result<usize, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE automation_runs SET status='interrupted',finished_at=?1 WHERE status='running'", [Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)])?;
        Ok(changed)
    }

    /// Run history newest first, optionally before a cursor run id.
    pub fn automation_runs_list(&self, automation_id: &str, limit: usize, before: Option<&str>) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let cursor: Option<(String, String)> = match before {
            Some(id) => c.query_row("SELECT started_at,id FROM automation_runs WHERE id=?1 AND automation_id=?2", params![id, automation_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?,
            None => None,
        };
        let ids = {
            let mut q = c.prepare(
                "SELECT id FROM automation_runs WHERE automation_id=?1 AND (?2 IS NULL OR started_at<?2 OR (started_at=?2 AND id<?3)) ORDER BY started_at DESC,id DESC LIMIT ?4",
            )?;
            let (started, cursor_id) = cursor.map_or((None, None), |(started, id)| (Some(started), Some(id)));
            let rows = q.query_map(params![automation_id, started, cursor_id, limit as i64], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            rows
        };
        ids.iter().map(|id| automation_run_dto(&c, id)).collect()
    }

    pub fn insert_usage(&self, u: &Value) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = u["id"].as_str().unwrap_or("");
        let runtime = u["runtimeId"].as_str().unwrap_or("");
        let session = u["sessionId"].as_str().unwrap_or("");
        let turn = u["turnId"].as_str().unwrap_or("");
        let source = u["source"].as_str().unwrap_or("unknown");
        let session_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !session_exists { tx.commit()?; return Ok(()); }
        if source == "fallback" && tx.query_row("SELECT EXISTS(SELECT 1 FROM usage_events WHERE turn_id=?1 AND source='terminal')", [turn], |r| r.get::<_, bool>(0))? {
            tx.commit()?;
            return Ok(());
        }
        if let Some(update_id) = u["providerUpdateId"].as_str() {
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM usage_events WHERE runtime_id=?1 AND provider_update_id=?2)", params![runtime, update_id], |r| r.get::<_, bool>(0))? {
                tx.commit()?;
                return Ok(());
            }
        }
        if source == "terminal" {
            tx.execute("DELETE FROM usage_events WHERE turn_id=?1 AND source IN ('terminal','fallback')", [turn])?;
        } else if source == "fallback" {
            tx.execute("DELETE FROM usage_events WHERE turn_id=?1 AND source='fallback'", [turn])?;
        }
        tx.execute("INSERT OR IGNORE INTO usage_events(id,runtime_id,session_id,turn_id,provider,model,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,reported_cost_minor,reported_currency,source,raw,agent_id,exec_snapshot_id,provider_update_id,usage_status,context_used,context_size,reported_cost_decimal) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,NULL,?13,'{}',(SELECT agent_id FROM sessions WHERE id=?3),(SELECT id FROM exec_snapshots WHERE turn_id=?4),?14,COALESCE(?15,'unreported'),?16,?17,NULL)",params![id,runtime,session,u["turnId"].as_str(),u["provider"].as_str().unwrap_or(""),u["model"].as_str(),u["timestamp"].as_str().unwrap_or(""),u["inputTokens"].as_i64(),u["outputTokens"].as_i64(),u["cacheReadTokens"].as_i64(),u["cacheWriteTokens"].as_i64(),u["reasoningTokens"].as_i64(),source,u["providerUpdateId"].as_str(),u["usageStatus"].as_str(),u["contextUsed"].as_i64(),u["contextSize"].as_i64()])?;
        tx.commit()?;
        Ok(())
    }
    #[cfg(test)]
    pub fn reserve_budget(
        &self,
        policy_id: &str,
        turn_id: &str,
        amount: i64,
        limit: i64,
    ) -> Result<bool, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let start = period_start(&Utc::now(), "day");
        let used:i64=tx.query_row("SELECT COALESCE(SUM(CASE WHEN status='active' THEN amount WHEN status='reconciled' THEN COALESCE(reconciled_amount,amount) ELSE 0 END),0) FROM budget_reservations WHERE policy_id=?1 AND created_at>=?2",params![policy_id,start],|r|r.get(0))?;
        if amount < 0 || used.saturating_add(amount) > limit {
            tx.rollback()?;
            return Ok(false);
        }
        tx.execute("INSERT INTO budget_reservations(id,policy_id,turn_id,amount,status,created_at) VALUES(?1,?2,?3,?4,'active',?5)",params![Uuid::new_v4().to_string(),policy_id,turn_id,amount,Utc::now().to_rfc3339()])?;
        tx.commit()?;
        Ok(true)
    }
    #[cfg(test)]
    pub fn reserve_applicable_budgets(
        &self,
        turn_id: &str,
        session_id: &str,
        runtime_id: &str,
        provider: &str,
        project_path: &str,
        amount: i64,
    ) -> Result<bool, StorageError> {
        self.reserve_applicable_budgets_with_demands(
            turn_id,
            session_id,
            runtime_id,
            provider,
            project_path,
            &json!({"tokens": amount, "input_tokens": amount, "turns": 1, "runtime_minutes": 1}),
        )
    }
    /// Atomically reserve each applicable policy against its own metric. A
    /// missing or null demand means that the policy cannot be evaluated safely
    /// and blocks admission; unknown usage is never treated as zero.
    #[cfg(test)]
    pub fn reserve_applicable_budgets_with_demands(
        &self,
        turn_id: &str,
        session_id: &str,
        runtime_id: &str,
        provider: &str,
        project_path: &str,
        demands: &Value,
    ) -> Result<bool, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let session_agent: Option<String> = tx.query_row("SELECT agent_id FROM sessions WHERE id=?1", [session_id], |r| r.get(0)).optional()?.flatten();
        let policies = {
            let mut q = tx.prepare("SELECT id,scope_type,scope_id,period,metric,hard_limit,enabled,currency FROM budget_policies")?;
            let rows = q.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, bool>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let now = Utc::now();
        let mut reservations = Vec::new();
        for (id, scope, scope_id, period, metric, limit, enabled, currency) in policies {
            if !enabled {
                continue;
            }
            let applicable = match scope.as_str() {
                "global" => true,
                "host" => scope_id
                    .as_deref()
                    .is_none_or(|s| s == "host_windows_local"),
                "runtime" => scope_id.as_deref().is_none_or(|s| s == runtime_id),
                "agent" => scope_id.as_deref().is_none_or(|s| s == provider),
                "blob" => session_agent.as_deref().is_some_and(|agent| scope_id.as_deref() == Some(agent)),
                "session" => scope_id.as_deref().is_none_or(|s| s == session_id),
                "project" => scope_id.as_deref().is_none_or(|s| s == project_path),
                _ => false,
            };
            if !applicable {
                continue;
            }
            if !matches!(
                metric.as_str(),
                "tokens"
                    | "input_tokens"
                    | "cost_minor"
                    | "estimated_cost_minor"
                    | "actual_cost_minor"
                    | "runtime_minutes"
                    | "turns"
                    | "concurrent_sessions"
            ) {
                tx.rollback()?;
                return Ok(false);
            }
            let start = period_start(&now, &period);
            let blob_scope_id = if scope == "blob" { scope_id.as_deref() } else { None };
            let used: i64 = if period == "turn" {
                tx.query_row("SELECT COALESCE(SUM(CASE WHEN br.status='active' THEN br.amount WHEN br.status='reconciled' THEN COALESCE(br.reconciled_amount,br.amount) ELSE 0 END),0) FROM budget_reservations br WHERE br.policy_id=?1 AND br.turn_id=?2 AND (?3 IS NULL OR EXISTS (SELECT 1 FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=br.turn_id AND s.agent_id=?3))", params![id, turn_id, blob_scope_id], |r| r.get(0))?
            } else {
                tx.query_row("SELECT COALESCE(SUM(CASE WHEN br.status='active' THEN br.amount WHEN br.status='reconciled' THEN COALESCE(br.reconciled_amount,br.amount) ELSE 0 END),0) FROM budget_reservations br WHERE br.policy_id=?1 AND br.created_at>=?2 AND (?3 IS NULL OR EXISTS (SELECT 1 FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=br.turn_id AND s.agent_id=?3))", params![id, start, blob_scope_id], |r| r.get(0))?
            };
            let Some(requested) = demands[&metric].as_i64() else {
                tx.rollback()?;
                return Ok(false);
            };
            if requested < 0 || used >= limit || used.saturating_add(requested) > limit {
                tx.rollback()?;
                return Ok(false);
            }
            reservations.push((id, requested, currency, metric));
        }
        for (policy_id, reservation, _currency, metric) in reservations {
            tx.execute("INSERT INTO budget_reservations(id,policy_id,turn_id,amount,status,created_at,metric) VALUES(?1,?2,?3,?4,'active',?5,?6)", params![Uuid::new_v4().to_string(), policy_id, turn_id, reservation, now.to_rfc3339_opts(SecondsFormat::Millis, true), metric])?;
        }
        tx.commit()?;
        Ok(true)
    }
    #[cfg(test)]
    pub fn reconcile_budget_turn(&self, turn_id: &str, actual: i64) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE budget_reservations SET status='reconciled',reconciled_amount=?2 WHERE turn_id=?1 AND status='active'", params![turn_id, actual.max(0)])?;
        Ok(())
    }
    #[cfg(test)]
    pub fn reconcile_budget_turn_metrics(
        &self,
        turn_id: &str,
        actual_by_metric: &Value,
    ) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let active = {
            let mut q = c.prepare("SELECT id,metric,amount FROM budget_reservations WHERE turn_id=?1 AND status='active'")?;
            let rows = q.query_map([turn_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?)))?;
            rows.collect::<Result<Vec<_>,_>>()?
        };
        for (id, metric, reserved) in active {
            let actual = actual_by_metric[&metric].as_i64().unwrap_or(reserved).max(0);
            c.execute("UPDATE budget_reservations SET status='reconciled',reconciled_amount=?2 WHERE id=?1 AND status='active'", params![id, actual])?;
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn release_budget_turn(&self, turn_id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "UPDATE budget_reservations SET status='released' WHERE turn_id=?1 AND status='active'",
            [turn_id],
        )?;
        Ok(())
    }
    #[cfg(test)]
    pub fn budget_usage(&self, policy_id: &str, period: &str) -> Result<(i64, i64), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let start=period_start(&Utc::now(),period);
        c.query_row("SELECT COALESCE(SUM(CASE WHEN status='active' THEN amount ELSE 0 END),0),COALESCE(SUM(CASE WHEN status='reconciled' THEN COALESCE(reconciled_amount,amount) ELSE 0 END),0) FROM budget_reservations WHERE policy_id=?1 AND (?2='turn' OR created_at>=?3)",params![policy_id,period,start],|r|Ok((r.get(0)?,r.get(1)?))).map_err(StorageError::from)
    }
    pub fn latest_turn_tokens(&self, turn_id: &str) -> Result<Option<i64>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        // Four nullable usage counters read from one row; a named type would not add meaning.
        #[allow(clippy::type_complexity)]
        let row: Option<(Option<i64>, Option<i64>, Option<i64>, Option<i64>)> = c.query_row(
            "SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_events WHERE turn_id=?1 ORDER BY rowid DESC LIMIT 1",
            [turn_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional()?;
        Ok(row.and_then(|(input, output, read, write)| {
            input.zip(output).map(|(input, output)| {
                input
                    .saturating_add(output)
                    .saturating_add(read.unwrap_or(0))
                    .saturating_add(write.unwrap_or(0))
            })
        }))
    }
    #[cfg(test)]
    pub fn latest_turn_budget_metrics(&self, turn_id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row: Option<(Option<i64>, Option<i64>)> = c.query_row(
            "SELECT input_tokens,output_tokens FROM usage_events WHERE turn_id=?1 ORDER BY rowid DESC LIMIT 1",
            [turn_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let mut metrics = json!({"turns":1,"runtime_minutes":1});
        if let Some((Some(input), Some(output))) = row {
            metrics["input_tokens"] = json!(input.max(0));
            metrics["tokens"] = json!(input.saturating_add(output).max(0));
        }
        Ok(metrics)
    }
    pub fn create_turn(&self, id: &str, session: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(()); }
        c.execute(
            "INSERT INTO turns(id,session_id,state,created_at,started_at) VALUES(?1,?2,'working',?3,?3)",
            params![id, session, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
    pub fn turn_started_at(&self, id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COALESCE(started_at,created_at) FROM turns WHERE id=?1", [id], |row| row.get(0)).optional()?)
    }
    pub fn clear_session_provider_id(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [id], |r| r.get(0))?;
        if !exists { return Ok(()); }
        c.execute(
            "UPDATE sessions SET provider_session_id=NULL,resumable=0,updated_at=?2 WHERE id=?1",
            params![id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
    #[cfg(test)]
    pub fn record_budget_stopped_turn(&self, id: &str, session: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(()); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        c.execute(
            "INSERT INTO turns(id,session_id,state,created_at,started_at,completed_at,failure_class) VALUES(?1,?2,'error',?3,?3,?3,'budget_stop')",
            params![id, session, now],
        )?;
        Ok(())
    }
    pub fn create_reserved_turn(&self, id: &str, session: &str) -> Result<bool, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let agent: Option<String> = tx.query_row("SELECT agent_id FROM sessions WHERE id=?1", [session], |r| r.get(0))?;
        let active: i64 = tx.query_row("SELECT count(*) FROM active_turn_reservations", [], |r| r.get(0))?;
        if active >= 4 { return Ok(false); }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM active_turn_reservations WHERE session_id=?1)", [session], |r| r.get::<_, bool>(0))? { return Ok(false); }
        if let Some(agent_id) = agent.as_deref() {
            let configured: i64 = tx.query_row("SELECT max_concurrency FROM agents WHERE id=?1", [agent_id], |r| r.get(0))?;
            let count: i64 = tx.query_row("SELECT count(*) FROM active_turn_reservations WHERE agent_id=?1", [agent_id], |r| r.get(0))?;
            if count >= configured.clamp(1, 4) { return Ok(false); }
        }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        tx.execute("INSERT INTO turns(id,session_id,state,created_at,started_at) VALUES(?1,?2,'working',?3,?3)", params![id, session, now])?;
        tx.execute("INSERT INTO active_turn_reservations(turn_id,session_id,agent_id,created_at) VALUES(?1,?2,?3,?4)", params![id, session, agent, now])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn active_turn_reservation_count(&self) -> Result<u64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT count(*) FROM active_turn_reservations", [], |r| r.get::<_, i64>(0))?.max(0) as u64)
    }
    pub fn update_session_state(&self, id: &str, state: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let previous: Option<String> = c.query_row("SELECT updated_at FROM sessions WHERE id=?1", [id], |r| r.get(0)).optional()?;
        let Some(previous) = previous else { return Ok(()); };
        let now = Utc::now();
        let previous_millis = DateTime::parse_from_rfc3339(&previous).ok().map(|value| value.timestamp_millis());
        let updated_millis = previous_millis.map_or(now.timestamp_millis(), |previous| now.timestamp_millis().max(previous.saturating_add(1)));
        let updated_at = Utc.timestamp_millis_opt(updated_millis).single().unwrap_or(now).to_rfc3339_opts(SecondsFormat::Millis, true);
        c.execute(
            "UPDATE sessions SET state=?2,updated_at=?3 WHERE id=?1",
            params![id, state, updated_at],
        )?;
        Ok(())
    }
    /// Convert volatile running state left by an unclean daemon exit into a
    /// resumable offline session. Partial messages and native IDs are retained.
    /// Historical budget rows remain untouched during session recovery.
    pub fn recover_after_restart(&self) -> Result<Vec<String>, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now().to_rfc3339();
        let ids = {
            let mut q = tx.prepare("SELECT id FROM sessions WHERE state IN ('starting','working','waiting_permission','cancelling') ORDER BY id")?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        tx.execute("UPDATE turns SET state='error',started_at=COALESCE(started_at,created_at),completed_at=?1,failure_class='other' WHERE state IN ('starting','working','waiting_permission','cancelling')", [&now])?;
        tx.execute("DELETE FROM active_turn_reservations WHERE turn_id IN (SELECT id FROM turns WHERE state IN ('error','cancelled','completed'))", [])?;
        tx.execute("UPDATE sessions SET state='offline',updated_at=?1 WHERE state IN ('starting','working','waiting_permission','cancelling')", [&now])?;
        tx.execute("UPDATE permission_requests SET status='expired',data=json_set(data,'$.status','expired','$.resolution','daemon_restarted') WHERE status IN ('pending','resolving')", [])?;
        tx.execute("UPDATE queued_prompts SET status='failed',error='Interrupted by a restart. Check the conversation before sending again.',updated_at=?1 WHERE status='sending'", [&now])?;
        tx.commit()?;
        Ok(ids)
    }
    pub fn append_message(
        &self,
        session: &str,
        turn: &str,
        role: &str,
        content: &str,
    ) -> Result<Value, StorageError> {
        self.append_message_with_data(session, turn, role, content, &json!({}))
    }
    /// `data` holds structured message metadata such as attachment names.
    pub fn append_message_with_data(
        &self,
        session: &str,
        turn: &str,
        role: &str,
        content: &str,
        data: &Value,
    ) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(Value::Null); }
        let sequence: i64 = c.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        c.execute("INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at,data) VALUES(?1,?2,NULLIF(?3,''),?4,?5,?6,?7,?8)",params![id,session,turn,sequence,role,content,now,data.to_string()])?;
        let mut message = json!({"id":id,"sessionId":session,"turnId":turn,"sequence":sequence,"role":role,"content":content,"createdAt":now});
        if let Some(attachments) = data.get("attachments") { message["attachments"] = attachments.clone(); }
        if let Some(meta) = data.get("meta") { message["meta"] = meta.clone(); }
        if let Some(references) = data.get("references") { message["references"] = references.clone(); }
        Ok(message)
    }
    /// Appends a notice that must read ABOVE the assistant text its turn has
    /// already produced, such as "Messaged X": the call is what the turn did, the
    /// text after it is what the assistant says about it. The notice takes the
    /// position of the turn's first assistant row and that turn's assistant rows
    /// move below it, in their original order. Returns the notice and the id of
    /// the row it now sits above (None when the turn has no assistant text yet,
    /// in which case this is an ordinary append).
    pub fn append_notice_above_turn_text(
        &self,
        session: &str,
        turn: &str,
        content: &str,
        data: &Value,
    ) -> Result<(Value, Option<String>), StorageError> {
        let rows: Vec<(String, i64)> = {
            let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
            if turn.is_empty() { Vec::new() } else {
                let mut q = c.prepare("SELECT id,sequence FROM messages WHERE session_id=?1 AND role='assistant' AND turn_id=?2 ORDER BY sequence")?;
                let collected = q.query_map(params![session, turn], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
                collected
            }
        };
        let Some((first_id, first_sequence)) = rows.first().cloned() else {
            return Ok((self.append_message_with_data(session, "", "notice", content, data)?, None));
        };
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction()?;
        let base: i64 = tx.query_row("SELECT COALESCE(MAX(sequence),0) FROM messages WHERE session_id=?1", [session], |r| r.get(0))?;
        for (offset, (id, _)) in rows.iter().enumerate() {
            tx.execute("UPDATE messages SET sequence=?2 WHERE id=?1", params![id, base + 1 + offset as i64])?;
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at,data) VALUES(?1,?2,NULL,?3,'notice',?4,?5,?6)",
            params![id, session, first_sequence, content, now, data.to_string()],
        )?;
        tx.commit()?;
        let mut message = json!({"id":id,"sessionId":session,"turnId":"","sequence":first_sequence,"role":"notice","content":content,"createdAt":now});
        if let Some(meta) = data.get("meta") { message["meta"] = meta.clone(); }
        Ok((message, Some(first_id)))
    }
    pub fn append_message_delta(
        &self,
        session: &str,
        turn: &str,
        delta: &str,
    ) -> Result<Value, StorageError> {
        self.append_typed_message_delta(session, turn, "assistant", delta)
    }
    pub fn append_typed_message_delta(
        &self,
        session: &str,
        turn: &str,
        role: &str,
        delta: &str,
    ) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(Value::Null); }
        // A delegation notice split the turn: assistant text streamed after it
        // belongs to a new row, not the row that came before the notice. The
        // decision reads persisted notices, so replay keeps the same order.
        let row:Option<(String,String,i64,String)>=c.query_row("SELECT id,content,sequence,created_at FROM messages WHERE session_id=?1 AND role=?2 AND ((?3='' AND turn_id IS NULL) OR turn_id=?3) AND (?2<>'assistant' OR sequence>COALESCE((SELECT MAX(sequence) FROM messages WHERE session_id=?1 AND role='notice' AND json_extract(data,'$.meta.kind')='delegation'),0)) ORDER BY sequence DESC LIMIT 1",params![session,role,turn],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if let Some((id, content, sequence, created_at)) = row {
            let content = format!("{content}{delta}");
            c.execute(
                "UPDATE messages SET content=?2 WHERE id=?1",
                params![id, content],
            )?;
            Ok(
                json!({"id":id,"sessionId":session,"turnId":turn,"sequence":sequence,"role":role,"delta":delta,"content":content,"createdAt":created_at}),
            )
        } else {
            let sequence: i64 = c.query_row(
                "SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE session_id=?1",
                [session],
                |r| r.get(0),
            )?;
            let id = Uuid::new_v4().to_string();
            let created = Utc::now().to_rfc3339();
            c.execute("INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,session,turn,sequence,role,delta,created])?;
            Ok(
                json!({"id":id,"sessionId":session,"turnId":turn,"sequence":sequence,"role":role,"delta":delta,"content":delta,"createdAt":created}),
            )
        }
    }
    /// Returns the normalized content of one writable user or assistant
    /// message, scoped to its owning session.
    pub fn message_reply_source(&self, session: &str, message_id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row: Option<(String, String, String, String)> = c.query_row(
            "SELECT id,role,content,created_at FROM messages WHERE session_id=?1 AND id=?2",
            params![session, message_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional()?;
        let (id, role, content, created_at) = row.ok_or(StorageError::AgentNotFound)?;
        if !matches!(role.as_str(), "user" | "assistant") { return Err(StorageError::InvalidAgent); }
        Ok(json!({"id":id,"sessionId":session,"role":role,"content":content,"createdAt":created_at}))
    }
    /// The last `limit` user and assistant messages of a session, oldest first,
    /// for a hand-off draft. Thinking, notices, plans and tool output are all
    /// excluded, so only conversation text is ever carried over.
    pub fn handoff_messages(&self, session: &str, limit: usize) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let limit = limit.clamp(1, 50) as i64;
        let mut q = c.prepare("SELECT role,content FROM messages WHERE session_id=?1 AND role IN ('user','assistant') AND trim(content)<>'' ORDER BY sequence DESC LIMIT ?2")?;
        let mut rows = q.query_map(params![session, limit], |r| Ok(json!({"role":r.get::<_,String>(0)?,"content":r.get::<_,String>(1)?})))?.collect::<Result<Vec<_>,_>>()?;
        rows.reverse();
        Ok(rows)
    }
    /// Toggles a local user's allowlisted reaction on a message. The message
    /// and session are checked together in the same write transaction.
    pub fn toggle_message_reaction(&self, session: &str, message_id: &str, emoji: &str) -> Result<Value, StorageError> {
        if !USER_REACTIONS.contains(&emoji) { return Err(StorageError::InvalidAgent); }
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let role: Option<String> = tx.query_row(
            "SELECT role FROM messages WHERE session_id=?1 AND id=?2",
            params![session, message_id],
            |r| r.get(0),
        ).optional()?;
        let role = role.ok_or(StorageError::AgentNotFound)?;
        if !matches!(role.as_str(), "user" | "assistant") { return Err(StorageError::InvalidAgent); }
        // At most one reaction per message. Toggling the sole reaction removes
        // it; toggling a different one replaces it. A legacy message that still
        // carries several reactions collapses to the chosen one on this toggle.
        let existing: Vec<String> = {
            let mut statement = tx.prepare("SELECT emoji FROM message_reactions WHERE session_id=?1 AND message_id=?2")?;
            let rows = statement.query_map(params![session,message_id], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            rows
        };
        let selected = !(existing.len() == 1 && existing.first().is_some_and(|current| current == emoji));
        tx.execute("DELETE FROM message_reactions WHERE session_id=?1 AND message_id=?2", params![session,message_id])?;
        if selected {
            tx.execute("INSERT INTO message_reactions(session_id,message_id,emoji,created_at) VALUES(?1,?2,?3,?4)", params![session,message_id,emoji,Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true)])?;
        }
        let reactions = if selected { vec![emoji.to_owned()] } else { Vec::new() };
        let payload = json!({"sessionId":session,"messageId":message_id,"emoji":emoji,"selected":selected,"reactions":reactions});
        let event = push_team_event(&tx, "message.reactions.changed", &payload)?;
        tx.commit()?;
        Ok(event)
    }
    pub fn finalize_latest_assistant(
        &self,
        session: &str,
        turn: &str,
        content: &str,
    ) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(Value::Null); }
        // One turn can own several assistant rows when a delegation notice split
        // it; every row keeps the text streamed into it.
        let rows: Vec<(String, String, i64, String)> = {
            let mut q = c.prepare("SELECT id,content,sequence,created_at FROM messages WHERE session_id=?1 AND role='assistant' AND turn_id=?2 ORDER BY sequence")?;
            let collected = q.query_map(params![session, turn], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<Vec<_>, _>>()?;
            collected
        };
        let Some((last_row, head_rows)) = rows.split_last() else {
            drop(c);
            return self.append_message(session, turn, "assistant", content);
        };
        let (last_id, last_content, last_seq, last_created) = last_row.clone();
        // A delegation notice newer than the newest row means the text produced
        // after the notice was never written: it belongs to a new row.
        let pending_split: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND role='notice' AND json_extract(data,'$.meta.kind')='delegation' AND sequence>?2)", params![session, last_seq], |r| r.get(0))?;
        if pending_split {
            // Strip the text already streamed into the existing rows; what is
            // left is the post-notice text. A final message that does not repeat
            // the earlier text is taken whole.
            let mut remainder = content;
            let mut repeats = true;
            for (_id, row_content, _seq, _created) in &rows {
                match remainder.strip_prefix(row_content.as_str()) {
                    Some(rest) => remainder = rest,
                    None => { repeats = false; break; }
                }
            }
            let new_text = if repeats { remainder } else { content };
            if new_text.is_empty() {
                return Ok(json!({"id":last_id,"sessionId":session,"turnId":turn,"sequence":last_seq,"role":"assistant","content":last_content,"createdAt":last_created}));
            }
            drop(c);
            return self.append_message(session, turn, "assistant", new_text);
        }
        // No pending split: finalize the newest row with the text that belongs to
        // it. When the provider repeats the whole turn, drop the earlier rows'
        // text; when it cannot be partitioned reliably, keep every row as
        // streamed rather than overwrite one with the whole turn.
        let mut head = String::new();
        for (_id, row_content, _seq, _created) in head_rows {
            head.push_str(row_content);
        }
        if let Some(text) = content.strip_prefix(head.as_str()) {
            c.execute("UPDATE messages SET content=?2 WHERE id=?1", params![last_id, text])?;
            Ok(json!({"id":last_id,"sessionId":session,"turnId":turn,"sequence":last_seq,"role":"assistant","content":text,"createdAt":last_created}))
        } else {
            Ok(json!({"id":last_id,"sessionId":session,"turnId":turn,"sequence":last_seq,"role":"assistant","content":last_content,"createdAt":last_created}))
        }
    }
    pub fn update_turn_state(&self, id: &str, state: &str) -> Result<(), StorageError> {
        self.update_turn_outcome(id, state, None)
    }
    pub fn update_turn_outcome(&self, id: &str, state: &str, failure_class: Option<&str>) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "UPDATE turns SET state=?2,completed_at=?3,failure_class=?4,failure_class_v2=?5 WHERE id=?1",
            params![
                id,
                state,
                if state == "working" {
                    None
                } else {
                    Some(Utc::now().to_rfc3339())
                },
                failure_class.filter(|class| matches!(*class, "provider_error" | "permission_denied" | "cancelled" | "timeout" | "budget_stop" | "config_unsupported" | "other")),
                failure_class.filter(|class| *class == "context")
            ],
        )?;
        if matches!(state, "completed" | "error" | "cancelled") {
            c.execute("DELETE FROM active_turn_reservations WHERE turn_id=?1", [id])?;
        }
        Ok(())
    }
    pub fn turn_failure_class(&self, id: &str) -> Result<Option<String>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.query_row("SELECT COALESCE(failure_class_v2,failure_class) FROM turns WHERE id=?1", [id], |row| row.get(0))
            .map_err(StorageError::from)
    }
    /// Merges top-level `fields` into the JSON object stored in `turns.data`,
    /// preserving existing keys and creating the object when it is empty. A
    /// single `json_patch` UPDATE keeps this atomic for the current row.
    pub fn merge_turn_data(&self, id: &str, fields: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let patch = serde_json::to_string(fields)?;
        c.execute(
            "UPDATE turns SET data=json_patch(COALESCE(data,'{}'),?2) WHERE id=?1",
            params![id, patch],
        )?;
        Ok(())
    }
    /// The parsed JSON object stored for a turn, or null when absent.
    pub fn turn_data(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let raw: Option<String> = c.query_row("SELECT data FROM turns WHERE id=?1", [id], |row| row.get(0)).optional()?;
        Ok(raw.and_then(|value| serde_json::from_str::<Value>(&value).ok()).unwrap_or(Value::Null))
    }
    pub fn upsert_tool(
        &self,
        session: &str,
        id: &str,
        kind: &str,
        title: &str,
        state: &str,
        raw: &Value,
    ) -> Result<Value, StorageError> {
        self.upsert_tool_in_turn(session, None, id, kind, title, state, raw)
    }
    /// Records a tool call against its turn, with start/finish times and a
    /// bounded, provider-neutral `detail` (see `tool_detail`). A completion
    /// merges into what the start recorded, so a command keeps its input
    /// once its output arrives.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_tool_in_turn(
        &self,
        session: &str,
        turn: Option<&str>,
        id: &str,
        kind: &str,
        title: &str,
        state: &str,
        raw: &Value,
    ) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let session_exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !session_exists { return Ok(Value::Null); }
        let existing: Option<String> = c
            .query_row("SELECT data FROM tool_calls WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        let existing = existing
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or(Value::Null);
        let kind = if kind == "other" {
            existing["kind"].as_str().unwrap_or(kind)
        } else {
            kind
        };
        let title = if matches!(title, "Tool" | "Activity") {
            existing["title"].as_str().unwrap_or(title)
        } else {
            title
        };
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let started_at = existing["startedAt"].as_str().map(str::to_owned).unwrap_or_else(|| now.clone());
        let mut detail = existing["detail"].as_object().cloned().unwrap_or_default();
        if let Value::Object(mut fresh) = tool_detail(kind, raw) {
            if let Some(delta) = raw["outputDelta"].as_str() {
                let prior = detail.get("output").and_then(Value::as_str).unwrap_or_default();
                fresh.insert("output".into(), json!(clip_text(&format!("{prior}{delta}"), DETAIL_TEXT_LIMIT)));
            }
            detail.extend(fresh);
        }
        let mut v =
            json!({"id":id,"sessionId":session,"kind":kind,"title":title,"state":state,"raw":raw,"startedAt":started_at,"detail":detail});
        if matches!(state, "completed" | "failed" | "error" | "cancelled") { v["completedAt"] = json!(now); }
        c.execute("INSERT INTO tool_calls(id,session_id,turn_id,state,data) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data,turn_id=COALESCE(tool_calls.turn_id,excluded.turn_id)",params![id,session,turn,state,v.to_string()])?;
        Ok(v)
    }
    pub fn insert_file(&self, session: &str, path: &str, raw: &Value) -> Result<(), StorageError> {
        self.insert_file_in_turn(session, None, path, raw)
    }
    /// A file change, with its turn, time and a bounded detail (path, change kind, diff excerpt).
    pub fn insert_file_in_turn(&self, session: &str, turn: Option<&str>, path: &str, raw: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(()); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let data = json!({"raw":raw,"createdAt":now,"detail":file_detail(path, raw)});
        c.execute(
            "INSERT INTO file_changes(id,session_id,turn_id,path,data) VALUES(?1,?2,?3,?4,?5)",
            params![Uuid::new_v4().to_string(), session, turn, path, data.to_string()],
        )?;
        Ok(())
    }
    // Permission rows mirror the persisted columns; a struct would only relocate the fields.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_permission(
        &self,
        id: &str,
        session: &str,
        provider_id: &str,
        title: &str,
        detail: Option<&str>,
        choices: &[String],
        raw: &Value,
    ) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(()); }
        let data = json!({"id":id,"sessionId":session,"title":title,"detail":detail,"choices":choices,"status":"pending","raw":raw});
        c.execute("INSERT INTO permission_requests(id,session_id,provider_request_id,status,data) VALUES(?1,?2,?3,'pending',?4)",params![id,session,provider_id,data.to_string()])?;
        Ok(())
    }
    pub fn begin_permission_reply(
        &self,
        id: &str,
        choice: &str,
    ) -> Result<Option<(String, String)>, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let found:Option<(String,Option<String>,String,Option<String>)>=tx.query_row("SELECT session_id,provider_request_id,data,expires_at FROM permission_requests WHERE id=?1 AND status='pending'",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((session, provider, data, expires_at)) = found else {
            tx.rollback()?;
            return Ok(None);
        };
        // An expired card can no longer be answered: leave it pending; the
        // periodic sweep marks it expired.
        if expires_at.as_deref().is_some_and(|expiry| expiry <= Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true).as_str()) {
            tx.rollback()?;
            return Ok(None);
        }
        let mut data: Value = serde_json::from_str(&data)?;
        let choices = data["choices"].as_array().cloned().unwrap_or_default();
        if !choices.iter().any(|x| x.as_str() == Some(choice)) {
            tx.rollback()?;
            return Ok(None);
        }
        let n = tx.execute(
            "UPDATE permission_requests SET status='resolving' WHERE id=?1 AND status='pending'",
            [id],
        )?;
        if n != 1 {
            tx.rollback()?;
            return Ok(None);
        }
        data["status"] = json!("resolving");
        data["choice"] = json!(choice);
        tx.execute(
            "UPDATE permission_requests SET data=?2 WHERE id=?1",
            params![id, data.to_string()],
        )?;
        tx.commit()?;
        Ok(provider.map(|provider| (session, provider)))
    }
    pub fn finish_permission_reply(&self, id: &str, ok: bool) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let status = if ok { "resolved" } else { "pending" };
        c.execute(
            "UPDATE permission_requests SET status=?2 WHERE id=?1 AND status='resolving'",
            params![id, status],
        )?;
        Ok(())
    }
    pub fn resolve_permission_policy(&self,id:&str,resolved_by:&str,choice:&str)->Result<(),StorageError>{
        if !["policy:auto","policy:bypass","policy:automation"].contains(&resolved_by){return Err(StorageError::InvalidAgent)}
        let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;
        let changed=c.execute("UPDATE permission_requests SET status='resolved',resolved_by=?2,data=json_set(data,'$.status','resolved','$.choice',?3,'$.resolvedBy',?2) WHERE id=?1 AND status='resolving'",params![id,resolved_by,choice])?;
        if changed!=1{return Err(StorageError::AgentConflict)} Ok(())
    }
    pub fn finish_permission_policy_reply(&self,id:&str,ok:bool,resolved_by:&str,choice:&str)->Result<(),StorageError>{
        if ok {self.resolve_permission_policy(id,resolved_by,choice)} else {self.finish_permission_reply(id,false)}
    }
    pub fn permission_resolved_by(&self,id:&str)->Result<Option<String>,StorageError>{let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;Ok(c.query_row("SELECT resolved_by FROM permission_requests WHERE id=?1",[id],|r|r.get(0)).optional()?.flatten())}
    pub fn default_approval_mode(&self)->Result<String,StorageError>{
        let c=self.conn.lock().map_err(|_|StorageError::Poisoned)?;
        let raw:String=c.query_row("SELECT value FROM settings WHERE key='permissions.default_mode'",[],|r|r.get(0)).optional()?.unwrap_or("\"ask\"".into());
        let mode:String=serde_json::from_str(&raw)?; if !["ask","auto"].contains(&mode.as_str()){return Err(StorageError::InvalidAgent)} Ok(mode)
    }
    pub fn session_detail(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        self.session_detail_locked(&c, id)
    }
    pub fn session_context(&self, id: &str) -> Result<(Option<u64>, Option<u64>), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let (used, size, _, _) = session_context_locked(&c, id)?;
        Ok((used.and_then(|value| u64::try_from(value).ok()), size.and_then(|value| u64::try_from(value).ok())))
    }
    // Context counters plus the model label and estimated flag; a named type would not add meaning.
    #[allow(clippy::type_complexity)]
    pub fn session_context_state(&self, id: &str) -> Result<(Option<u64>, Option<u64>, Option<String>, bool), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let (used, size, model, estimated) = session_context_locked(&c, id)?;
        Ok((used.and_then(|value| u64::try_from(value).ok()), size.and_then(|value| u64::try_from(value).ok()), model, estimated))
    }
    #[cfg(test)]
    pub fn budget_list(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(json!({"policies":self.budget_list_locked(&c)?}))
    }
    #[cfg(test)]
    pub fn save_budget(&self, p: &Value) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let scope = p["scopeType"].as_str().unwrap_or("global");
        let scope_id = p["scopeId"].as_str();
        if scope == "blob" {
            let Some(agent_id) = scope_id else { return Err(StorageError::InvalidBudget); };
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND archived=0)", [agent_id], |r| r.get(0))?;
            if !exists { return Err(StorageError::InvalidBudget); }
        }
        let metric = p["metric"].as_str().unwrap_or("tokens");
        let id = p["id"].as_str().unwrap_or_else(||p["policyId"].as_str().unwrap_or("")).trim();
        if id.is_empty() { return Err(StorageError::InvalidBudget); }
        if !matches!(
            metric,
            "tokens"
                | "input_tokens"
                | "cost_minor"
                | "estimated_cost_minor"
                | "actual_cost_minor"
                | "runtime_minutes"
                | "turns"
                | "concurrent_sessions"
        ) || p["hardLimit"].as_i64().unwrap_or(0) <= 0
        {
            return Err(StorageError::InvalidBudget);
        }
        let period = p["period"].as_str().unwrap_or("day");
        let prior: Option<(String,Option<String>,String,String)> = tx.query_row("SELECT scope_type,scope_id,period,metric FROM budget_policies WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if prior.is_some_and(|(old_scope,old_id,old_period,old_metric)| old_scope != scope || old_id.as_deref() != scope_id || old_period != period || old_metric != metric) {
            tx.execute("DELETE FROM budget_reservations WHERE policy_id=?1", [id])?;
        }
        tx.execute("INSERT INTO budget_policies(id,scope_type,scope_id,period,metric,hard_limit,warning_json,created_at,enabled,currency) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET scope_type=excluded.scope_type,scope_id=excluded.scope_id,period=excluded.period,metric=excluded.metric,hard_limit=excluded.hard_limit,warning_json=excluded.warning_json,enabled=excluded.enabled,currency=excluded.currency",params![id,scope,scope_id,period,metric,p["hardLimit"].as_i64().unwrap_or(0),p["warningThresholds"].to_string(),Utc::now().to_rfc3339(),p["enabled"].as_bool().unwrap_or(true),p["currency"].as_str().unwrap_or("USD")])?;
        tx.commit()?;
        Ok(())
    }
    #[cfg(test)]
    pub fn delete_budget(&self, id: &str) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM budget_reservations WHERE policy_id=?1", [id])?;
        tx.execute("DELETE FROM budget_policies WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare("SELECT key,value FROM settings")?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = serde_json::Map::new();
        for (k, v) in rows {
            out.insert(k, serde_json::from_str(&v)?);
        }
        Ok(Value::Object(out))
    }
    pub fn set_setting(&self, k: &str, v: &Value) -> Result<Vec<Value>, StorageError> {
        validate_setting_value(k, v)?;
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let events = write_setting(&tx, k, v)?;
        tx.commit()?;Ok(events)
    }
    // ── Remote mode (FIX29 WP6b): paired devices and the activity log ──────
    /// Insert one paired device. `device` carries the DTO fields; the token
    /// itself is never passed here, only its SHA-256 hex digest.
    pub fn remote_device_create(&self, device: &Value, token_sha256: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "INSERT INTO remote_devices(id,name,kind,platform,tier,login,token_sha256,paired_at,last_seen_at,revoked_at,signed_out_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,NULL,NULL)",
            params![
                device["id"].as_str().unwrap_or(""),
                device["name"].as_str().unwrap_or(""),
                device["kind"].as_str().unwrap_or("browser"),
                device["platform"].as_str().unwrap_or(""),
                device["tier"].as_str().unwrap_or("viewer"),
                device["login"].as_str(),
                token_sha256,
                device["pairedAt"].as_str().unwrap_or(""),
            ],
        )?;
        Ok(())
    }
    /// The device whose cookie hashes to `token_sha256`, revoked or not, with
    /// the stored digest so the caller can confirm it in constant time.
    pub fn remote_device_by_token_hash(&self, token_sha256: &str) -> Result<Option<(Value, String)>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.query_row(
            &format!("SELECT {REMOTE_DEVICE_COLUMNS},token_sha256 FROM remote_devices WHERE token_sha256=?1"),
            [token_sha256],
            |row| Ok((remote_device_dto_from_row(row)?, row.get::<_, String>(10)?)),
        )
        .optional()
        .map_err(StorageError::from)
    }
    /// Every device row, newest pairing first. Includes revoked rows: the
    /// caller decides whether to hide them; the token hash is never returned.
    pub fn remote_devices(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut q = c.prepare(&format!("SELECT {REMOTE_DEVICE_COLUMNS} FROM remote_devices ORDER BY paired_at DESC,id"))?;
        let rows = q.query_map([], remote_device_dto_from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn remote_device_get(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.query_row(
            &format!("SELECT {REMOTE_DEVICE_COLUMNS} FROM remote_devices WHERE id=?1"),
            [id],
            remote_device_dto_from_row,
        )
        .optional()
        .map_err(StorageError::from)
    }
    /// Renames a device or changes its tier; omitted fields are left alone.
    /// Returns `None` when no such device exists.
    pub fn remote_device_update(&self, id: &str, name: Option<&str>, tier: Option<&str>) -> Result<Option<Value>, StorageError> {
        if let Some(tier) = tier {
            if !matches!(tier, "viewer" | "chat" | "operator") { return Err(StorageError::InvalidAgent); }
        }
        let name = match name {
            Some(name) => {
                let trimmed = name.trim();
                if trimmed.is_empty() || trimmed.chars().count() > 80 { return Err(StorageError::InvalidAgent); }
                Some(trimmed.to_owned())
            }
            None => None,
        };
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM remote_devices WHERE id=?1)", [id], |r| r.get(0))?;
        if !exists { return Ok(None); }
        if let Some(name) = name { c.execute("UPDATE remote_devices SET name=?2 WHERE id=?1", params![id, name])?; }
        if let Some(tier) = tier { c.execute("UPDATE remote_devices SET tier=?2 WHERE id=?1", params![id, tier])?; }
        c.query_row(
            &format!("SELECT {REMOTE_DEVICE_COLUMNS} FROM remote_devices WHERE id=?1"),
            [id],
            remote_device_dto_from_row,
        )
        .optional()
        .map_err(StorageError::from)
    }
    /// Marks a device revoked. Its token hash is kept only so later requests
    /// are answered `device_revoked`; it can never authorise again.
    pub fn remote_device_revoke(&self, id: &str, at: &str) -> Result<bool, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = c.execute("UPDATE remote_devices SET revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL", params![id, at])?;
        Ok(changed > 0)
    }
    /// Marks a device signed out. The token hash is kept only so the stale
    /// cookie is answered `device_revoked` (PROTOCOL §11); it can never
    /// authorise again because the gateway refuses any signed-out row.
    pub fn remote_device_sign_out(&self, id: &str, at: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE remote_devices SET signed_out_at=?2 WHERE id=?1", params![id, at])?;
        Ok(())
    }
    pub fn remote_device_touch(&self, id: &str, at: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE remote_devices SET last_seen_at=?2 WHERE id=?1", params![id, at])?;
        Ok(())
    }
    /// Append one content-free activity row and trim the table to its cap.
    pub fn remote_activity_push(&self, at: &str, device_id: Option<&str>, kind: &str, summary: &str) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO remote_activity(at,device_id,kind,summary) VALUES(?1,?2,?3,?4)",
            params![at, device_id, kind, summary],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            &format!("DELETE FROM remote_activity WHERE id NOT IN (SELECT id FROM remote_activity ORDER BY id DESC LIMIT {REMOTE_ACTIVITY_LIMIT})"),
            [],
        )?;
        let device_name: Option<String> = match device_id {
            Some(device_id) => tx.query_row("SELECT name FROM remote_devices WHERE id=?1", [device_id], |r| r.get::<_, String>(0)).optional()?,
            None => None,
        };
        tx.commit()?;
        Ok(json!({
            "id": id.to_string(),
            "at": at,
            "deviceId": device_id,
            "deviceName": device_name.unwrap_or_default(),
            "kind": kind,
            "summary": summary,
        }))
    }
    pub fn remote_activity_list(&self, limit: usize) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let limit = limit.clamp(1, REMOTE_ACTIVITY_LIMIT) as i64;
        let mut q = c.prepare(
            "SELECT a.id,a.at,a.device_id,d.name,a.kind,a.summary FROM remote_activity a LEFT JOIN remote_devices d ON d.id=a.device_id ORDER BY a.id DESC LIMIT ?1",
        )?;
        let rows = q.query_map([limit], remote_activity_dto_from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn remote_activity_count(&self) -> Result<i64, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(c.query_row("SELECT COUNT(*) FROM remote_activity", [], |r| r.get(0))?)
    }
    pub fn profiles(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(
            json!({"profiles":query_column_json(&c,"SELECT data FROM runtime_profiles ORDER BY name","")?}),
        )
    }
    pub fn save_profile(&self, p: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("INSERT INTO runtime_profiles(id,name,provider,protocol,executable,args,host_id,working_directory_policy,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,protocol=excluded.protocol,executable=excluded.executable,args=excluded.args,data=excluded.data",params![p["id"].as_str().unwrap_or(""),p["name"].as_str().unwrap_or("Custom"),p["provider"].as_str().unwrap_or(""),p["protocolFamily"].as_str().unwrap_or(""),p["executablePath"].as_str().unwrap_or(""),p["args"].to_string(),p["hostId"].as_str().unwrap_or("host_windows_local"),p["workingDirectoryPolicy"].as_str().unwrap_or("per_session"),p.to_string()])?;
        Ok(())
    }
    pub fn delete_profile(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("DELETE FROM runtime_profiles WHERE id=?1", [id])?;
        Ok(())
    }
    #[cfg(test)]
    pub fn pricing_list(&self, provider: Option<&str>) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let override_sql = if provider.is_some() {
            "SELECT data FROM user_pricing_rules WHERE provider=?1 ORDER BY model"
        } else {
            "SELECT data FROM user_pricing_rules ORDER BY provider,model"
        };
        let mut override_query = c.prepare(override_sql)?;
        let overrides = match provider {
            Some(provider) => override_query
                .query_map([provider], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
            None => override_query
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        };
        let mut rules = Vec::with_capacity(overrides.len());
        for data in overrides {
            if let Ok(mut rule) = serde_json::from_str::<Value>(&data) {
                if let Some(object) = rule.as_object_mut() {
                    object.insert("source".to_string(), json!("user_override"));
                }
                rules.push(rule);
            }
        }
        Ok(json!({"rules":rules}))
    }
    #[cfg(test)]
    pub fn save_pricing(&self, p: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if p["remove"].as_bool() == Some(true) {
            let id = p["id"].as_str().unwrap_or("");
            if id.trim().is_empty() { return Err(StorageError::InvalidPricing); }
            c.execute("DELETE FROM user_pricing_rules WHERE id=?1", [id])?;
            return Ok(());
        }
        c.execute(
            "INSERT INTO user_pricing_rules(id,provider,model,aliases,input_rate,output_rate,cache_read_rate,cache_write_rate,currency,effective_from,effective_to,source_url,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,aliases=excluded.aliases,input_rate=excluded.input_rate,output_rate=excluded.output_rate,cache_read_rate=excluded.cache_read_rate,cache_write_rate=excluded.cache_write_rate,currency=excluded.currency,effective_from=excluded.effective_from,effective_to=excluded.effective_to,source_url=excluded.source_url,data=excluded.data",
            params![
                p["id"].as_str().unwrap_or(""),
                p["provider"].as_str().unwrap_or(""),
                p["canonicalModelId"].as_str().unwrap_or(""),
                p["aliases"].to_string(),
                p["inputPerMillion"].as_str(),
                p["outputPerMillion"].as_str(),
                p["cacheReadPerMillion"].as_str(),
                p["cacheWritePerMillion"].as_str(),
                p["currency"].as_str().unwrap_or("USD"),
                p["effectiveFrom"].as_str().unwrap_or(""),
                p["effectiveTo"].as_str(),
                p["sourceUrl"].as_str(),
                p.to_string()
            ],
        )?;
        Ok(())
    }
    #[cfg(test)]
    pub fn subscriptions(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        self.subscriptions_locked(&c)
    }
    #[cfg(test)]
    fn subscriptions_locked(&self, c: &Connection) -> Result<Value, StorageError> {
        let rows = query_column_json(
            c,
            "SELECT data FROM subscription_plans ORDER BY provider",
            "",
        )?;
        Ok(json!({"plans":rows}))
    }
    #[cfg(test)]
    pub fn save_subscription(&self, p: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("INSERT INTO subscription_plans(id,provider,currency,monthly_minor,renewal_day,quota_state,data) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET data=excluded.data,monthly_minor=excluded.monthly_minor,currency=excluded.currency,renewal_day=excluded.renewal_day,quota_state=excluded.quota_state",params![p["id"].as_str().unwrap_or(""),p["provider"].as_str().unwrap_or(""),p["currency"].as_str().unwrap_or("GBP"),p["monthlyMinor"].as_i64(),p["renewalDay"].as_i64(),p["quotaState"].as_str().unwrap_or("unknown"),p.to_string()])?;
        Ok(())
    }
    pub fn usage_summary(&self, p: &Value) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let from = p["from"].as_str().unwrap_or("0000");
        let to = p["to"].as_str().unwrap_or("9999");
        self.usage_summary_locked(&c, from, to)
    }
    fn usage_summary_locked(
        &self,
        c: &Connection,
        from: &str,
        to: &str,
    ) -> Result<Value, StorageError> {
        // Five nullable usage sums read from one row; a named type would not add meaning.
        #[allow(clippy::type_complexity)]
        let (i,o,cr,cw,r):(Option<i64>,Option<i64>,Option<i64>,Option<i64>,Option<i64>)=c.query_row("SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_read_tokens),SUM(cache_write_tokens),SUM(reasoning_tokens) FROM usage_events WHERE timestamp>=?1 AND timestamp<=?2",params![from,to],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
        Ok(json!({"from":from,"to":to,"inputTokens":i,"outputTokens":o,"cacheReadTokens":cr,"cacheWriteTokens":cw,"reasoningTokens":r}))
    }
    pub fn snapshot(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx=c.unchecked_transaction()?;
        let c=&tx;
        let seq: u64 = c.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM app_events",
            [],
            |r| r.get(0),
        )?;
        let runtimes = {
            let mut s = c.prepare("SELECT data FROM runtimes")?;
            let collected = s
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            collected
                .into_iter()
                .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
                .collect::<Vec<_>>()
        };
        let sessions = {
            let mut q = c.prepare("SELECT id FROM sessions WHERE archived=0 ORDER BY updated_at DESC")?;
            let collected = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            collected
        };
        let mut session_values = Vec::new();
        for id in sessions {
            session_values.push(self.session_detail_locked(c, &id)?)
        }
        let permissions = query_jsons(
            c,
            "SELECT json_object('id',p.id,'sessionId',p.session_id,'runtimeId',s.runtime_id,'title',json_extract(p.data,'$.title'),'detail',json_extract(p.data,'$.detail'),'choices',json_extract(p.data,'$.choices'),'kind',json_extract(p.data,'$.kind'),'questions',json_extract(p.data,'$.questions'),'status',p.status,'expiresAt',p.expires_at) FROM permission_requests p JOIN sessions s ON s.id=p.session_id WHERE p.status='pending' AND s.archived=0 ORDER BY p.rowid",
            "",
        )?;
        let usage = self.usage_rows_locked(c)?;
        let settings = self.settings_locked(c)?;
        let agents=self.agent_rows_locked(c,true)?;
        let projects=project_rows(c)?;
        let result=json!({"projects":projects,"snapshotVersion":1,"sequence":seq,"daemon":{"state":"ready"},"hosts":[{"id":"host_windows_local","name":std::env::var("COMPUTERNAME").unwrap_or_else(|_|"Windows Local".into()),"kind":"windows","status":"online"}],"runtimes":runtimes,"sessions":session_values,"agents":agents,"permissions":permissions,"usageSummary":usage,"settings":settings});
        tx.commit()?;
        Ok(result)
    }
    fn agent_rows_locked(&self,c:&Connection,include_archived:bool)->Result<Vec<Value>,StorageError>{
        let sql="SELECT json_object('id',id,'name',name,'description',description,'instructions',instructions,'color',color,'outfit',outfit,'runtimeId',runtime_id,'model',model,'thinking',thinking,'serviceTier',service_tier,'customArgs',json(custom_args),'customEnv',json(custom_env),'maxConcurrency',max_concurrency,'defaultProject',default_project,'sortOrder',sort_order,'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at,'projectId',project_id,'role',role,'leader',json(CASE WHEN leader=1 THEN 'true' ELSE 'false' END),'hidden',json(CASE WHEN hidden=1 THEN 'true' ELSE 'false' END),'look',json(look),'notificationLevel',COALESCE(notification_level,'all')) FROM agents WHERE (?1 OR archived=0) ORDER BY runtime_id,sort_order,created_at,id";
        let mut q=c.prepare(sql)?;let vals=q.query_map([include_archived],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;vals.into_iter().map(|v|Ok(serde_json::from_str(&v)?)).collect()
    }
    fn session_detail_locked(&self, c: &Connection, id: &str) -> Result<Value, StorageError> {
        let base:Option<String>=c.query_row("SELECT json_object('id',id,'runtimeId',runtime_id,'agentId',agent_id,'provider',provider,'providerSessionId',provider_session_id,'projectPath',project_path,'title',COALESCE(title_override,title),'modelLock',json(model_lock_json),'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'state',state,'resumable',json(CASE WHEN resumable!=0 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at,'workspaceLabel',COALESCE((SELECT p.name FROM projects p WHERE p.id=json_extract(sessions.data,'$.projectId')),(SELECT p.name FROM projects p WHERE p.path=sessions.project_path),'Casual'),'link',json_extract(data,'$.link')) FROM sessions WHERE id=?1",[id],|r|r.get(0)).optional()?;
        let mut v: Value =
            serde_json::from_str(&base.ok_or(rusqlite::Error::QueryReturnedNoRows)?)?;
        let (context_used, context_size, context_model, context_estimated) = session_context_locked(c, id)?;
        v["contextUsed"] = json!(context_used);
        v["contextSize"] = json!(context_size);
        v["contextModel"] = json!(context_model);
        v["contextEstimated"] = json!(context_estimated);
        let turns=query_jsons(c,"SELECT json_object('id',t.id,'state',t.state,'createdAt',t.created_at,'completedAt',t.completed_at,'failureClass',COALESCE(t.failure_class_v2,t.failure_class),'failureMessage',CASE COALESCE(t.failure_class_v2,t.failure_class) WHEN 'context' THEN 'Context window is full. Start a new conversation.' WHEN 'timeout' THEN 'The provider stopped making progress before the turn completed.' WHEN 'permission_denied' THEN 'A required permission was denied.' WHEN 'cancelled' THEN 'The turn was cancelled.' WHEN 'budget_stop' THEN 'The turn stopped because an applicable budget was reached.' WHEN 'config_unsupported' THEN 'Requested execution settings were unsupported.' WHEN 'provider_error' THEN 'The provider reported a turn error.' WHEN 'other' THEN 'The turn could not be completed.' ELSE NULL END,'detail',(SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_extract(e.payload,'$.turnId')=t.id ORDER BY e.sequence DESC LIMIT 1)) FROM turns t WHERE t.session_id=?1 ORDER BY t.created_at",id)?;
        let msgs=query_jsons(c,"SELECT json_object('id',id,'turnId',turn_id,'sequence',sequence,'role',role,'content',content,'createdAt',created_at,'attachments',json_extract(data,'$.attachments'),'meta',json_extract(data,'$.meta'),'references',json_extract(data,'$.references'),'reactions',json(COALESCE((SELECT json_group_array(emoji) FROM (SELECT emoji FROM message_reactions mr WHERE mr.session_id=messages.session_id AND mr.message_id=messages.id ORDER BY CASE emoji WHEN '👍' THEN 0 WHEN '👎' THEN 1 WHEN '❤️' THEN 2 WHEN '😂' THEN 3 WHEN '🎉' THEN 4 ELSE 5 END)), '[]'))) FROM messages WHERE session_id=?1 ORDER BY sequence",id)?;
        v["turns"] = json!(turns);
        v["messages"] = json!(msgs);
        v["tools"] = json!(query_jsons(c,"SELECT json_object('id',id,'sessionId',session_id,'turnId',turn_id,'kind',json_extract(data,'$.kind'),'title',json_extract(data,'$.title'),'state',state,'startedAt',json_extract(data,'$.startedAt'),'completedAt',json_extract(data,'$.completedAt'),'detail',json(COALESCE(json_extract(data,'$.detail'),'{}'))) FROM tool_calls WHERE session_id=?1 ORDER BY rowid",id)?);
        v["files"] = json!(query_jsons(c,"SELECT json_object('id',id,'turnId',turn_id,'path',path,'createdAt',json_extract(data,'$.createdAt'),'detail',json(COALESCE(json_extract(data,'$.detail'),'{}'))) FROM file_changes WHERE session_id=?1 ORDER BY rowid",id)?);
        Ok(v)
    }
    #[cfg(test)]
    fn budget_list_locked(&self, c: &Connection) -> Result<Value, StorageError> {
        let mut s=c.prepare("SELECT id,scope_type,scope_id,period,metric,hard_limit,warning_json,enabled,currency FROM budget_policies ORDER BY scope_type")?;
        let rows=s.query_map([],|r| {
            let id: String = r.get(0)?;
            let period: String = r.get(3)?;
            let limit: i64 = r.get(5)?;
            let scope_type: String = r.get(1)?;
            let scope_id: Option<String> = r.get(2)?;
            let (consumed,reserved) = budget_totals_locked(c, &id, &period, &scope_type, scope_id.as_deref())?;
            Ok(json!({"id":id,"scopeType":r.get::<_,String>(1)?,"scopeId":r.get::<_,Option<String>>(2)?,"period":period,"metric":r.get::<_,String>(4)?,"hardLimit":limit,"warningThresholds":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).unwrap_or(json!([])),"enabled":r.get::<_,bool>(7)?,"currency":r.get::<_,String>(8)?,"consumed":consumed,"reserved":reserved,"remaining":limit.saturating_sub(consumed).saturating_sub(reserved).max(0)}))
        })?.collect::<Result<Vec<_>,_>>()?;
        Ok(Value::Array(rows))
    }
    fn settings_locked(&self, c: &Connection) -> Result<Value, StorageError> {
        let mut q = c.prepare("SELECT key,value FROM settings")?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = serde_json::Map::new();
        for (k, v) in rows {
            out.insert(k, serde_json::from_str(&v)?);
        }
        Ok(Value::Object(out))
    }
    fn usage_rows_locked(&self, c: &Connection) -> Result<Value, StorageError> {
        self.usage_summary_locked(c, "0000", "9999")
    }

    // ── Memory: durable notes scoped to a blob, a project or everyone ──────
    pub fn memory_get(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        memory_read(&c, id)?.ok_or(StorageError::AgentNotFound)
    }
    pub fn memory_list(&self, filter: &Value) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let scope = filter.get("scope").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
        if let Some(scope) = scope { if !memory_valid_scope(scope) { return Err(StorageError::InvalidAgent); } }
        let scope_id = filter.get("scopeId").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
        let status = match filter.get("status") {
            None | Some(Value::Null) => "all",
            Some(Value::String(value)) if value == "all" || value == "unreviewed" => value.as_str(),
            _ => return Err(StorageError::InvalidAgent),
        };
        let include_deleted = match filter.get("includeDeleted") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err(StorageError::InvalidAgent),
        };
        let query = filter.get("query").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
        let limit = match filter.get("limit") {
            None | Some(Value::Null) => 100usize,
            Some(value) => value.as_u64().filter(|n| (1..=200).contains(n)).ok_or(StorageError::InvalidAgent)? as usize,
        };
        let ranked = query.map(|query| memory_search_ids(&c, query)).transpose()?;
        let mut rows = memory_all(&c)?;
        rows.retain(|row| {
            if !include_deleted && !row["deletedAt"].is_null() { return false; }
            if status == "unreviewed" && row["reviewed"] == true { return false; }
            if let Some(scope) = scope { if row["scope"] != scope { return false; } }
            if let Some(scope_id) = scope_id { if row["scopeId"].as_str() != Some(scope_id) { return false; } }
            if let Some(ranked) = &ranked { if !ranked.iter().any(|id| Some(id.as_str()) == row["id"].as_str()) { return false; } }
            true
        });
        rows.sort_by(|a, b| {
            b["pinned"].as_bool().unwrap_or(false).cmp(&a["pinned"].as_bool().unwrap_or(false))
                .then_with(|| b["updatedAt"].as_str().unwrap_or("").cmp(a["updatedAt"].as_str().unwrap_or("")))
        });
        rows.truncate(limit);
        Ok(rows)
    }
    /// Every live (not soft-deleted) memory record, oldest first. Used by the
    /// FIX31 backup export, which may exceed the review UI's page limit.
    pub fn memory_all_live(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut rows = memory_all(&c)?;
        rows.retain(|row| row["deletedAt"].is_null());
        rows.sort_by(|a, b| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")));
        Ok(rows)
    }
    pub fn memory_create(&self, input: &Value) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let scope = input["scope"].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or(StorageError::InvalidAgent)?;
        if !memory_valid_scope(scope) { return Err(StorageError::InvalidAgent); }
        let kind = input["kind"].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or(StorageError::InvalidAgent)?;
        if !memory_valid_kind(kind) { return Err(StorageError::InvalidAgent); }
        let title = memory_validate_title(input["title"].as_str().unwrap_or(""))?;
        let body = memory_validate_body(input["body"].as_str().unwrap_or(""))?;
        let tags = memory_validate_tags(input.get("tags").unwrap_or(&json!([])))?;
        let importance = memory_validate_importance(input.get("importance"))?;
        let pinned = match input.get("pinned") { None | Some(Value::Null) => false, Some(Value::Bool(value)) => *value, _ => return Err(StorageError::InvalidAgent) };
        let origin = match input["origin"].as_str().unwrap_or("user") { "user" => "user", "agent" => "agent", _ => return Err(StorageError::InvalidAgent) };
        let reviewed = match input.get("reviewed") { None | Some(Value::Null) => origin == "user", Some(Value::Bool(value)) => *value, _ => return Err(StorageError::InvalidAgent) };
        let source_session = input.get("sourceSessionId").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
        let scope_id = memory_resolve_scope_id(&c, scope, input.get("scopeId").and_then(Value::as_str))?;
        if c.query_row("SELECT COUNT(*) FROM memory_records WHERE deleted_at IS NULL", [], |row| row.get::<_, i64>(0))? >= 1000 {
            return Err(StorageError::InvalidAgent);
        }
        let live_in_scope: i64 = c.query_row(
            "SELECT COUNT(*) FROM memory_records WHERE deleted_at IS NULL AND scope=?1 AND ((scope_id IS NULL AND ?2 IS NULL) OR scope_id=?2)",
            params![scope, scope_id],
            |row| row.get(0),
        )?;
        if live_in_scope >= 300 { return Err(StorageError::InvalidAgent); }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO memory_records(id,scope,scope_id,kind,title,body,tags,importance,pinned,origin,reviewed,source_session_id,version,created_at,updated_at,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?13,?13,NULL)",
            params![id, scope, scope_id, kind, title, body, tags, importance, pinned, origin, reviewed, source_session, now],
        )?;
        tx.execute("INSERT INTO memory_fts(record_id,title,body,tags) VALUES(?1,?2,?3,?4)", params![id, title, body, tags])?;
        tx.execute("INSERT INTO memory_versions(record_id,version,title,body,changed_by,changed_at) VALUES(?1,1,?2,?3,?4,?5)", params![id, title, body, origin, now])?;
        let record = tx.query_row(&format!("SELECT {MEMORY_COLUMNS} FROM memory_records WHERE id=?1"), [&id], memory_dto_from_row)?;
        tx.commit()?;
        Ok(record)
    }
    pub fn memory_update(&self, id: &str, expected_version: i64, patch: &Value, changed_by: &str) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = memory_read(&c, id)?.ok_or(StorageError::AgentNotFound)?;
        if !row["deletedAt"].is_null() { return Err(StorageError::AgentConflict); }
        let current = row["version"].as_i64().unwrap_or(1);
        if current != expected_version { return Err(StorageError::AgentConflict); }
        let title = match patch.get("title") { None | Some(Value::Null) => row["title"].as_str().unwrap_or("").to_owned(), Some(_) => memory_validate_title(patch["title"].as_str().unwrap_or(""))? };
        let body = match patch.get("body") { None | Some(Value::Null) => row["body"].as_str().unwrap_or("").to_owned(), Some(_) => memory_validate_body(patch["body"].as_str().unwrap_or(""))? };
        let kind = match patch.get("kind") {
            None | Some(Value::Null) => row["kind"].as_str().unwrap_or("fact").to_owned(),
            Some(Value::String(value)) if memory_valid_kind(value) => value.clone(),
            _ => return Err(StorageError::InvalidAgent),
        };
        let tags = match patch.get("tags") { None | Some(Value::Null) => serde_json::to_string(&row["tags"])?, Some(value) => memory_validate_tags(value)? };
        let importance = match patch.get("importance") { None | Some(Value::Null) => row["importance"].as_i64().unwrap_or(50), Some(value) => memory_validate_importance(Some(value))? };
        let pinned = match patch.get("pinned") { None | Some(Value::Null) => row["pinned"].as_bool().unwrap_or(false), Some(Value::Bool(value)) => *value, _ => return Err(StorageError::InvalidAgent) };
        let version = current + 1;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("UPDATE memory_records SET title=?2,body=?3,kind=?4,tags=?5,importance=?6,pinned=?7,version=?8,updated_at=?9 WHERE id=?1", params![id, title, body, kind, tags, importance, pinned, version, now])?;
        tx.execute("DELETE FROM memory_fts WHERE record_id=?1", [id])?;
        tx.execute("INSERT INTO memory_fts(record_id,title,body,tags) VALUES(?1,?2,?3,?4)", params![id, title, body, tags])?;
        tx.execute("INSERT INTO memory_versions(record_id,version,title,body,changed_by,changed_at) VALUES(?1,?2,?3,?4,?5,?6)", params![id, version, title, body, changed_by, now])?;
        tx.execute("DELETE FROM memory_versions WHERE record_id=?1 AND version NOT IN (SELECT version FROM memory_versions WHERE record_id=?1 ORDER BY version DESC LIMIT 10)", [id])?;
        let record = tx.query_row(&format!("SELECT {MEMORY_COLUMNS} FROM memory_records WHERE id=?1"), [id], memory_dto_from_row)?;
        tx.commit()?;
        Ok(record)
    }
    pub fn memory_approve(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = memory_read(&c, id)?.ok_or(StorageError::AgentNotFound)?;
        if !row["deletedAt"].is_null() { return Err(StorageError::AgentConflict); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        c.execute("UPDATE memory_records SET reviewed=1,updated_at=?2 WHERE id=?1 AND reviewed=0", params![id, now])?;
        memory_read(&c, id)?.ok_or(StorageError::AgentNotFound)
    }
    pub fn memory_delete(&self, id: &str, expected_version: Option<i64>, changed_by: &str) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = memory_read(&c, id)?.ok_or(StorageError::AgentNotFound)?;
        if !row["deletedAt"].is_null() { return Err(StorageError::AgentConflict); }
        let version = row["version"].as_i64().unwrap_or(1);
        if let Some(expected) = expected_version { if version != expected { return Err(StorageError::AgentConflict); } }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("UPDATE memory_records SET deleted_at=?2,updated_at=?2 WHERE id=?1", params![id, now])?;
        tx.execute("DELETE FROM memory_fts WHERE record_id=?1", [id])?;
        tx.execute(
            "INSERT OR REPLACE INTO memory_versions(record_id,version,title,body,changed_by,changed_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, version, row["title"].as_str().unwrap_or(""), row["body"].as_str().unwrap_or(""), changed_by, now],
        )?;
        let record = tx.query_row(&format!("SELECT {MEMORY_COLUMNS} FROM memory_records WHERE id=?1"), [id], memory_dto_from_row)?;
        tx.commit()?;
        Ok(record)
    }
    pub fn memory_restore(&self, id: &str) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let row = memory_read(&c, id)?.ok_or(StorageError::AgentNotFound)?;
        if row["deletedAt"].is_null() { return Err(StorageError::AgentConflict); }
        if c.query_row("SELECT COUNT(*) FROM memory_records WHERE deleted_at IS NULL", [], |r| r.get::<_, i64>(0))? >= 1000 {
            return Err(StorageError::InvalidAgent);
        }
        let tags = serde_json::to_string(&row["tags"])?;
        let title = row["title"].as_str().unwrap_or("").to_owned();
        let body = row["body"].as_str().unwrap_or("").to_owned();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("UPDATE memory_records SET deleted_at=NULL,updated_at=?2 WHERE id=?1", params![id, now])?;
        tx.execute("DELETE FROM memory_fts WHERE record_id=?1", [id])?;
        tx.execute("INSERT INTO memory_fts(record_id,title,body,tags) VALUES(?1,?2,?3,?4)", params![id, title, body, tags])?;
        let record = tx.query_row(&format!("SELECT {MEMORY_COLUMNS} FROM memory_records WHERE id=?1"), [id], memory_dto_from_row)?;
        tx.commit()?;
        Ok(record)
    }
    pub fn memory_visible_catalog(&self, agent_id: &str, project_id: Option<&str>) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut rows = memory_all(&c)?.into_iter()
            .filter(|row| memory_is_live_reviewed(row) && memory_visible_to(row, agent_id, project_id))
            .collect::<Vec<_>>();
        memory_catalog_order(&mut rows);
        Ok(rows)
    }
    pub fn memory_visible_search(&self, agent_id: &str, project_id: Option<&str>, query: &str, limit: usize) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut out = Vec::new();
        for id in memory_search_ids(&c, query)? {
            if out.len() >= limit { break; }
            if let Some(row) = memory_read(&c, &id)? {
                if memory_is_live_reviewed(&row) && memory_visible_to(&row, agent_id, project_id) { out.push(row); }
            }
        }
        Ok(out)
    }
    pub fn memory_visible_get(&self, id: &str, agent_id: &str, project_id: Option<&str>) -> Result<Option<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let Some(row) = memory_read(&c, id)? else { return Ok(None) };
        if memory_is_live_reviewed(&row) && memory_visible_to(&row, agent_id, project_id) { Ok(Some(row)) } else { Ok(None) }
    }
    pub fn memory_versions(&self, id: &str) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = c.prepare("SELECT version,title,body,changed_by,changed_at FROM memory_versions WHERE record_id=?1 ORDER BY version")?;
        let rows = statement.query_map([id], |row| Ok(json!({
            "version": row.get::<_, i64>(0)?,
            "title": row.get::<_, String>(1)?,
            "body": row.get::<_, String>(2)?,
            "changedBy": row.get::<_, String>(3)?,
            "changedAt": row.get::<_, String>(4)?,
        })))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ── Skills: the shared pool every bot draws from (FIX32) ──────────────
    pub fn skills_list(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        skill_rows(&c)
    }
    pub fn skills_get(&self, name: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut row = c.query_row(&format!("SELECT {SKILL_COLUMNS} FROM skills WHERE name=?1"), [name], skill_dto_from_row).optional()?.ok_or(StorageError::AgentNotFound)?;
        let disabled = skill_disabled_pairs(&c)?;
        row["disabledFor"] = json!(disabled.into_iter().filter(|(skill, _)| skill == name).map(|(_, agent)| agent).collect::<Vec<_>>());
        Ok(row)
    }
    pub fn skills_upsert(&self, input: &Value) -> Result<Value, StorageError> {
        let name = input["name"].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or(StorageError::InvalidAgent)?;
        if !valid_skill_name(name) { return Err(StorageError::InvalidAgent); }
        let description = input["description"].as_str().ok_or(StorageError::InvalidAgent)?;
        let source = input["source"].as_str().ok_or(StorageError::InvalidAgent)?;
        if !["claude", "codex", "opencode", "folder", "backup"].contains(&source) { return Err(StorageError::InvalidAgent); }
        let source_path = input["sourcePath"].as_str().map(str::trim).filter(|value| !value.is_empty());
        let content_sha256 = input["contentSha256"].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or(StorageError::InvalidAgent)?;
        let file_count = input["fileCount"].as_i64().filter(|value| *value >= 0).ok_or(StorageError::InvalidAgent)?;
        let total_bytes = input["totalBytes"].as_i64().filter(|value| *value >= 0).ok_or(StorageError::InvalidAgent)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO skills(name,description,source,source_path,content_sha256,enabled,file_count,total_bytes,imported_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,?8) \
             ON CONFLICT(name) DO UPDATE SET description=excluded.description,source=excluded.source,source_path=excluded.source_path,\
             content_sha256=excluded.content_sha256,file_count=excluded.file_count,total_bytes=excluded.total_bytes,updated_at=excluded.updated_at",
            params![name, description, source, source_path, content_sha256, file_count, total_bytes, now],
        )?;
        let mut row = tx.query_row(&format!("SELECT {SKILL_COLUMNS} FROM skills WHERE name=?1"), [name], skill_dto_from_row)?;
        tx.commit()?;
        row["disabledFor"] = json!([]);
        Ok(row)
    }
    pub fn skills_delete(&self, name: &str) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !tx.query_row("SELECT EXISTS(SELECT 1 FROM skills WHERE name=?1)", [name], |r| r.get::<_, bool>(0))? {
            return Err(StorageError::AgentNotFound);
        }
        tx.execute("DELETE FROM skill_agent_settings WHERE skill_name=?1", [name])?;
        tx.execute("DELETE FROM skills WHERE name=?1", [name])?;
        tx.commit()?;
        Ok(())
    }
    /// `agent_id` present: a per-bot row (an opt-out when `enabled` is false).
    /// `agent_id` absent: the pool-wide switch.
    pub fn skills_toggle(&self, name: &str, enabled: bool, agent_id: Option<&str>) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM skills WHERE name=?1)", [name], |r| r.get(0))?;
        if !exists { return Err(StorageError::AgentNotFound); }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        match agent_id.map(str::trim).filter(|value| !value.is_empty()) {
            Some(agent_id) => {
                if !tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [agent_id], |r| r.get::<_, bool>(0))? {
                    return Err(StorageError::InvalidAgent);
                }
                tx.execute(
                    "INSERT INTO skill_agent_settings(skill_name,agent_id,enabled) VALUES(?1,?2,?3) \
                     ON CONFLICT(skill_name,agent_id) DO UPDATE SET enabled=excluded.enabled",
                    params![name, agent_id, enabled],
                )?;
            }
            None => {
                tx.execute("UPDATE skills SET enabled=?2,updated_at=?3 WHERE name=?1", params![name, enabled, now])?;
            }
        }
        let mut row = tx.query_row(&format!("SELECT {SKILL_COLUMNS} FROM skills WHERE name=?1"), [name], skill_dto_from_row)?;
        tx.commit()?;
        let disabled = skill_disabled_pairs(&c)?;
        row["disabledFor"] = json!(disabled.into_iter().filter(|(skill, _)| skill == name).map(|(_, agent)| agent).collect::<Vec<_>>());
        Ok(row)
    }

    /// FIX31: restore bots, memory, automations and settings in one
    /// transaction. `plan` is fully resolved by the daemon's `backup.rs`: bots
    /// already name a local runtime, memory has been checked for secrets and
    /// project-scope memory carries a local project id, the settings allowlist
    /// has been applied. This method re-checks the invariants that must hold
    /// inside the transaction (name uniqueness, a real runtime, valid rows) and
    /// returns what it imported, what it skipped and the events to broadcast.
    ///
    /// `plan.memory[i].scopeExportId` names the exported bot for blob-scope
    /// notes; the method maps it to the id of the bot it just created or
    /// replaced, so restored notes follow their bot.
    pub fn backup_import(&self, plan: &Value) -> Result<Value, StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut leader_taken: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE leader=1 AND archived=0)", [], |r| r.get(0))?;
        let mut export_to_agent: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut renamed: Vec<Value> = Vec::new();
        let mut events: Vec<Value> = Vec::new();
        let mut bots = 0u64;
        let mut bots_skipped = 0u64;
        let empty: Vec<Value> = Vec::new();

        for bot in plan["bots"].as_array().unwrap_or(&empty) {
            let export_id = bot["exportId"].as_str().unwrap_or("").to_owned();
            let resolution = bot["resolution"].as_str().unwrap_or("rename");
            if resolution == "skip" { bots_skipped += 1; continue; }
            let fields = &bot["fields"];
            if resolution == "replace" {
                let Some(id) = bot["replaceAgentId"].as_str().filter(|id| !id.is_empty()) else { bots_skipped += 1; continue; };
                let existing = agent_read(&tx, id)?;
                if existing["archived"] == true { bots_skipped += 1; continue; }
                let mut next = existing.clone();
                for key in ["name","runtimeId","description","instructions","color","outfit","look","role","model","thinking","serviceTier","approvalMode","customArgs","customEnv","maxConcurrency","notificationLevel"] {
                    if let Some(value) = fields.get(key) { next[key] = value.clone(); }
                }
                if validate_agent_fields(&next, false).is_err() { bots_skipped += 1; continue; }
                let runtime = next["runtimeId"].as_str().unwrap_or("").to_owned();
                if !runtime_exists(&tx, &runtime)? { bots_skipped += 1; continue; }
                let name = next["name"].as_str().unwrap_or("").trim().to_owned();
                let key = name.to_lowercase();
                let old_runtime = existing["runtimeId"].as_str().unwrap_or("").to_owned();
                if runtime != old_runtime {
                    let pos: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM agents WHERE runtime_id=?1 AND archived=0 AND id<>?2", params![runtime, id], |r| r.get(0))?;
                    tx.execute("UPDATE agents SET runtime_id=?2,sort_order=?3 WHERE id=?1", params![id, runtime, pos])?;
                }
                let color = next["color"].as_str().unwrap_or("mint");
                let color = if color.starts_with('#') { color.to_ascii_uppercase() } else { color.to_owned() };
                let leader = bot["leader"].as_bool().unwrap_or(false) && !leader_taken;
                if leader { tx.execute("UPDATE agents SET leader=0 WHERE leader=1 AND id<>?1", [id])?; leader_taken = true; }
                tx.execute("UPDATE agents SET name=?2,name_key=?3,description=?4,instructions=?5,color=?6,outfit=?7,model=?8,thinking=?9,service_tier=?10,approval_mode=?11,custom_args=?12,custom_env=?13,max_concurrency=?14,default_project=NULL,notification_level=?15,role=?16,hidden=?17,leader=?18,updated_at=?19 WHERE id=?1",
                    params![id, name, key, next["description"].as_str().unwrap_or(""), next["instructions"].as_str().unwrap_or(""), color, next["outfit"].as_str().unwrap_or("auto"), nullable(&next["model"]), nullable(&next["thinking"]), nullable(&next["serviceTier"]), nullable(&next["approvalMode"]), next["customArgs"].to_string(), next["customEnv"].to_string(), next["maxConcurrency"].as_i64().unwrap_or(1), nullable(&next["notificationLevel"]), next["role"].as_str().unwrap_or(""), next["hidden"].as_bool().unwrap_or(false), leader, now])?;
                tx.execute("UPDATE agents SET look=?2 WHERE id=?1", params![id, look_column(&next["look"])])?;
                let updated = agent_read(&tx, id)?;
                events.push(push_agent_event(&tx, "updated", &updated)?);
                export_to_agent.insert(export_id, id.to_owned());
                bots += 1;
            } else {
                let base = fields["name"].as_str().unwrap_or("Bot").trim().to_owned();
                let (name, key) = unique_agent_name(&tx, &base)?;
                if name != base { renamed.push(json!({"from": base, "to": name})); }
                let mut value = fields.clone();
                value["name"] = json!(name);
                let runtime = value["runtimeId"].as_str().unwrap_or("").to_owned();
                if !runtime_exists(&tx, &runtime)? || validate_agent_fields(&value, true).is_err() { bots_skipped += 1; continue; }
                let id = Uuid::new_v4().to_string();
                let pos: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM agents WHERE runtime_id=?1 AND archived=0", [runtime.as_str()], |r| r.get(0))?;
                insert_agent(&tx, &id, &value, &name, &key, pos, &now)?;
                let leader = bot["leader"].as_bool().unwrap_or(false) && !leader_taken;
                if leader { leader_taken = true; }
                tx.execute("UPDATE agents SET role=?2,hidden=?3,leader=?4,project_id=NULL WHERE id=?1",
                    params![id, value["role"].as_str().unwrap_or(""), value["hidden"].as_bool().unwrap_or(false), leader])?;
                let created = agent_read(&tx, &id)?;
                events.push(push_agent_event(&tx, "created", &created)?);
                export_to_agent.insert(export_id, id);
                bots += 1;
            }
        }

        let mut memory = 0u64;
        let mut memory_skipped = 0u64;
        let mut live: u64 = tx.query_row("SELECT COUNT(*) FROM memory_records WHERE deleted_at IS NULL", [], |r| r.get::<_, i64>(0))? as u64;
        for item in plan["memory"].as_array().unwrap_or(&empty) {
            let scope = item["scope"].as_str().unwrap_or("");
            if !memory_valid_scope(scope) { memory_skipped += 1; continue; }
            let scope_id: Option<String> = match scope {
                "shared" => None,
                "blob" => match item["scopeExportId"].as_str().and_then(|export| export_to_agent.get(export)).cloned() {
                    Some(id) => Some(id),
                    None => { memory_skipped += 1; continue; }
                },
                "project" => match item["scopeId"].as_str() {
                    Some(id) if tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [id], |r| r.get::<_, bool>(0))? => Some(id.to_owned()),
                    _ => { memory_skipped += 1; continue; }
                },
                _ => { memory_skipped += 1; continue; }
            };
            let kind = item["kind"].as_str().unwrap_or("fact");
            if !memory_valid_kind(kind) { memory_skipped += 1; continue; }
            let Ok(title) = memory_validate_title(item["title"].as_str().unwrap_or("")) else { memory_skipped += 1; continue; };
            let Ok(body) = memory_validate_body(item["body"].as_str().unwrap_or("")) else { memory_skipped += 1; continue; };
            let Ok(tags) = memory_validate_tags(item.get("tags").unwrap_or(&json!([]))) else { memory_skipped += 1; continue; };
            let Ok(importance) = memory_validate_importance(item.get("importance")) else { memory_skipped += 1; continue; };
            let pinned = item["pinned"].as_bool().unwrap_or(false);
            let origin = match item["origin"].as_str() { Some("agent") => "agent", _ => "user" };
            let reviewed = item["reviewed"].as_bool().unwrap_or(origin == "user");
            let source_id = item["sourceId"].as_str().unwrap_or("");
            if let Some(existing) = memory_read(&tx, source_id)? {
                if memory_identical(&existing, scope, scope_id.as_deref(), kind, &title, &body, &tags, importance, pinned, origin, reviewed) {
                    memory_skipped += 1; continue;
                }
            }
            if live >= 1000 { memory_skipped += 1; continue; }
            let id = if source_id.is_empty() || memory_read(&tx, source_id)?.is_some() { Uuid::new_v4().to_string() } else { source_id.to_owned() };
            let created = item["createdAt"].as_str().unwrap_or(&now).to_owned();
            tx.execute(
                "INSERT INTO memory_records(id,scope,scope_id,kind,title,body,tags,importance,pinned,origin,reviewed,source_session_id,version,created_at,updated_at,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,1,?12,?12,NULL)",
                params![id, scope, scope_id, kind, title, body, tags, importance, pinned, origin, reviewed, created],
            )?;
            tx.execute("INSERT INTO memory_fts(record_id,title,body,tags) VALUES(?1,?2,?3,?4)", params![id, title, body, tags])?;
            tx.execute("INSERT INTO memory_versions(record_id,version,title,body,changed_by,changed_at) VALUES(?1,1,?2,?3,?4,?5)", params![id, title, body, origin, &now])?;
            memory += 1;
            live += 1;
        }

        let mut restored_automations: Vec<Value> = Vec::new();
        let mut automations_skipped = 0u64;
        for item in plan["automations"].as_array().unwrap_or(&empty) {
            let Some(agent_id) = item["agentExportId"].as_str().and_then(|export| export_to_agent.get(export)).cloned() else { automations_skipped += 1; continue; };
            let name = item["name"].as_str().map(str::trim).unwrap_or("");
            let prompt = item["prompt"].as_str().unwrap_or("");
            if !(1..=80).contains(&name.chars().count()) || prompt.is_empty() || prompt.len() > 8000 { automations_skipped += 1; continue; }
            let Ok(schedule) = cron::parse_schedule(&item["schedule"], None) else { automations_skipped += 1; continue; };
            let session_mode = match item["sessionMode"].as_str() { Some("reuse") => "reuse", _ => "new" };
            let approval_mode = match item["approvalMode"].as_str() { Some("plan") => "plan", _ => "auto" };
            let max_runtime = item["maxRuntimeSecs"].as_i64().filter(|secs| (60..=14_400).contains(secs)).unwrap_or(1800);
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM automations", [], |r| r.get(0))?;
            if count >= 50 { automations_skipped += 1; continue; }
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO automations(id,agent_id,name,prompt,schedule_kind,cron,timezone,once_at,session_mode,approval_mode,max_runtime_secs,enabled,created_by,reuse_session_id,next_run_at,last_run_at,consecutive_failures,pause_reason,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,'user',NULL,NULL,NULL,0,'restored',?12,?12)",
                params![id, agent_id, name, prompt, schedule.kind, schedule.cron, schedule.timezone, schedule.once_at, session_mode, approval_mode, max_runtime, now],
            )?;
            restored_automations.push(automation_read(&tx, &id)?);
        }

        let mut settings = 0u64;
        let mut settings_skipped = 0u64;
        for entry in plan["settings"].as_array().unwrap_or(&empty) {
            let Some(key) = entry["key"].as_str().filter(|key| !key.is_empty()) else { settings_skipped += 1; continue; };
            match write_setting(&tx, key, &entry["value"]) {
                Ok(mut produced) => { events.append(&mut produced); settings += 1; }
                Err(_) => settings_skipped += 1,
            }
        }

        tx.commit()?;
        Ok(json!({
            "bots": bots,
            "memory": memory,
            "automations": restored_automations,
            "settings": settings,
            "skipped": {"bots": bots_skipped, "memory": memory_skipped, "automations": automations_skipped, "settings": settings_skipped},
            "renamed": renamed,
            "events": events,
        }))
    }
}

/// FIX31: a bot name that is free among non-archived bots, adding " (2)",
/// " (3)"… and staying within the 60-character cap.
fn unique_agent_name(c: &Connection, base: &str) -> Result<(String, String), StorageError> {
    let clean = base.trim();
    let clean = if clean.is_empty() { "Bot" } else { clean };
    let mut candidate = clean.chars().take(60).collect::<String>();
    let mut n = 2u32;
    loop {
        let key = candidate.to_lowercase();
        let taken: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE name_key=?1 AND archived=0)", [key.as_str()], |r| r.get(0))?;
        if !taken { return Ok((candidate, key)); }
        let suffix = format!(" ({n})");
        let keep = 60usize.saturating_sub(suffix.chars().count());
        candidate = format!("{}{}", clean.chars().take(keep).collect::<String>(), suffix);
        n += 1;
    }
}

/// Whether a stored memory record already carries exactly this incoming note,
/// so a re-import can skip it instead of duplicating it.
#[allow(clippy::too_many_arguments)]
fn memory_identical(existing: &Value, scope: &str, scope_id: Option<&str>, kind: &str, title: &str, body: &str, tags: &str, importance: i64, pinned: bool, origin: &str, reviewed: bool) -> bool {
    existing["scope"].as_str() == Some(scope)
        && existing["scopeId"].as_str() == scope_id
        && existing["kind"].as_str() == Some(kind)
        && existing["title"].as_str() == Some(title)
        && existing["body"].as_str() == Some(body)
        && serde_json::to_string(&existing["tags"]).is_ok_and(|stored| stored == tags)
        && existing["importance"].as_i64() == Some(importance)
        && existing["pinned"].as_bool() == Some(pinned)
        && existing["origin"].as_str() == Some(origin)
        && existing["reviewed"].as_bool() == Some(reviewed)
}

/// Hint ids: `[a-z0-9._-]{1,48}`, at most 64 kept, oldest dropped by the caller.
fn valid_hints_seen(value: &Value) -> bool {
    let Some(items) = value.as_array() else { return false; };
    if items.len() > 64 { return false; }
    items.iter().all(|item| item.as_str().is_some_and(valid_hint_id))
}

fn valid_hint_id(id: &str) -> bool {
    (1..=48).contains(&id.len())
        && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
}

/// `onboarding.tour`: `{ version: 0..=999, done: boolean, step: 0..=20 }`, all fields present.
fn valid_tour_state(value: &Value) -> bool {
    let Some(object) = value.as_object() else { return false; };
    matches!(object.get("version").and_then(Value::as_u64), Some(version) if version <= 999)
        && object.get("done").is_some_and(Value::is_boolean)
        && matches!(object.get("step").and_then(Value::as_u64), Some(step) if step <= 20)
}

/// `companion.positions`: at most 8 display-name keys, each `{ x: number, y: number }`.
fn valid_companion_positions(value: &Value) -> bool {
    let Some(object) = value.as_object() else { return false; };
    if object.len() > 8 { return false; }
    object.iter().all(|(name, point)| {
        !name.is_empty()
            && name.len() <= 200
            && point.get("x").and_then(Value::as_f64).is_some()
            && point.get("y").and_then(Value::as_f64).is_some()
    })
}

fn valid_usage_tip_dismissals(value: &Value) -> bool {
    let Some(items) = value.as_array() else { return false; };
    if items.len() > 24 { return false; }
    items.iter().all(|item| {
        let provider = item["provider"].as_str().unwrap_or("");
        let window_key = item["windowKey"].as_str().unwrap_or("");
        let reset_at_valid = item["resetAt"].is_null() || item["resetAt"].as_str().is_some_and(|raw| chrono::DateTime::parse_from_rfc3339(raw).is_ok());
        matches!(provider, "claude" | "codex" | "opencode")
            && !window_key.is_empty()
            && window_key.len() <= 100
            && window_key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/".contains(&byte))
            && reset_at_valid
            && matches!(item["threshold"].as_u64(), Some(75 | 90 | 100))
    })
}

fn session_event_summary_locked(c: &Connection, id: &str) -> Result<Value, StorageError> {
    let json: Option<String> = c.query_row(
        "SELECT json_object('id',id,'runtimeId',runtime_id,'agentId',agent_id,'provider',provider,'title',COALESCE(title_override,title),'modelLock',json(model_lock_json),'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'state',state,'resumable',json(CASE WHEN resumable!=0 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at,'workspaceLabel',COALESCE((SELECT p.name FROM projects p WHERE p.id=json_extract(sessions.data,'$.projectId')),(SELECT p.name FROM projects p WHERE p.path=sessions.project_path),'Casual'),'link',json_extract(data,'$.link')) FROM sessions WHERE id=?1",
        [id],
        |r| r.get(0),
    ).optional()?;
    let mut summary: Value = serde_json::from_str(&json.ok_or(StorageError::AgentNotFound)?)?;
    let (context_used, context_size, context_model, context_estimated) = session_context_locked(c, id)?;
    summary["contextUsed"] = json!(context_used);
    summary["contextSize"] = json!(context_size);
    summary["contextModel"] = json!(context_model);
    summary["contextEstimated"] = json!(context_estimated);
    Ok(summary)
}

// Context counters plus the model label and estimated flag; a named type would not add meaning.
#[allow(clippy::type_complexity)]
fn session_context_locked(c: &Connection, id: &str) -> Result<(Option<i64>, Option<i64>, Option<String>, bool), StorageError> {
    let event: Option<(String, String)> = c.query_row(
        "SELECT event_type,payload FROM app_events WHERE event_type IN ('session.context.updated','session.context.reset') AND json_valid(payload) AND json_extract(payload,'$.sessionId')=?1 ORDER BY sequence DESC LIMIT 1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    if let Some((event_type, payload)) = event {
        if event_type == "session.context.reset" { return Ok((None, None, None, false)); }
        let payload: Value = serde_json::from_str(&payload)?;
        let context_model_present = payload.as_object().is_some_and(|object| object.contains_key("contextModel"));
        let usage_model: Option<String> = if !context_model_present {
            c.query_row("SELECT model FROM usage_events WHERE session_id=?1 AND (context_used IS NOT NULL OR context_size IS NOT NULL) ORDER BY rowid DESC LIMIT 1", [id], |row| row.get(0)).optional()?.flatten()
        } else { None };
        return Ok((payload["contextUsed"].as_i64(), payload["contextSize"].as_i64(), payload["contextModel"].as_str().map(str::to_owned).or(usage_model), payload["contextEstimated"].as_bool().unwrap_or(false)));
    }
    let context: Option<(Option<i64>, Option<i64>, Option<String>)> = c.query_row(
        "SELECT context_used,context_size,model FROM usage_events WHERE session_id=?1 AND (context_used IS NOT NULL OR context_size IS NOT NULL) ORDER BY rowid DESC LIMIT 1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    Ok(context.map(|(used,size,model)|(used,size,model,false)).unwrap_or((None, None, None, false)))
}

#[derive(Clone, Default)]
struct AnalyticsAccumulator {
    tokens: [Option<i64>; 5],
    tokens_lower_bound: bool,
    unreported_runs: u64,
    run_time_ms: u64,
    runs: u64,
    failed_runs: u64,
    cancelled_runs: u64,
    active_runs: u64,
}
impl AnalyticsAccumulator {
    fn add_tokens(&mut self, values: [Option<i64>; 5]) {
        for (sum, value) in self.tokens.iter_mut().zip(values) {
            if let Some(value) = value {
                *sum = Some(sum.unwrap_or(0).saturating_add(value.max(0)));
            }
        }
    }
    fn add_run(&mut self, state: &str, started: Option<&str>, completed: Option<&str>) {
        if matches!(state, "starting" | "working" | "waiting_permission" | "cancelling") {
            self.active_runs = 1;
            return;
        }
        if !matches!(state, "completed" | "error" | "cancelled") { return; }
        self.runs = 1;
        self.failed_runs = u64::from(state == "error");
        self.cancelled_runs = u64::from(state == "cancelled");
        if let (Some(start), Some(end)) = (
            started.and_then(|value| DateTime::parse_from_rfc3339(value).ok()),
            completed.and_then(|value| DateTime::parse_from_rfc3339(value).ok()),
        ) {
            self.run_time_ms = end.signed_duration_since(start).num_milliseconds().max(0) as u64;
        }
    }
    fn merge(&mut self, other: &Self) {
        for (sum, value) in self.tokens.iter_mut().zip(other.tokens) {
            if let Some(value) = value { *sum = Some(sum.unwrap_or(0).saturating_add(value)); }
        }
        self.tokens_lower_bound |= other.tokens_lower_bound;
        self.unreported_runs += other.unreported_runs;
        self.run_time_ms = self.run_time_ms.saturating_add(other.run_time_ms);
        self.runs += other.runs;
        self.failed_runs += other.failed_runs;
        self.cancelled_runs += other.cancelled_runs;
        self.active_runs += other.active_runs;
    }
    fn tokens_json(&self) -> Value {
        let total = self.tokens.iter().flatten().copied().fold(None, |sum: Option<i64>, value| Some(sum.unwrap_or(0).saturating_add(value)));
        json!({"input":self.tokens[0],"output":self.tokens[1],"cacheRead":self.tokens[2],"cacheWrite":self.tokens[3],"reasoning":self.tokens[4],"total":total})
    }
    fn point_json(&self) -> Value {
        json!({"tokens":self.tokens_json(),"tokensLowerBound":self.tokens_lower_bound,"runTimeMs":self.run_time_ms,"runs":self.runs,"failedRuns":self.failed_runs,"cancelledRuns":self.cancelled_runs})
    }
    fn totals_json(&self) -> Value {
        let mut result = self.point_json();
        result["activeRuns"] = json!(self.active_runs);
        result["unreportedRuns"] = json!(self.unreported_runs);
        result
    }
}
fn analytics_leader(agent_id: Option<String>, agent_name: Option<String>, runtime_id: String, metrics: AnalyticsAccumulator) -> Value {
    let mut result = metrics.point_json();
    result["agentId"] = json!(agent_id);
    result["agentName"] = json!(agent_name);
    result["runtimeId"] = json!(runtime_id);
    result["tokensLowerBound"] = json!(metrics.tokens_lower_bound);
    result["unreportedRuns"] = json!(metrics.unreported_runs);
    result
}
fn analytics_failure_class(class: Option<&str>) -> &'static str {
    match class.unwrap_or("other") {
        "provider_error" => "provider",
        "permission_denied" => "permission",
        "cancelled" => "cancelled",
        "timeout" => "timeout",
        "budget_stop" => "budget",
        "config_unsupported" => "config",
        "context" => "context",
        _ => "other",
    }
}
fn analytics_failure_message(class: &str) -> &'static str {
    match class {
        "provider" => "Provider reported an error.",
        "permission" => "Permission was denied.",
        "cancelled" => "Turn was cancelled.",
        "timeout" => "Turn timed out.",
        "budget" => "Turn stopped by a budget limit.",
        "config" => "Configuration or capability was unsupported.",
        "context" => "Context window is full. Start a new conversation.",
        _ => "Turn ended with an error.",
    }
}
fn normalize_project_path(value: &str) -> String {
    value.replace('\\', "/").split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("/").to_ascii_lowercase()
}
fn analytics_bucket_start(date: NaiveDate, timezone: Tz, bucket: &str) -> Result<DateTime<Utc>, StorageError> {
    let date = if bucket == "week" { date - Duration::days(i64::from(date.weekday().num_days_from_monday())) } else { date };
    let midnight = date.and_hms_opt(0, 0, 0).ok_or(StorageError::InvalidAnalytics)?;
    let mut local = midnight;
    for _ in 0..=180 {
        match timezone.from_local_datetime(&local) {
            chrono::LocalResult::Single(value) => return Ok(value.with_timezone(&Utc)),
            chrono::LocalResult::Ambiguous(first, second) => return Ok(first.min(second).with_timezone(&Utc)),
            chrono::LocalResult::None => local += Duration::minutes(1),
        }
    }
    Err(StorageError::InvalidAnalytics)
}
fn analytics_bucket_starts(from: DateTime<Utc>, to: DateTime<Utc>, timezone: Tz, bucket: &str) -> Result<Vec<DateTime<Utc>>, StorageError> {
    let mut date = from.with_timezone(&timezone).date_naive();
    if bucket == "week" { date -= Duration::days(i64::from(date.weekday().num_days_from_monday())); }
    let step = if bucket == "week" { 7 } else { 1 };
    let mut starts = Vec::new();
    loop {
        let start = analytics_bucket_start(date, timezone, bucket)?;
        if start >= to { break; }
        starts.push(start);
        date = date.checked_add_signed(Duration::days(step)).ok_or(StorageError::InvalidAnalytics)?;
    }
    Ok(starts)
}
fn validate_agent_id(id:&str)->Result<(),StorageError>{if Uuid::parse_str(id).is_ok_and(|uuid|uuid.hyphenated().to_string()==id){Ok(())}else{Err(StorageError::InvalidAgent)}}
#[cfg(test)]
const DECIMAL_SCALE: i128 = 1_000_000_000_000_000_000;
#[cfg(test)]
fn decimal_units(value: &str) -> Option<i128> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > 18
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let whole: i128 = whole.parse().ok()?;
    let mut padded_fraction = fraction.to_owned();
    padded_fraction.push_str(&"0".repeat(18 - fraction.len()));
    let fraction: i128 = padded_fraction.parse().ok()?;
    whole
        .checked_mul(DECIMAL_SCALE)?
        .checked_add(fraction)
}

impl Storage {
    pub fn usage_analytics(&self, request: &Value) -> Result<Value, StorageError> {
        let parse_utc = |value: &Value| {
            value
                .as_str()
                .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
                .filter(|value| value.offset().local_minus_utc() == 0)
                .map(|value| value.with_timezone(&Utc))
        };
        let from = parse_utc(&request["from"]).ok_or(StorageError::InvalidAnalytics)?;
        let to = parse_utc(&request["to"]).ok_or(StorageError::InvalidAnalytics)?;
        if from >= to || to.signed_duration_since(from) > Duration::days(400) { return Err(StorageError::InvalidAnalytics); }
        let bucket = request["bucket"].as_str().filter(|s| *s == "day" || *s == "week").ok_or(StorageError::InvalidAnalytics)?;
        let tz_name = request["tz"].as_str().filter(|s| !s.is_empty()).ok_or(StorageError::InvalidAnalytics)?;
        let tz: Tz = tz_name.parse().map_err(|_| StorageError::InvalidAnalytics)?;
        let project_filter = request["projectPath"].as_str().map(normalize_project_path);
        let agent_filter = request["agentId"].as_str();
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        if let Some(agent_id) = agent_filter {
            if !c.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [agent_id], |r| r.get::<_, bool>(0))? {
                return Err(StorageError::AgentNotFound);
            }
        }
        let mut buckets = analytics_bucket_starts(from, to, tz, bucket)?;
        let mut totals = AnalyticsAccumulator::default();
        let mut series: Vec<(DateTime<Utc>, AnalyticsAccumulator)> = buckets.drain(..).map(|start| (start, AnalyticsAccumulator::default())).collect();
        let mut leaders: std::collections::BTreeMap<(Option<String>, String), (Option<String>, AnalyticsAccumulator)> = std::collections::BTreeMap::new();
        let mut errors = Vec::new();
        let mut query = c.prepare("SELECT t.id,t.session_id,t.state,t.created_at,t.started_at,t.completed_at,COALESCE(t.failure_class_v2,t.failure_class),s.agent_id,s.project_path,s.runtime_id,COALESCE(a.name,'') FROM turns t JOIN sessions s ON s.id=t.session_id LEFT JOIN agents a ON a.id=s.agent_id ORDER BY COALESCE(t.completed_at,t.started_at,t.created_at)")?;
        let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, String>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?)))?.collect::<Result<Vec<_>, _>>()?;
        for (turn_id, session_id, state, created, started, completed, failure_class, agent_id, project_path, runtime_id, agent_name) in rows {
            if agent_filter.is_some_and(|filter| agent_id.as_deref() != Some(filter)) { continue; }
            if project_filter.as_deref().is_some_and(|filter| normalize_project_path(&project_path) != filter) { continue; }
            let at_text = completed.as_deref().or(started.as_deref()).unwrap_or(&created);
            let Some(at) = DateTime::parse_from_rfc3339(at_text).ok().map(|v| v.with_timezone(&Utc)) else { continue; };
            if at < from || at >= to { continue; }
            let mut turn = AnalyticsAccumulator::default();
            turn.add_run(&state, started.as_deref(), completed.as_deref());
            let mut usage = c.prepare("SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,usage_status FROM usage_events WHERE turn_id=?1 ORDER BY timestamp,rowid")?;
            let usage_rows = usage.query_map([&turn_id], |row| Ok((row.get::<_, Option<i64>>(0)?,row.get::<_, Option<i64>>(1)?,row.get::<_, Option<i64>>(2)?,row.get::<_, Option<i64>>(3)?,row.get::<_, Option<i64>>(4)?,row.get::<_, String>(5)?)))?.collect::<Result<Vec<_>, _>>()?;
            let mut reported = false;
            for (input, output, read, write, reasoning, usage_status) in usage_rows {
                if !matches!(usage_status.as_str(), "reported" | "partial") { continue; }
                reported = true;
                if usage_status == "partial" { turn.tokens_lower_bound = true; }
                turn.add_tokens([input, output, read, write, reasoning]);
            }
            if !reported { turn.unreported_runs = 1; turn.tokens_lower_bound = true; }
            totals.merge(&turn);
            let local_date = at.with_timezone(&tz).date_naive();
            let bucket_start = analytics_bucket_start(local_date, tz, bucket)?;
            if let Some((_, metrics)) = series.iter_mut().find(|(start, _)| *start == bucket_start) { metrics.merge(&turn); }
            let key = (agent_id.clone(), runtime_id.clone());
            let leader = leaders.entry(key).or_insert_with(|| (if agent_name.is_empty() { None } else { Some(agent_name.clone()) }, AnalyticsAccumulator::default()));
            leader.1.merge(&turn);
            if matches!(state.as_str(), "error" | "cancelled") {
                let class = analytics_failure_class(failure_class.as_deref());
                errors.push(json!({"turnId":turn_id,"sessionId":session_id,"agentId":agent_id,"at":at.to_rfc3339_opts(SecondsFormat::Millis,true),"message":analytics_failure_message(class),"failureClass":class}));
            }
        }
        errors.sort_by(|a, b| b["at"].as_str().cmp(&a["at"].as_str()));
        errors.truncate(50);
        let mut leaderboard = leaders.into_iter().map(|((agent_id, runtime_id), (agent_name, metrics))| analytics_leader(agent_id, agent_name, runtime_id, metrics)).collect::<Vec<_>>();
        leaderboard.sort_by(|a, b| {
            let token_order = match (a["tokens"]["total"].as_i64(), b["tokens"]["total"].as_i64()) {
                (Some(left), Some(right)) => right.cmp(&left),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            };
            token_order.then_with(|| b["runs"].as_u64().cmp(&a["runs"].as_u64()))
        });
        Ok(json!({"range":{"from":from.to_rfc3339_opts(SecondsFormat::Millis,true),"to":to.to_rfc3339_opts(SecondsFormat::Millis,true),"bucket":bucket,"tz":tz_name},"totals":totals.totals_json(),"series":series.into_iter().map(|(start,metrics)|{let mut item=metrics.point_json();item["bucketStart"]=json!(start.to_rfc3339_opts(SecondsFormat::Millis,true));item}).collect::<Vec<_>>(),"leaderboard":leaderboard,"errors":errors,"subscriptions":[]}))
    }
}

#[cfg(test)]
fn decimal_to_minor(value: &str, currency: &str) -> Option<i64> {
    bloblex_usage::major_currency_decimal_to_minor(value, currency)
}
#[cfg(test)]
fn format_decimal_units(value: i128) -> String {
    let whole = value / DECIMAL_SCALE;
    let fraction = value % DECIMAL_SCALE;
    if fraction == 0 { return whole.to_string(); }
    let fraction = format!("{fraction:018}").trim_end_matches('0').to_owned();
    format!("{whole}.{fraction}")
}
fn nullable(v:&Value)->Option<&str>{ if v.is_null(){None}else{v.as_str()} }
fn trimmed(v:&Value,key:&str)->String{v[key].as_str().unwrap_or("").trim().to_owned()}
fn validate_agent_fields(v:&Value,create:bool)->Result<(),StorageError>{
    for key in ["name","runtimeId","description","instructions","color"] {if v.get(key).is_some_and(|x|!x.is_string()){return Err(StorageError::InvalidAgent)}}
    if v.get("customArgs").is_some_and(|x|!x.is_array()||!x.as_array().unwrap().is_empty())||v.get("customEnv").is_some_and(|x|!x.is_object()||!x.as_object().unwrap().values().all(Value::is_string))||v.get("maxConcurrency").is_some_and(|x|!x.as_i64().is_some_and(|n|(1..=50).contains(&n))){return Err(StorageError::InvalidAgent)}
    for key in ["model","thinking","serviceTier","defaultProject","approvalMode"] { if v.get(key).is_some_and(|x|!x.is_null()&&!x.is_string()){return Err(StorageError::InvalidAgent)} }
    if v.get("approvalMode").and_then(Value::as_str).is_some_and(|s| !["ask","auto","bypass"].contains(&s)){return Err(StorageError::InvalidAgent)}
    if v.get("notificationLevel").is_some_and(|x| !x.is_null() && !x.as_str().is_some_and(|s| ["all","input","muted"].contains(&s))){return Err(StorageError::InvalidAgent)}
    if v.get("outfit").is_some_and(|value| !value.as_str().is_some_and(|s| ["auto","none","party-hat","beanie","crown","sunglasses","round-glasses","bow","scarf","witch-hat","santa-hat","pumpkin","bunny-ears"].contains(&s))) { return Err(StorageError::InvalidAgent); }
    if v.get("look").is_some_and(|look| !look.is_null() && !valid_look(look)) { return Err(StorageError::InvalidAgent); }
    if create && (!v["name"].is_string()||!v["runtimeId"].is_string()){return Err(StorageError::InvalidAgent)}
    if let Some(name)=v["name"].as_str(){let n=name.trim();if n.chars().count()==0||n.chars().count()>60{return Err(StorageError::InvalidAgent)}}
    if v["description"].as_str().is_some_and(|x|x.chars().count()>255)||v["instructions"].as_str().is_some_and(|x|x.contains('\0')){return Err(StorageError::InvalidAgent)}
    if let Some(color)=v["color"].as_str(){let named=["coral","orange","amber","lemon","lime","mint","teal","cyan","sky","blue","violet","pink"].contains(&color);let b=color.as_bytes();let hex=b.len()==7&&b[0]==b'#'&&b[1..].iter().all(u8::is_ascii_hexdigit);if !named&&!hex{return Err(StorageError::InvalidAgent)}}
    if let Some(env)=v["customEnv"].as_object(){for(k,val)in env{let valid=!k.is_empty()&&k.chars().enumerate().all(|(i,c)|if i==0{c=='_'||c.is_ascii_alphabetic()}else{c=='_'||c.is_ascii_alphanumeric()});let upper=k.to_ascii_uppercase();if !valid||!["LANG","LC_ALL","TZ","NO_COLOR","TERM"].contains(&upper.as_str())||["TOKEN","SECRET","PASSWORD","PASSWD","KEY","AUTH","CREDENTIAL","COOKIE"].iter().any(|needle|upper.contains(needle))||val.as_str().is_none_or(|s|s.contains('\0')){return Err(StorageError::InvalidAgent)}}}
    Ok(())
}
/// A blob look: one of the silhouette names, an optional seed and up to 48
/// pinned trait positions in [0, 1]. Kept small so it travels in every snapshot.
fn valid_look(look: &Value) -> bool {
    const SHAPES: [&str; 10] = ["round","organic","boxy","capsule","cloud","droplet","hexagon","sun","triangle","cat"];
    let Some(object) = look.as_object() else { return false };
    if object.keys().any(|key| !["shape","seed","traits","bot"].contains(&key.as_str())) { return false; }
    // Bitbots theme styling: a robot outline and three colours, all optional.
    if let Some(bot) = object.get("bot").filter(|bot| !bot.is_null()) {
        let Some(bot) = bot.as_object() else { return false };
        const BOT_SHAPES: [&str; 4] = ["rectangle","square","circle","hexagon"];
        if bot.keys().any(|key| !["shape","shell","trim","screen"].contains(&key.as_str())) { return false; }
        if bot.get("shape").is_some_and(|shape| !shape.as_str().is_some_and(|shape| BOT_SHAPES.contains(&shape))) { return false; }
        for key in ["shell","trim","screen"] {
            let ok = bot.get(key).is_none_or(|color| color.as_str().is_some_and(|color| color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())));
            if !ok { return false; }
        }
    }
    if !object.get("shape").and_then(Value::as_str).is_some_and(|shape| SHAPES.contains(&shape)) { return false; }
    if object.get("seed").is_some_and(|seed| !seed.is_null() && !seed.as_str().is_some_and(|seed| !seed.trim().is_empty() && seed.chars().count() <= 80 && !seed.contains(' '))) { return false; }
    if let Some(traits) = object.get("traits").filter(|traits| !traits.is_null()) {
        let Some(traits) = traits.as_object() else { return false };
        if traits.len() > 48 { return false; }
        for (key, position) in traits {
            let key_ok = !key.is_empty() && key.len() <= 32 && key.starts_with(|c: char| c.is_ascii_lowercase()) && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.');
            if !key_ok || !position.as_f64().is_some_and(|value| (0.0..=1.0).contains(&value)) { return false; }
        }
    }
    true
}
fn look_column(look: &Value) -> Option<String> { (!look.is_null()).then(|| look.to_string()) }
const DETAIL_TEXT_LIMIT: usize = 4000;

fn clip_text(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit { return text.to_owned(); }
    format!("{}…", text.chars().take(limit).collect::<String>())
}

/// Text from a provider value: a string, or the `text` parts of a content list.
fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let joined = parts.iter().filter_map(|part| part["text"].as_str().or_else(|| part["content"]["text"].as_str()).or_else(|| part.as_str())).collect::<Vec<_>>().join("\n");
            (!joined.trim().is_empty()).then_some(joined)
        }
        Value::Object(object) => object.get("text").and_then(Value::as_str).map(str::to_owned)
            .or_else(|| object.get("content").and_then(value_text))
            .or_else(|| object.get("output").and_then(value_text))
            .or_else(|| object.get("stdout").and_then(value_text)),
        _ => None,
    }
}

/// A small, provider-neutral description of one tool call for the UI: the
/// command and its output, the tool and its arguments/result, the search
/// query or the path. Raw provider payloads stay in the daemon; every text
/// is clipped, so a long output cannot bloat the snapshot.
pub fn tool_detail(kind: &str, raw: &Value) -> Value {
    let mut detail = serde_json::Map::new();
    let mut put = |key: &str, value: Option<String>| {
        if let Some(text) = value.map(|text| clip_text(&text, DETAIL_TEXT_LIMIT)).filter(|text| !text.is_empty()) { detail.insert(key.into(), json!(text)); }
    };
    let command = raw["command"].as_str().map(str::to_owned)
        .or_else(|| raw["command"].as_array().map(|parts| parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")))
        .or_else(|| raw["input"]["command"].as_str().map(str::to_owned))
        .or_else(|| raw["rawInput"]["command"].as_str().map(str::to_owned));
    put("command", command);
    put("output", value_text(&raw["aggregatedOutput"]).or_else(|| value_text(&raw["output"])).or_else(|| value_text(&raw["rawOutput"])).or_else(|| raw["outputDelta"].as_str().map(str::to_owned)).or_else(|| if raw["type"] == "tool_result" { value_text(&raw["content"]) } else { None }));
    let tool = raw["tool"].as_str().or(raw["name"].as_str()).map(|name| match raw["server"].as_str().or(raw["namespace"].as_str()) { Some(server) if !server.is_empty() => format!("{server} · {name}"), _ => name.to_owned() });
    put("tool", tool);
    let arguments = [&raw["arguments"], &raw["input"], &raw["rawInput"]].into_iter().find(|value| value.is_object() && !value.as_object().unwrap().is_empty())
        .map(|value| serde_json::to_string_pretty(value).unwrap_or_default());
    put("input", arguments.map(|text| clip_text(&text, 1500)));
    put("result", value_text(&raw["result"]).or_else(|| value_text(&raw["contentItems"])));
    put("progress", raw["progress"].as_str().or(raw["message"].as_str()).map(str::to_owned));
    put("query", raw["query"].as_str().or(raw["action"]["query"].as_str()).map(str::to_owned));
    put("path", raw["path"].as_str().or(raw["input"]["file_path"].as_str()).or(raw["input"]["path"].as_str()).or(raw["changes"][0]["path"].as_str()).or(raw["locations"][0]["path"].as_str()).map(str::to_owned));
    put("error", raw["error"]["message"].as_str().or(raw["error"].as_str()).map(str::to_owned).or_else(|| if raw["is_error"] == true { value_text(&raw["content"]) } else { None }));
    if let Some(code) = raw["exitCode"].as_i64() { detail.insert("exitCode".into(), json!(code)); }
    if let Some(status) = raw["status"].as_str().filter(|status| matches!(*status, "inProgress" | "completed" | "failed" | "declined")) { detail.insert("resultStatus".into(), json!(status)); }
    if let Some(success) = raw["success"].as_bool() { detail.insert("success".into(), json!(success)); }
    if !detail.is_empty() { detail.insert("kind".into(), json!(kind)); }
    Value::Object(detail)
}

/// Path, change kind and a diff excerpt for one changed file.
pub fn file_detail(path: &str, raw: &Value) -> Value {
    let change = raw["changes"].as_array().and_then(|changes| changes.iter().find(|change| change["path"].as_str() == Some(path)).or(changes.first())).cloned().unwrap_or(Value::Null);
    let mut detail = json!({"path": path});
    if let Some(kind) = change["kind"].as_str().or(change["kind"]["type"].as_str()).or(raw["kind"].as_str()) { detail["change"] = json!(kind); }
    if let Some(diff) = change["diff"].as_str().or(change["unified_diff"].as_str()).or(raw["diff"].as_str()) { let clipped = diff.chars().count() > DETAIL_TEXT_LIMIT;
        detail["diff"] = json!(if clipped { clip_text(diff, DETAIL_TEXT_LIMIT) } else { diff.to_owned() });
        if clipped || ["clipped", "truncated", "incomplete", "diffClipped"].iter().any(|key| change[*key] == true || raw[*key] == true) || change["complete"] == false || raw["complete"] == false { detail["diffClipped"] = json!(true); } }
    detail
}

fn runtime_exists(c:&Connection,id:&str)->Result<bool,StorageError>{Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM runtimes WHERE id=?1)",[id],|r|r.get(0))?)}
fn ensure_name_free(c:&Connection,key:&str,except:Option<&str>)->Result<(),StorageError>{let n:i64=c.query_row("SELECT count(*) FROM agents WHERE name_key=?1 AND archived=0 AND (?2 IS NULL OR id!=?2)",params![key,except],|r|r.get(0))?;if n>0{Err(StorageError::AgentConflict)}else{Ok(())}}
fn project_rows(c: &Connection) -> Result<Vec<Value>, StorageError> {
    query_jsons(c, "SELECT json_object('id',id,'name',name,'path',path,'sortOrder',sort_order,'collapsed',json(CASE WHEN collapsed=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at) FROM projects WHERE ?1=?1 ORDER BY sort_order,created_at,id", "")
}
fn push_team_event(tx: &Transaction<'_>, event_type: &str, payload: &Value) -> Result<Value, StorageError> {
    let id = Uuid::new_v4().to_string();
    let ts = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,?3,?4)", params![id, ts, event_type, payload.to_string()])?;
    Ok(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":event_type,"payload":payload}))
}
fn agent_read(c:&Connection,id:&str)->Result<Value,StorageError>{let raw:Option<String>=c.query_row("SELECT json_object('id',id,'name',name,'description',description,'instructions',instructions,'color',color,'outfit',outfit,'runtimeId',runtime_id,'model',model,'thinking',thinking,'serviceTier',service_tier,'approvalMode',approval_mode,'effectiveApprovalMode',COALESCE(approval_mode,(SELECT json_extract(value,'$') FROM settings WHERE key='permissions.default_mode'),'ask'),'customArgs',json(custom_args),'customEnv',json(custom_env),'maxConcurrency',max_concurrency,'defaultProject',default_project,'sortOrder',sort_order,'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at,'projectId',project_id,'role',role,'leader',json(CASE WHEN leader=1 THEN 'true' ELSE 'false' END),'hidden',json(CASE WHEN hidden=1 THEN 'true' ELSE 'false' END),'look',json(look),'notificationLevel',COALESCE(notification_level,'all')) FROM agents WHERE id=?1",[id],|r|r.get(0)).optional()?;Ok(serde_json::from_str(&raw.ok_or(StorageError::AgentNotFound)?)?)}
fn insert_agent(tx:&Transaction<'_>,id:&str,v:&Value,name:&str,key:&str,pos:i64,now:&str)->Result<(),StorageError>{let color=v["color"].as_str().unwrap_or("mint");let color=if color.starts_with('#'){color.to_ascii_uppercase()}else{color.into()};tx.execute("INSERT INTO agents(id,name,name_key,description,instructions,color,outfit,runtime_id,model,thinking,service_tier,approval_mode,custom_args,custom_env,max_concurrency,default_project,sort_order,archived,created_at,updated_at,notification_level) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,0,?18,?18,?19)",params![id,name,key,v["description"].as_str().unwrap_or(""),v["instructions"].as_str().unwrap_or(""),color,v["outfit"].as_str().unwrap_or("auto"),v["runtimeId"].as_str().unwrap_or(""),nullable(&v["model"]),nullable(&v["thinking"]),nullable(&v["serviceTier"]),nullable(&v["approvalMode"]),v.get("customArgs").cloned().unwrap_or(json!([])).to_string(),v.get("customEnv").cloned().unwrap_or(json!({})).to_string(),v["maxConcurrency"].as_i64().unwrap_or(1),nullable(&v["defaultProject"]),pos,now,nullable(&v["notificationLevel"])])?;tx.execute("UPDATE agents SET look=?2 WHERE id=?1",params![id,look_column(&v["look"])])?;Ok(())}
fn push_agent_event(tx:&Transaction<'_>,action:&str,a:&Value)->Result<Value,StorageError>{let payload=json!({"action":action,"agentId":a["id"],"runtimeId":a["runtimeId"],"updatedAt":a["updatedAt"],"archived":a["archived"],"sortOrder":a["sortOrder"],"notificationLevel":a["notificationLevel"]});let id=Uuid::new_v4().to_string();let ts=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'agent.changed',?3)",params![id,ts,payload.to_string()])?;Ok(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":"agent.changed","payload":payload}))}
fn snapshot_requested(v:&Value)->Value{
    let mut result=json!({"model":v["model"],"thinking":v["thinking"],"serviceTier":v["serviceTier"],"approvalMode":v["approvalMode"],"instructionsPresent":v["instructionsPresent"].as_bool().unwrap_or(false),"extraArgs":[],"maxConcurrency":v["maxConcurrency"].as_u64().unwrap_or(1)});
    if let Some(keys)=v["customEnvKeys"].as_array(){result["envKeys"]=json!(keys.iter().filter_map(Value::as_str).collect::<Vec<_>>());}
    result
}
fn snapshot_outcomes(v:&Value)->Value{
    let mut out=serde_json::Map::new();for key in ["model","thinking","serviceTier","approvalMode","instructions","customEnv"]{if let Some(item)=v.get(key){let value=if key=="instructions"||key=="customEnv"{Value::Null}else{item["appliedValue"].as_str().or_else(||item["value"].as_str()).or_else(||item["evidenceValue"].as_str()).map(|s|json!(s.chars().take(256).collect::<String>())).unwrap_or_else(||item["value"].clone())};out.insert(key.into(),json!({"applied":item["applied"].as_bool(),"value":value}));}}Value::Object(out)
}
fn snapshot_evidence(v:&Value)->Value{
    let mut out=serde_json::Map::new();for key in ["model","thinking","serviceTier","approvalMode","instructions","customEnv"]{if let Some(item)=v.get(key){let raw=item.get("value").or_else(||item.get("evidenceValue")).unwrap_or(&Value::Null);let value=match raw{Value::String(s)=>json!(s.chars().take(256).collect::<String>()),Value::Number(_)|Value::Bool(_)=>raw.clone(),_=>Value::Null};let mut evidence=json!({"kind":item["kind"].as_str().or_else(||item["evidenceKind"].as_str()),"value":value});if let Some(reason)=item["reason"].as_str(){evidence["reason"]=json!(reason.chars().take(160).collect::<String>());}out.insert(key.into(),evidence);}}Value::Object(out)
}
fn snapshot_flags(v:&Value)->Value{json!({"adapter":v["adapter"].as_str(),"version":v["version"].as_str(),"gates":v["gates"].as_object().map(|m|m.iter().filter_map(|(k,v)|v.as_bool().map(|b|(k.clone(),json!(b)))).collect::<serde_json::Map<String,Value>>()).unwrap_or_default()})}
fn exec_snapshot_read(c:&Connection,id:&str)->Result<Option<Value>,StorageError>{
    let row:Option<String>=c.query_row("SELECT json_object('id',id,'sessionId',session_id,'turnId',turn_id,'agentId',agent_id,'runtimeId',runtime_id,'provider',provider,'createdAt',created_at,'requested',json(requested_json),'applied',json(applied_json),'evidence',json(evidence_json),'instructionSha256',instruction_sha256,'adapterFlags',json(adapter_flags_json),'status',status) FROM exec_snapshots WHERE id=?1",[id],|r|r.get(0)).optional()?;
    row.map(|s|serde_json::from_str(&s).map_err(StorageError::from)).transpose()
}
fn active_ids(c:&Connection,rt:&str)->Result<Vec<String>,StorageError>{let mut q=c.prepare("SELECT id FROM agents WHERE runtime_id=?1 AND archived=0 ORDER BY sort_order")?;let rows=q.query_map([rt],|r|r.get(0))?.collect::<Result<Vec<_>,_>>()?;Ok(rows)}
fn active_order(c:&Connection,rt:&str)->Result<Vec<Value>,StorageError>{let ids=active_ids(c,rt)?;ids.iter().map(|id|agent_read(c,id)).collect()}
fn shift_active(tx:&Transaction<'_>,rt:&str)->Result<(),StorageError>{tx.execute("UPDATE agents SET sort_order=sort_order+1000000 WHERE runtime_id=?1 AND archived=0",[rt])?;Ok(())}
fn shift_active_except(tx:&Transaction<'_>,rt:&str,excluded:&str)->Result<(),StorageError>{tx.execute("UPDATE agents SET sort_order=sort_order+1000000 WHERE runtime_id=?1 AND archived=0 AND id!=?2",params![rt,excluded])?;Ok(())}
fn assign_active_order(tx:&Transaction<'_>,ids:&[String],before:&[Value],now:&str)->Result<(),StorageError>{for(i,id)in ids.iter().enumerate(){let old=before.iter().find(|a|a["id"].as_str()==Some(id.as_str()));let changed=old.and_then(|a|a["sortOrder"].as_i64())!=Some(i as i64);let updated=if changed{now}else{old.and_then(|a|a["updatedAt"].as_str()).unwrap_or(now)};tx.execute("UPDATE agents SET sort_order=?2,updated_at=?3 WHERE id=?1",params![id,i as i64,updated])?;}Ok(())}
fn changed_agents(tx:&Transaction<'_>,rt:&str)->Result<Vec<Value>,StorageError>{active_order(tx,rt)}

#[cfg(test)]
fn period_start(now: &chrono::DateTime<Utc>, period: &str) -> String {
    let date = now.date_naive();
    let start = match period {
        "day" | "daily" => date,
        "week" | "weekly" => date - Duration::days(date.weekday().num_days_from_monday() as i64),
        "month" | "monthly" => date.with_day(1).unwrap_or(date),
        "year" | "yearly" => date.with_ordinal(1).unwrap_or(date),
        _ => chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap(),
    };
    format!("{start}T00:00:00Z")
}

#[cfg(test)]
fn budget_totals_locked(
    c: &Connection,
    policy_id: &str,
    period: &str,
    scope_type: &str,
    scope_id: Option<&str>,
) -> Result<(i64, i64), rusqlite::Error> {
    let start = period_start(&Utc::now(), period);
    if scope_type == "blob" {
        let agent = scope_id.unwrap_or("");
        if period == "turn" {
            return c.query_row(
                "SELECT COALESCE(SUM(CASE WHEN br.status='reconciled' THEN COALESCE(br.reconciled_amount,br.amount) ELSE 0 END),0),COALESCE(SUM(CASE WHEN br.status='active' THEN br.amount ELSE 0 END),0) FROM budget_reservations br JOIN turns t ON t.id=br.turn_id JOIN sessions s ON s.id=t.session_id WHERE br.policy_id=?1 AND s.agent_id=?2 AND br.turn_id=(SELECT br2.turn_id FROM budget_reservations br2 JOIN turns t2 ON t2.id=br2.turn_id JOIN sessions s2 ON s2.id=t2.session_id WHERE br2.policy_id=?1 AND s2.agent_id=?2 ORDER BY br2.created_at DESC,br2.rowid DESC LIMIT 1)",
                params![policy_id, agent], |r| Ok((r.get(0)?, r.get(1)?)),
            );
        }
        return c.query_row(
            "SELECT COALESCE(SUM(CASE WHEN br.status='reconciled' THEN COALESCE(br.reconciled_amount,br.amount) ELSE 0 END),0),COALESCE(SUM(CASE WHEN br.status='active' THEN br.amount ELSE 0 END),0) FROM budget_reservations br JOIN turns t ON t.id=br.turn_id JOIN sessions s ON s.id=t.session_id WHERE br.policy_id=?1 AND s.agent_id=?2 AND br.created_at>=?3",
            params![policy_id, agent, start], |r| Ok((r.get(0)?, r.get(1)?)),
        );
    }
    if period == "turn" {
        c.query_row(
            "SELECT COALESCE(SUM(CASE WHEN status='reconciled' THEN COALESCE(reconciled_amount,amount) ELSE 0 END),0),COALESCE(SUM(CASE WHEN status='active' THEN amount ELSE 0 END),0) FROM budget_reservations WHERE policy_id=?1 AND turn_id=(SELECT turn_id FROM budget_reservations WHERE policy_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1)",
            [policy_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    } else {
        c.query_row(
            "SELECT COALESCE(SUM(CASE WHEN status='reconciled' THEN COALESCE(reconciled_amount,amount) ELSE 0 END),0),COALESCE(SUM(CASE WHEN status='active' THEN amount ELSE 0 END),0) FROM budget_reservations WHERE policy_id=?1 AND created_at>=?2",
            params![policy_id, start],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }
}

fn query_column_json(c: &Connection, sql: &str, id: &str) -> Result<Vec<Value>, StorageError> {
    let mut s = c.prepare(sql)?;
    let raw = if sql.contains("?1") {
        s.query_map([id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        s.query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    raw.into_iter()
        .map(|x| Ok(serde_json::from_str(&x)?))
        .collect()
}
fn query_jsons(c: &Connection, sql: &str, id: &str) -> Result<Vec<Value>, StorageError> {
    query_column_json(c, sql, id)
}
#[cfg(test)]
mod pricing_override_removal_tests {
    use super::{decimal_to_minor, Storage, StorageError};
    use rusqlite::Connection;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn lists_user_overrides_only_and_ignores_legacy_shipped_rows() {
        let db = Storage::open_in_memory().unwrap();
        {
            let connection = db.conn.lock().unwrap();
            connection.execute(
                "INSERT INTO pricing_rules(id,provider,model,currency,input_per_million,output_per_million,effective_from,aliases) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                rusqlite::params!["shipped-1", "codex", "model-a", "USD", 50, 100, "2026-01-01T00:00:00Z", "[]"],
            ).unwrap();
        }
        db.save_pricing(&json!({
            "id": "override-1",
            "provider": "codex",
            "canonicalModelId": "model-a",
            "aliases": ["alias-a"],
            "inputPerMillion": "1.00",
            "outputPerMillion": null,
            "cacheReadPerMillion": null,
            "cacheWritePerMillion": null,
            "currency": "USD",
            "effectiveFrom": "2026-10-01T00:00:00Z"
        })).unwrap();
        let listed = db.pricing_list(None).unwrap();
        assert_eq!(listed["rules"].as_array().unwrap().len(), 1);
        assert_eq!(listed["rules"][0]["source"], "user_override");

        db.save_pricing(&json!({
            "id": "override-1",
            "provider": "claude",
            "canonicalModelId": "model-b",
            "aliases": ["alias-b"],
            "inputPerMillion": "2.50",
            "outputPerMillion": "5.00",
            "cacheReadPerMillion": null,
            "cacheWritePerMillion": null,
            "currency": "EUR",
            "effectiveFrom": "2026-10-02T00:00:00Z"
        })).unwrap();
        assert_eq!(db.pricing_list(Some("codex")).unwrap()["rules"].as_array().unwrap().len(), 0);
        let edited = db.pricing_list(Some("claude")).unwrap();
        assert_eq!(edited["rules"].as_array().unwrap().len(), 1);
        assert_eq!(edited["rules"][0]["canonicalModelId"], "model-b");
        assert_eq!(edited["rules"][0]["inputPerMillion"], "2.50");
        assert_eq!(edited["rules"][0]["currency"], "EUR");
        assert_eq!(edited["rules"][0]["aliases"][0], "alias-b");

        assert!(matches!(
            db.save_pricing(&json!({ "id": "", "remove": true })),
            Err(StorageError::InvalidPricing)
        ));
        assert!(matches!(
            db.save_pricing(&json!({ "id": "  ", "remove": true })),
            Err(StorageError::InvalidPricing)
        ));
        db.save_pricing(&json!({ "id": "override-1", "remove": true })).unwrap();
        let remaining = db.pricing_list(None).unwrap();
        assert_eq!(remaining["rules"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn reported_decimal_costs_use_the_shared_half_up_minor_unit_rounder() {
        assert_eq!(decimal_to_minor("0.005", "USD"), Some(1));
        assert_eq!(decimal_to_minor("0.015", "USD"), Some(2));
        assert_eq!(decimal_to_minor("1.5", "JPY"), Some(2));
    }
    #[test]
    fn v7_integer_minor_rate_overrides_migrate_losslessly_to_decimal_strings() {
        let dir = std::env::temp_dir().join(format!("bloblex-price-override-v8-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        drop(Storage::open(&path).unwrap());
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE IF EXISTS message_reactions; DROP INDEX IF EXISTS idx_messages_session_id_id; ALTER TABLE sessions DROP COLUMN model_lock_json; DROP TABLE IF EXISTS quota_snapshots; DROP TABLE user_pricing_rules; CREATE TABLE user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate INTEGER,output_rate INTEGER,cache_read_rate INTEGER,cache_write_rate INTEGER,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL); DELETE FROM schema_migrations WHERE version IN (8,9,10,11,12); PRAGMA user_version=7;").unwrap();
            c.execute("INSERT INTO user_pricing_rules(id,provider,model,aliases,input_rate,output_rate,cache_read_rate,cache_write_rate,currency,effective_from,data) VALUES('old-usd','codex','gpt-old','[]',3,125,0,NULL,'USD','2026-10-01T00:00:00Z',?1)", [r#"{"id":"old-usd","provider":"codex","canonicalModelId":"gpt-old","aliases":[],"inputPerMillion":3,"outputPerMillion":125,"cacheReadPerMillion":0,"cacheWritePerMillion":null,"currency":"USD","effectiveFrom":"2026-10-01T00:00:00Z"}"#]).unwrap();
            c.execute("INSERT INTO user_pricing_rules(id,provider,model,aliases,input_rate,output_rate,cache_read_rate,cache_write_rate,currency,effective_from,data) VALUES('old-kwd','opencode','model-kwd','[]',3,NULL,NULL,NULL,'KWD','2026-10-01T00:00:00Z',?1)", [r#"{"id":"old-kwd","provider":"opencode","canonicalModelId":"model-kwd","aliases":[],"inputPerMillion":3,"outputPerMillion":null,"cacheReadPerMillion":null,"cacheWritePerMillion":null,"currency":"KWD","effectiveFrom":"2026-10-01T00:00:00Z"}"#]).unwrap();
        }
        let db = Storage::open(&path).unwrap();
        let listed = db.pricing_list(None).unwrap();
        let rules = listed["rules"].as_array().unwrap();
        let usd = rules.iter().find(|rule| rule["id"] == "old-usd").unwrap();
        assert_eq!(usd["inputPerMillion"], "0.03");
        assert_eq!(usd["outputPerMillion"], "1.25");
        assert_eq!(usd["cacheReadPerMillion"], "0");
        let kwd = rules.iter().find(|rule| rule["id"] == "old-kwd").unwrap();
        assert_eq!(kwd["inputPerMillion"], "0.003");
        let c = db.conn.lock().unwrap();
        assert_eq!(c.query_row("SELECT typeof(input_rate) FROM user_pricing_rules WHERE id='old-usd'", [], |r| r.get::<_, String>(0)).unwrap(), "text");
        assert!(!c.query_row("SELECT applied_at FROM schema_migrations WHERE version=7", [], |r| r.get::<_, String>(0)).unwrap().is_empty());
        assert!(c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='outfit')", [], |r| r.get::<_, bool>(0)).unwrap());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version=8", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
            assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
        drop(c);
        drop(db);
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn remove_session_controls_migration(c: &Connection) {
        c.execute_batch("DROP TABLE IF EXISTS message_reactions; DROP INDEX IF EXISTS idx_messages_session_id_id; ALTER TABLE sessions DROP COLUMN model_lock_json; DROP TABLE IF EXISTS quota_snapshots; DELETE FROM schema_migrations WHERE version IN (6,7,8,9,10,11,12); PRAGMA user_version=5; ALTER TABLE sessions DROP COLUMN archived; ALTER TABLE sessions DROP COLUMN title_override; ALTER TABLE agents DROP COLUMN outfit; DROP TABLE user_pricing_rules; CREATE TABLE user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate INTEGER,output_rate INTEGER,cache_read_rate INTEGER,cache_write_rate INTEGER,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL);").unwrap();
    }
    #[test]
    fn quota_cache_migration_preserves_v9_history_and_keeps_last_good_on_failure() {
        let root = std::env::temp_dir().join(format!("bloblex-quota-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-codex","provider":"codex"})).unwrap();
            db.create_session("s-history", "rt-codex", "codex", ".", "History").unwrap();
            db.create_turn("t-history", "s-history").unwrap();
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO budget_policies(id,scope_type,period,metric,hard_limit,created_at) VALUES('old-budget','global','month','tokens',100,?1)", [Utc::now().to_rfc3339()]).unwrap();
            conn.execute("INSERT INTO pricing_rules(id,provider,model,currency,input_per_million,effective_from) VALUES('old-price','codex','old-model','USD',123,'2026-01-01')", []).unwrap();
            conn.execute("INSERT INTO subscription_plans(id,provider,currency,monthly_minor,data) VALUES('old-sub','codex','USD',2000,'{}')", []).unwrap();
            conn.execute("INSERT INTO usage_events(id,runtime_id,session_id,turn_id,provider,model,timestamp,input_tokens,reported_cost_minor,reported_currency,source,raw) VALUES('old-usage','rt-codex','s-history','t-history','codex','old-model','2026-01-02T00:00:00Z',9,77,'USD','terminal','{}')", []).unwrap();
            conn.execute("INSERT INTO usage_valuations(usage_event_id,basis,amount_minor,currency,status,valued_at) VALUES('old-usage','api_rate_estimate',55,'USD','estimated','2026-01-02T00:00:00Z')", []).unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("DROP TABLE message_reactions; DROP INDEX idx_messages_session_id_id; ALTER TABLE sessions DROP COLUMN model_lock_json; DROP TABLE quota_snapshots; DELETE FROM schema_migrations WHERE version IN (10,11,12); PRAGMA user_version=9;").unwrap();
            assert!(schema_v9_valid(&conn).unwrap());
        }
        let _ = fs::remove_dir_all(root.join("backups"));
        {
            let db = Storage::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
            assert_eq!(conn.query_row("SELECT hard_limit FROM budget_policies WHERE id='old-budget'", [], |r| r.get::<_, i64>(0)).unwrap(), 100);
            assert_eq!(conn.query_row("SELECT input_per_million FROM pricing_rules WHERE id='old-price'", [], |r| r.get::<_, i64>(0)).unwrap(), 123);
            assert_eq!(conn.query_row("SELECT monthly_minor FROM subscription_plans WHERE id='old-sub'", [], |r| r.get::<_, i64>(0)).unwrap(), 2000);
            assert_eq!(conn.query_row("SELECT input_tokens FROM usage_events WHERE id='old-usage'", [], |r| r.get::<_, i64>(0)).unwrap(), 9);
            assert_eq!(conn.query_row("SELECT reported_cost_minor FROM usage_events WHERE id='old-usage'", [], |r| r.get::<_, i64>(0)).unwrap(), 77);
            assert_eq!(conn.query_row("SELECT amount_minor FROM usage_valuations WHERE usage_event_id='old-usage'", [], |r| r.get::<_, i64>(0)).unwrap(), 55);
            drop(conn);
            let summary = db.usage_summary(&json!({"from":"2026-01-01T00:00:00Z","to":"2026-01-03T00:00:00Z"})).unwrap();
            assert_eq!(summary["inputTokens"], 9);
            assert!(summary.get("providerReportedCostMinor").is_none());
            assert!(summary.get("valuations").is_none());
            assert!(summary.get("subscriptions").is_none());
            assert!(db.snapshot().unwrap().get("budgets").is_none());
        }
        {
            let db = Storage::open(&path).unwrap();
            let first = json!({"provider":"codex","status":"available","limits":[]});
            db.save_quota_snapshot("codex", "rt-codex", &first, "2026-01-03T00:00:00Z").unwrap();
            db.record_quota_failure("codex", "rt-codex", "2026-01-03T00:05:00Z", 1, "2026-01-03T00:05:10Z", "timeout").unwrap();
            let cache = db.quota_snapshots().unwrap();
            assert_eq!(cache[0]["snapshot"], first);
            assert_eq!(cache[0]["fetchedAt"], "2026-01-03T00:00:00Z");
            assert_eq!(cache[0]["failureCount"], 1);
            assert_eq!(cache[0]["lastError"], "timeout");
        }
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn context_model_null_is_persisted_and_legacy_missing_key_may_fallback() {
        let root = std::env::temp_dir().join(format!("bloblex-context-model-null-{}", Uuid::new_v4()));
        let path = root.join("usage.db");
        fs::create_dir_all(&root).unwrap();
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-context-null","provider":"claude"})).unwrap();
            db.create_session("s-context-null", "rt-context-null", "claude", ".", "Context").unwrap();
            db.insert_usage(&json!({"id":"u-context-null","runtimeId":"rt-context-null","sessionId":"s-context-null","provider":"claude","timestamp":"2026-10-12T00:00:00Z","usageStatus":"reported","contextUsed":420,"contextSize":1000,"model":"claude-sonnet-5-5"})).unwrap();
            db.push_event("session.context.updated", &json!({"sessionId":"s-context-null","contextUsed":null,"contextSize":null,"contextModel":null,"contextEstimated":false})).unwrap();
            let cleared = db.session_detail("s-context-null").unwrap();
            assert!(cleared["contextUsed"].is_null());
            assert!(cleared["contextSize"].is_null());
            assert!(cleared["contextModel"].is_null(), "an explicit null must not be replaced by an older usage model");
            drop(db);
        }
        {
            let db = Storage::open(&path).unwrap();
            assert!(db.session_detail("s-context-null").unwrap()["contextModel"].is_null(), "explicit unknown attribution must survive reconnect hydration");
            db.push_event("session.context.updated", &json!({"sessionId":"s-context-null","contextUsed":420,"contextSize":1000})).unwrap();
            assert_eq!(db.session_detail("s-context-null").unwrap()["contextModel"], "claude-sonnet-5-5", "only a legacy event with a missing key may use the historical usage model");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_metadata_migration_rename_archive_and_delete_are_durable_and_scoped() {
        let path = std::env::temp_dir().join(format!("bloblex-session-controls-{}.db", Uuid::new_v4()));
        {
            let db = Storage::open(&path).unwrap();
            let version: i64 = db.conn.lock().unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(version, 12);
            db.upsert_runtime(&json!({"id":"rt-controls","provider":"codex"})).unwrap();
            db.create_session("s-controls", "rt-controls", "codex", ".", "Original").unwrap();
            assert!(matches!(db.session_delete("s-controls"), Err(StorageError::SessionActive)));
            db.update_session_state("s-controls", "idle").unwrap();
            let provider_title = db.session_provider_title("s-controls", "Generated by Codex").unwrap().unwrap();
            assert_eq!(provider_title["title"], "Generated by Codex");
            let renamed = db.session_rename("s-controls", "  Renamed chat  ").unwrap();
            assert_eq!(renamed["title"], "Renamed chat");
            assert!(db.session_provider_title("s-controls", "A later provider title").unwrap().is_none());
            assert!(renamed.get("messages").is_none());
            assert!(matches!(db.session_rename("s-controls", "  "), Err(StorageError::InvalidAgent)));
            let archived = db.session_archive("s-controls", true).unwrap();
            assert_eq!(archived["archived"], true);
            assert!(archived.get("messages").is_none());
            assert!(db.sessions().unwrap().iter().all(|session| session["id"] != "s-controls"));
            assert_eq!(db.session_list(true).unwrap().iter().find(|session| session["id"] == "s-controls").unwrap()["archived"], true);
            db.session_archive("s-controls", false).unwrap();
            db.create_turn("t-controls", "s-controls").unwrap();
            db.append_message("s-controls", "t-controls", "user", "private test text").unwrap();
            db.insert_usage(&json!({"id":"u-controls","runtimeId":"rt-controls","sessionId":"s-controls","turnId":"t-controls","provider":"codex","timestamp":"2026-10-02T00:00:00Z","usageStatus":"reported","contextUsed":420,"contextSize":1000})).unwrap();
            assert_eq!(db.session_detail("s-controls").unwrap()["contextUsed"], 420);
            assert_eq!(db.session_event_summary("s-controls").unwrap()["contextSize"], 1000);
            db.push_event("session.context.updated", &json!({"sessionId":"s-controls","contextUsed":520,"contextSize":1200})).unwrap();
            assert_eq!(db.session_detail("s-controls").unwrap()["contextUsed"], 520);
            db.push_event("session.context.updated", &json!({"sessionId":"s-controls","contextUsed":17340,"contextSize":1000000,"contextModel":"claude-sonnet-5-5","contextEstimated":true})).unwrap();
            assert_eq!(db.session_detail("s-controls").unwrap()["contextEstimated"], true);
            assert_eq!(db.session_event_summary("s-controls").unwrap()["contextModel"], "claude-sonnet-5-5");
            db.push_event("session.context.updated", &json!({"sessionId":"s-controls","contextUsed":500,"contextSize":1000000,"contextModel":"claude-sonnet-5-5","contextEstimated":false})).unwrap();
            assert_eq!(db.session_detail("s-controls").unwrap()["contextEstimated"], false);
            db.push_event("session.context.reset", &json!({"sessionId":"s-controls"})).unwrap();
            assert!(db.session_detail("s-controls").unwrap()["contextUsed"].is_null());
            assert_eq!(db.session_detail("s-controls").unwrap()["contextEstimated"], false);
            assert!(db.session_event_summary("s-controls").unwrap()["contextSize"].is_null());
            db.upsert_tool("s-controls", "tool-controls", "command", "test", "completed", &json!({})).unwrap();
            db.insert_file("s-controls", "local-file", &json!({"operation":"edited"})).unwrap();
            db.conn.lock().unwrap().execute("INSERT INTO exec_snapshots(id,session_id,turn_id,runtime_id,provider,created_at,requested_json,applied_json,evidence_json,adapter_flags_json,status) VALUES('snap-controls','s-controls','t-controls','rt-controls','codex','now','{}','{}','{}','{}','applied')", []).unwrap();
            db.push_event("message.completed", &json!({"sessionId":"s-controls","content":"private test message"})).unwrap();
            db.create_session("s-provider-title", "rt-controls", "codex", ".", "New chat").unwrap();
            db.update_session_state("s-provider-title", "idle").unwrap();
            db.session_provider_title("s-provider-title", "Generated provider title").unwrap();
            drop(db);
        }
        {
            let db = Storage::open(&path).unwrap();
            assert_eq!(db.session_detail("s-controls").unwrap()["title"], "Renamed chat");
            assert!(db.session_detail("s-controls").unwrap()["contextUsed"].is_null());
            assert!(db.session_detail("s-controls").unwrap()["contextSize"].is_null());
            assert_eq!(db.session_detail("s-provider-title").unwrap()["title"], "Generated provider title");
            assert!(db.session_provider_title("s-provider-title", "Later provider title").unwrap().is_some());
            assert_eq!(db.session_detail("s-provider-title").unwrap()["title"], "Later provider title");
            db.session_delete("s-controls").unwrap();
            let replay = db.replay_events(0, 100).unwrap();
            assert!(replay.iter().all(|event| event["payload"]["sessionId"] != "s-controls"));
            assert!(!serde_json::to_string(&replay).unwrap().contains("private test message"));
            assert_eq!(db.append_message("s-controls", "late-turn", "assistant", "late output").unwrap(), Value::Null);
            assert_eq!(db.upsert_tool("s-controls", "late-tool", "command", "late", "completed", &json!({})).unwrap(), Value::Null);
            db.insert_file("s-controls", "late-file", &json!({})).unwrap();
            db.insert_permission("late-permission", "s-controls", "late-request", "late", None, &[], &json!({})).unwrap();
            db.insert_usage(&json!({"id":"late-usage","runtimeId":"rt-controls","sessionId":"s-controls","provider":"codex","timestamp":"now","source":"stream","raw":{}})).unwrap();
            let c = db.conn.lock().unwrap();
            for (table, column) in [("sessions", "id"), ("messages", "session_id"), ("turns", "session_id"), ("tool_calls", "session_id"), ("file_changes", "session_id"), ("permission_requests", "session_id"), ("usage_events", "session_id"), ("exec_snapshots", "session_id")] {
                let count: i64 = c.query_row(&format!("SELECT count(*) FROM {table} WHERE {column}='s-controls'"), [], |r| r.get(0)).unwrap();
                assert_eq!(count, 0, "{table} should be deleted");
            }
        }
        let _ = fs::remove_file(&path);
    }
    #[test]
    fn snapshot_after_reopen_excludes_archived_conversations() {
        let path = std::env::temp_dir().join(format!("bloblex-archive-reconnect-{}.db", Uuid::new_v4()));
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-archive","provider":"codex"})).unwrap();
            db.create_session("s-archived-reconnect", "rt-archive", "codex", ".", "Archived").unwrap();
            db.update_session_state("s-archived-reconnect", "idle").unwrap();
            db.session_archive("s-archived-reconnect", true).unwrap();
        }
        let db = Storage::open(&path).unwrap();
        assert!(db.snapshot().unwrap()["sessions"].as_array().unwrap().iter().all(|session| session["id"] != "s-archived-reconnect"));
        assert_eq!(db.session_list(true).unwrap().iter().find(|session| session["id"] == "s-archived-reconnect").unwrap()["archived"], true);
        let _ = fs::remove_file(&path);
    }
    #[test]
    fn budget_stop_is_persisted_as_a_classified_failed_turn() {
        let db = Storage::open_in_memory().unwrap();
        db.create_session("s-budget", "rt", "codex", ".", "Budget").unwrap();
        db.record_budget_stopped_turn("t-budget", "s-budget").unwrap();
        let c = db.conn.lock().unwrap();
        let (state, class): (String, Option<String>) = c.query_row(
            "SELECT state,failure_class FROM turns WHERE id='t-budget'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(state, "error");
        assert_eq!(class.as_deref(), Some("budget_stop"));
    }
    #[test]
    fn dst_day_boundaries_and_week_monday_use_local_calendar_time() {
        let timezone: Tz = "Europe/London".parse().unwrap();
        let spring_from = DateTime::parse_from_rfc3339("2026-03-28T00:00:00Z").unwrap().with_timezone(&Utc);
        let spring_to = DateTime::parse_from_rfc3339("2026-03-31T00:00:00Z").unwrap().with_timezone(&Utc);
        let spring = analytics_bucket_starts(spring_from, spring_to, timezone, "day").unwrap();
        assert_eq!(spring[2].signed_duration_since(spring[1]).num_hours(), 23);
        let autumn_from = DateTime::parse_from_rfc3339("2026-10-24T00:00:00Z").unwrap().with_timezone(&Utc);
        let autumn_to = DateTime::parse_from_rfc3339("2026-10-27T00:00:00Z").unwrap().with_timezone(&Utc);
        let autumn = analytics_bucket_starts(autumn_from, autumn_to, timezone, "day").unwrap();
        assert_eq!(autumn[2].signed_duration_since(autumn[1]).num_hours(), 25);
        let week = analytics_bucket_start(NaiveDate::from_ymd_opt(2026, 5, 31).unwrap(), timezone, "week").unwrap();
        assert_eq!(week.with_timezone(&timezone).date_naive(), NaiveDate::from_ymd_opt(2026, 5, 25).unwrap());
    }
    #[test]
    fn legacy_decimal_helpers_remain_deterministic() {
        assert_eq!(format_decimal_units(decimal_units("0.001637988").unwrap() - decimal_units("0.0015894").unwrap()), "0.000048588");
        assert_eq!(decimal_to_minor("0.005", "USD"), Some(1));
        assert_eq!(decimal_to_minor("0.004", "USD"), Some(0));
    }
    #[test]
    fn reported_money_is_ignored_and_duplicate_usage_updates_are_ignored() {
        let db = Storage::open_in_memory().unwrap();
        db.create_session("s-cumulative", "rt", "opencode", ".", "Cumulative").unwrap();
        db.create_turn("t-first", "s-cumulative").unwrap();
        let report = |id: &str, turn: &str, update: &str, amount: &str| json!({
            "id": id, "runtimeId": "rt", "sessionId": "s-cumulative", "turnId": turn,
            "provider": "opencode", "timestamp": "2026-10-02T00:00:00Z",
            "providerUpdateId": update, "usageStatus": "reported", "source": "terminal",
            "reportedCostDecimal": amount, "costIsCumulative": true
        });
        db.insert_usage(&report("u-first", "t-first", "event-1", "0.0015894")).unwrap();
        db.insert_usage(&report("u-duplicate", "t-first", "event-1", "0.0015894")).unwrap();
        db.insert_usage(&report("u-first-update", "t-first", "event-2", "0.001637988")).unwrap();
        db.create_turn("t-second", "s-cumulative").unwrap();
        db.insert_usage(&report("u-second", "t-second", "event-3", "0.001686576")).unwrap();

        let c = db.conn.lock().unwrap();
        let first: Option<String> = c.query_row("SELECT reported_cost_decimal FROM usage_events WHERE turn_id='t-first'", [], |r| r.get(0)).unwrap();
        let second: Option<String> = c.query_row("SELECT reported_cost_decimal FROM usage_events WHERE turn_id='t-second'", [], |r| r.get(0)).unwrap();
        let rows: i64 = c.query_row("SELECT count(*) FROM usage_events WHERE provider_update_id='event-2'", [], |r| r.get(0)).unwrap();
        let total: Option<String> = c.query_row("SELECT opencode_cost_total FROM sessions WHERE id='s-cumulative'", [], |r| r.get(0)).unwrap();
        assert_eq!(first, None);
        assert_eq!(second, None);
        assert_eq!(rows, 1);
        assert_eq!(total, None);
    }
    #[test]
    fn terminal_usage_replaces_fallback_for_the_same_turn() {
        let db = Storage::open_in_memory().unwrap();
        db.create_session("s-reconcile", "rt", "codex", ".", "Reconcile").unwrap();
        db.create_turn("t-reconcile", "s-reconcile").unwrap();
        let base = json!({"runtimeId":"rt","sessionId":"s-reconcile","turnId":"t-reconcile","provider":"codex","timestamp":"2026-10-02T00:00:00Z","usageStatus":"reported"});
        let mut fallback = base.clone();
        fallback["id"] = json!("u-fallback");
        fallback["source"] = json!("fallback");
        fallback["inputTokens"] = json!(2);
        db.insert_usage(&fallback).unwrap();
        let mut terminal = base;
        terminal["id"] = json!("u-terminal");
        terminal["source"] = json!("terminal");
        terminal["inputTokens"] = json!(3);
        db.insert_usage(&terminal).unwrap();
        terminal["id"] = json!("u-terminal-latest");
        terminal["inputTokens"] = json!(4);
        db.insert_usage(&terminal).unwrap();
        let c = db.conn.lock().unwrap();
        let row: (i64, String, i64) = c.query_row("SELECT input_tokens,source,(SELECT count(*) FROM usage_events WHERE turn_id='t-reconcile') FROM usage_events WHERE turn_id='t-reconcile'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(row, (4, "terminal".into(), 1));
    }
    #[test]
    fn durable_turn_reservations_survive_open_and_release_on_recovery() {
        let path = std::env::temp_dir().join(format!("bloblex-reservation-{}.sqlite", Uuid::new_v4()));
        {
            let db = Storage::open(&path).unwrap();
            db.create_session("reserve-session", "rt", "codex", ".", "Reserve").unwrap();
            assert!(db.create_reserved_turn("reserve-turn", "reserve-session").unwrap());
            assert_eq!(db.active_turn_reservation_count().unwrap(), 1);
        }
        let db = Storage::open(&path).unwrap();
        assert_eq!(db.active_turn_reservation_count().unwrap(), 1);
        db.recover_after_restart().unwrap();
        assert_eq!(db.active_turn_reservation_count().unwrap(), 0);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn durable_reservations_enforce_the_global_cap_of_four() {
        let db = Storage::open_in_memory().unwrap();
        for index in 0..5 {
            let session = format!("s-cap-{index}");
            db.create_session(&session, "rt", "codex", ".", "Cap").unwrap();
        }
        for index in 0..4 {
            assert!(db.create_reserved_turn(&format!("t-cap-{index}"), &format!("s-cap-{index}")).unwrap());
        }
        assert!(!db.create_reserved_turn("t-cap-4", "s-cap-4").unwrap());
        assert_eq!(db.active_turn_reservation_count().unwrap(), 4);
    }
    #[test]
    fn analytics_reconciles_reported_tokens_filters_paths_and_omits_legacy_money() {
        let db = Storage::open_in_memory().unwrap();
        db.create_session("analytics-session", "rt", "codex", "C:\\Project\\", "Analytics").unwrap();
        db.create_turn("analytics-turn", "analytics-session").unwrap();
        {
            let c = db.conn.lock().unwrap();
            c.execute("UPDATE turns SET state='error',started_at='2026-03-29T00:10:00Z',completed_at='2026-03-29T01:10:00Z',failure_class='provider_error' WHERE id='analytics-turn'", []).unwrap();
        }
        db.insert_usage(&json!({"id":"analytics-usage","runtimeId":"rt","sessionId":"analytics-session","turnId":"analytics-turn","provider":"codex","model":"model-x","timestamp":"2026-03-29T01:00:00Z","inputTokens":12,"usageStatus":"partial","source":"terminal"})).unwrap();
        let result = db.usage_analytics(&json!({"from":"2026-03-28T00:00:00Z","to":"2026-03-31T00:00:00Z","bucket":"day","tz":"Europe/London","projectPath":"c:/project/"})).unwrap();
        assert_eq!(result["totals"]["runs"], 1);
        assert_eq!(result["totals"]["failedRuns"], 1);
        assert_eq!(result["totals"]["tokens"]["input"], 12);
        assert!(result["totals"]["tokens"]["output"].is_null());
        assert!(result["totals"].get("cost").is_none());
        assert!(result["totals"].get("unpricedModels").is_none());
        assert!(result["series"][0].get("cost").is_none());
        assert!(result["leaderboard"][0].get("cost").is_none());
        assert!(result["leaderboard"][0].get("unpricedModels").is_none());
        assert_eq!(result["errors"][0]["failureClass"], "provider");
        assert!(!result.to_string().contains("raw-provider"));
        assert_eq!(result["series"].as_array().unwrap().len(), 4);
    }
    #[test]
    fn snapshot_evidence_keeps_numeric_usage_effect_and_instruction_reason(){let value=snapshot_evidence(&json!({"thinking":{"evidenceKind":"usage_effect","evidenceValue":37},"instructions":{"evidenceKind":"none","evidenceValue":null,"reason":"instructions_change_requires_new_thread"}}));assert_eq!(value["thinking"]["value"],37);assert_eq!(value["thinking"]["kind"],"usage_effect");assert_eq!(value["instructions"]["reason"],"instructions_change_requires_new_thread");}
    #[test]
    fn migration_3_to_4_preserves_rows_seeds_default_and_is_idempotent(){
        let dir=std::env::temp_dir().join(format!("bloblex-v4-{}",Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();let path=dir.join("db.sqlite");
        let agent_id;
        {let db=Storage::open(&path).unwrap();db.upsert_runtime(&json!({"id":"rt-v4","provider":"codex"})).unwrap();let (agent,_)=db.agent_create(&json!({"name":"Existing","runtimeId":"rt-v4"})).unwrap();agent_id=agent["id"].as_str().unwrap().to_owned();db.create_session_for_agent("session-v4","rt-v4","codex","C:/project","Existing",Some(&agent_id)).unwrap();db.insert_permission("perm-v4","session-v4","request-v4","Read file",None,&["allow".into(),"deny".into()],&json!({"toolCall":{"kind":"read"},"path":"README.md"})).unwrap();}
        {let c=Connection::open(&path).unwrap();remove_session_controls_migration(&c);c.execute_batch("DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4; ALTER TABLE turns DROP COLUMN failure_class; ALTER TABLE turns DROP COLUMN started_at; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3; ALTER TABLE agents DROP COLUMN approval_mode; ALTER TABLE permission_requests DROP COLUMN resolved_by; DELETE FROM settings WHERE key='permissions.default_mode';").unwrap();}
        {let db=Storage::open(&path).unwrap();assert_eq!(db.default_approval_mode().unwrap(),"ask");let agent=db.agent_get(&agent_id).unwrap();assert!(agent["approvalMode"].is_null());assert_eq!(agent["effectiveApprovalMode"],"ask");let c=Connection::open(&path).unwrap();assert_eq!(c.query_row("SELECT status FROM permission_requests WHERE id='perm-v4'",[],|r|r.get::<_,String>(0)).unwrap(),"pending");assert!(c.query_row("SELECT resolved_by FROM permission_requests WHERE id='perm-v4'",[],|r|r.get::<_,Option<String>>(0)).unwrap().is_none());assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),12);}
        let backups=fs::read_dir(dir.join("backups")).unwrap().count();drop(Storage::open(&path).unwrap());assert_eq!(fs::read_dir(dir.join("backups")).unwrap().count(),backups);
        {let c=Connection::open(&path).unwrap();c.pragma_update(None,"user_version",3).unwrap();}assert!(matches!(Storage::open(&path),Err(StorageError::InvalidAgent)));let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn automatic_permission_resolution_is_conditional_and_persists_policy_source(){
        let db=Storage::open_in_memory().unwrap();assert_eq!(db.default_approval_mode().unwrap(),"ask");assert!(matches!(db.set_setting("permissions.default_mode",&json!("bypass")),Err(StorageError::InvalidAgent)));db.upsert_runtime(&json!({"id":"rt-policy","provider":"codex"})).unwrap();db.create_session_for_agent("s-policy","rt-policy","codex",".","Policy",None).unwrap();db.insert_permission("p-policy","s-policy","provider-request","Check",None,&["allow".into(),"deny".into()],&json!({})).unwrap();assert_eq!(db.begin_permission_reply("p-policy","allow").unwrap().unwrap().1,"provider-request");db.finish_permission_policy_reply("p-policy",true,"policy:auto","allow").unwrap();assert_eq!(db.permission_resolved_by("p-policy").unwrap().as_deref(),Some("policy:auto"));assert!(db.begin_permission_reply("p-policy","allow").unwrap().is_none());
    }
    #[test]
    fn migration_5_backup_failure_keeps_v4_schema_untouched(){
        let dir=std::env::temp_dir().join(format!("bloblex-v5-backup-{}",Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();let path=dir.join("db.sqlite");drop(Storage::open(&path).unwrap());
        {let c=Connection::open(&path).unwrap();remove_session_controls_migration(&c);c.execute_batch("DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4; ALTER TABLE turns DROP COLUMN failure_class; ALTER TABLE turns DROP COLUMN started_at;").unwrap();}
        let before=Connection::open(&path).unwrap().query_row("PRAGMA schema_version",[],|r|r.get::<_,i64>(0)).unwrap();fs::remove_dir_all(dir.join("backups")).unwrap();fs::write(dir.join("backups"),b"not a directory").unwrap();assert!(Storage::open(&path).is_err());let c=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(c.query_row("PRAGMA schema_version",[],|r|r.get::<_,i64>(0)).unwrap(),before);assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),4);assert_eq!(c.query_row("SELECT MAX(version) FROM schema_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),4);assert!(c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='approval_mode')",[],|r|r.get::<_,bool>(0)).unwrap());drop(c);let _=fs::remove_dir_all(dir);
    }
    fn v1_fixture() -> (PathBuf,PathBuf) {
        let dir=std::env::temp_dir().join(format!("bloblex-phase2a-{}",Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();let path=dir.join("bloblex.db");drop(Storage::open(&path).unwrap());
        let c=Connection::open(&path).unwrap();c.pragma_update(None,"foreign_keys","OFF").unwrap();remove_session_controls_migration(&c);c.execute_batch("DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4; ALTER TABLE turns DROP COLUMN failure_class; ALTER TABLE turns DROP COLUMN started_at; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3; ALTER TABLE agents DROP COLUMN approval_mode; ALTER TABLE permission_requests DROP COLUMN resolved_by; DELETE FROM settings WHERE key='permissions.default_mode'; DROP INDEX idx_usage_provider_update; DROP INDEX idx_usage_exec_snapshot; DROP INDEX idx_active_reservations_session; DROP INDEX idx_active_reservations_agent; DROP INDEX idx_exec_snapshots_session_time; DROP INDEX idx_exec_snapshots_agent_time; DROP INDEX idx_exec_snapshots_runtime_time; DROP TABLE active_turn_reservations; DROP TABLE exec_snapshots; ALTER TABLE sessions DROP COLUMN first_exec_snapshot_id; ALTER TABLE sessions DROP COLUMN latest_exec_snapshot_id; ALTER TABLE sessions DROP COLUMN claude_instruction_sha256; ALTER TABLE sessions DROP COLUMN codex_thread_instruction_sha256; ALTER TABLE sessions DROP COLUMN opencode_cost_total; ALTER TABLE usage_events DROP COLUMN exec_snapshot_id; ALTER TABLE usage_events DROP COLUMN provider_update_id; ALTER TABLE usage_events DROP COLUMN usage_status; ALTER TABLE usage_events DROP COLUMN context_used; ALTER TABLE usage_events DROP COLUMN context_size; ALTER TABLE usage_events DROP COLUMN reported_cost_decimal; DELETE FROM app_events WHERE event_type='settings.changed'; DELETE FROM settings WHERE key LIKE 'exec_gate.%'; DELETE FROM schema_migrations WHERE version=3; PRAGMA user_version=2; DROP INDEX idx_sessions_agent_updated; DROP INDEX idx_usage_agent_time; DROP INDEX idx_agents_active_name; DROP INDEX idx_agents_active_runtime_order; DROP INDEX idx_agents_runtime_archived_order; ALTER TABLE sessions DROP COLUMN agent_id; ALTER TABLE usage_events DROP COLUMN agent_id; DROP TABLE agents; DELETE FROM schema_migrations WHERE version=2; PRAGMA user_version=0;").unwrap();
        c.execute_batch("DELETE FROM schema_migrations WHERE version IN (7,8,9); INSERT INTO runtimes(id,host_id,provider,protocol,executable,status,data) VALUES('rt-a','h','codex','codex_app_server','codex','online','{}'),('rt-b','h','claude','claude_stream','claude','offline','{}'); INSERT INTO sessions(id,runtime_id,provider,project_path,title,state,created_at,updated_at) VALUES('s-a','rt-a','codex','C:/a','A','idle','2026-01-02T00:00:00.000Z','2026-01-03T00:00:00.000Z'),('s-missing','rt-missing','other','C:/b','B','idle','2026-01-02T00:00:00.000Z','2026-01-03T00:00:00.000Z'); INSERT INTO usage_events(id,runtime_id,session_id,provider,timestamp,source,raw) VALUES('u-a','rt-a','s-a','codex','2026-01-03T00:00:00.000Z','stream','{}'),('u-missing','rt-missing','absent','other','2026-01-03T00:00:00.000Z','stream','{}');").unwrap();drop(c);let _=fs::remove_dir_all(dir.join("backups"));(dir,path)
    }
    fn v2_fixture()->(PathBuf,PathBuf){
        let(dir,path)=v1_fixture();drop(Storage::open(&path).unwrap());
        let c=Connection::open(&path).unwrap();c.pragma_update(None,"foreign_keys","OFF").unwrap();
        remove_session_controls_migration(&c);
        c.execute_batch("DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4; ALTER TABLE turns DROP COLUMN failure_class; ALTER TABLE turns DROP COLUMN started_at; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3; ALTER TABLE agents DROP COLUMN approval_mode; ALTER TABLE permission_requests DROP COLUMN resolved_by; DELETE FROM settings WHERE key='permissions.default_mode'; DROP INDEX idx_usage_provider_update; DROP INDEX idx_usage_exec_snapshot; DROP INDEX idx_active_reservations_session; DROP INDEX idx_active_reservations_agent; DROP INDEX idx_exec_snapshots_session_time; DROP INDEX idx_exec_snapshots_agent_time; DROP INDEX idx_exec_snapshots_runtime_time; DROP TABLE active_turn_reservations; DROP TABLE exec_snapshots; ALTER TABLE sessions DROP COLUMN first_exec_snapshot_id; ALTER TABLE sessions DROP COLUMN latest_exec_snapshot_id; ALTER TABLE sessions DROP COLUMN claude_instruction_sha256; ALTER TABLE sessions DROP COLUMN codex_thread_instruction_sha256; ALTER TABLE sessions DROP COLUMN opencode_cost_total; ALTER TABLE usage_events DROP COLUMN exec_snapshot_id; ALTER TABLE usage_events DROP COLUMN provider_update_id; ALTER TABLE usage_events DROP COLUMN usage_status; ALTER TABLE usage_events DROP COLUMN context_used; ALTER TABLE usage_events DROP COLUMN context_size; ALTER TABLE usage_events DROP COLUMN reported_cost_decimal; DELETE FROM app_events WHERE event_type='settings.changed'; DELETE FROM settings WHERE key LIKE 'exec_gate.%'; DELETE FROM schema_migrations WHERE version=3; PRAGMA user_version=2;").unwrap();
        c.execute("INSERT INTO settings(key,value) VALUES('exec_gate.codex.model','false')",[]).unwrap();drop(c);let _=fs::remove_dir_all(dir.join("backups"));(dir,path)
    }
    #[test]
    fn migrations_create_idempotent_database_and_events_replay() {
        let db = Storage::open_in_memory().unwrap();
        db.push_event("x", &json!({"n":1})).unwrap();
        let ev = db.replay_events(0, 20).unwrap();
        assert!(ev.iter().any(|e|e["type"]=="x"));
        assert_eq!(db.snapshot().unwrap()["sequence"], ev.last().unwrap()["sequence"]);
    }
    #[test]
    fn restart_recovery_keeps_native_resume_identity_and_expires_approvals() {
        let db = Storage::open_in_memory().unwrap();
        db.create_session("s", "rt", "codex", "C:/repo", "restart test")
            .unwrap();
        db.set_session_provider_id("s", "thread-native", true)
            .unwrap();
        db.create_turn("t", "s").unwrap();
        db.update_session_state("s", "working").unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO budget_reservations(id,policy_id,turn_id,amount,status,created_at) VALUES('legacy-reservation','legacy-policy','t',5,'active',?1)",
            [Utc::now().to_rfc3339()],
        ).unwrap();
        db.append_message("s", "t", "user", "keep this prompt")
            .unwrap();
        db.insert_permission(
            "p",
            "s",
            "request",
            "Run command",
            Some("command"),
            &["allow_once".into(), "deny".into()],
            &json!({}),
        )
        .unwrap();
        assert_eq!(db.recover_after_restart().unwrap(), vec!["s"]);
        let detail = db.session_detail("s").unwrap();
        assert_eq!(detail["state"], "offline");
        assert_eq!(detail["providerSessionId"], "thread-native");
        assert_eq!(detail["resumable"], true);
        assert_eq!(detail["messages"][0]["content"], "keep this prompt");
        assert_eq!(detail["turns"][0]["state"], "error");
        let reservation = db.conn.lock().unwrap().query_row(
            "SELECT status,amount FROM budget_reservations WHERE id='legacy-reservation'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ).unwrap();
        assert_eq!(reservation, ("active".into(), 5));
        assert!(db.snapshot().unwrap()["permissions"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn budget_reservations_are_atomic_and_enforce_limit() {
        let db = Storage::open_in_memory().unwrap();
        assert!(db.reserve_budget("p", "t1", 7, 10).unwrap());
        assert!(!db.reserve_budget("p", "t2", 4, 10).unwrap());
    }

    #[test]
    fn budget_admission_uses_metric_specific_known_demands_atomically() {
        let db = Storage::open_in_memory().unwrap();
        db.save_budget(&json!({"id":"tokens","scopeType":"global","period":"day","metric":"tokens","hardLimit":100,"enabled":true})).unwrap();
        db.save_budget(&json!({"id":"estimate","scopeType":"global","period":"day","metric":"estimated_cost_minor","hardLimit":500,"currency":"USD","enabled":true})).unwrap();
        // Unknown price cannot be treated as a zero-cost reservation. Because
        // admission is one transaction, the known token demand is rolled back.
        assert!(!db.reserve_applicable_budgets_with_demands(
            "t1", "s1", "r1", "codex", "C:/repo", &json!({"tokens":20})
        ).unwrap());
        assert_eq!(db.budget_usage("tokens", "day").unwrap(), (0, 0));
        assert!(db.reserve_applicable_budgets_with_demands(
            "t2", "s1", "r1", "codex", "C:/repo", &json!({"tokens":20,"estimated_cost_minor":42})
        ).unwrap());
        assert_eq!(db.budget_usage("tokens", "day").unwrap(), (20, 0));
        assert_eq!(db.budget_usage("estimate", "day").unwrap(), (42, 0));
        db.reconcile_budget_turn_metrics("t2", &json!({"tokens":12,"estimated_cost_minor":17})).unwrap();
        assert_eq!(db.budget_usage("tokens", "day").unwrap(), (0, 12));
        assert_eq!(db.budget_usage("estimate", "day").unwrap(), (0, 17));
    }
    #[test]
    fn archive_preserves_legacy_budget_rows_without_enforcing_them() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-blob","provider":"codex"})).unwrap();
        let gojo = db.agent_create(&json!({"name":"Gojo","runtimeId":"rt-blob"})).unwrap().0;
        let other = db.agent_create(&json!({"name":"Other","runtimeId":"rt-blob"})).unwrap().0;
        let gojo_id = gojo["id"].as_str().unwrap();
        db.create_session_for_agent("s-gojo","rt-blob","codex",".","Gojo",Some(gojo_id)).unwrap();
        db.create_session_for_agent("s-other","rt-blob","codex",".","Other",other["id"].as_str()).unwrap();
        db.create_turn("t-gojo","s-gojo").unwrap();
        db.create_turn("t-other","s-other").unwrap();
        db.save_budget(&json!({"id":"blob-cap","scopeType":"blob","scopeId":gojo_id,"period":"day","metric":"tokens","hardLimit":10,"enabled":true})).unwrap();
        assert!(db.reserve_applicable_budgets("t-gojo","s-gojo","rt-blob","codex",".",6).unwrap());
        assert!(!db.reserve_applicable_budgets("t-gojo-extra","s-gojo","rt-blob","codex",".",5).unwrap());
        assert!(db.reserve_applicable_budgets("t-other","s-other","rt-blob","codex",".",9).unwrap());
        {
            let c = db.conn.lock().unwrap();
            c.execute("INSERT INTO budget_reservations(id,policy_id,turn_id,amount,status,created_at,metric) VALUES('other-agent','blob-cap','t-other',9,'active',?1,'tokens')", [Utc::now().to_rfc3339()]).unwrap();
        }
        db.create_turn("t-gojo-next", "s-gojo").unwrap();
        assert!(db.reserve_applicable_budgets("t-gojo-next","s-gojo","rt-blob","codex",".",4).unwrap());
        let listed = &db.budget_list().unwrap()["policies"][0];
        assert_eq!(listed["scopeType"], "blob");
        assert_eq!(listed["scopeId"], gojo_id);
        assert_eq!(listed["reserved"], 10);
        db.agent_archive(gojo_id).unwrap();
        assert_eq!(db.budget_list().unwrap()["policies"].as_array().unwrap().len(), 1);
        assert_eq!(db.conn.lock().unwrap().query_row("SELECT count(*) FROM budget_reservations WHERE policy_id='blob-cap'", [], |r| r.get::<_,i64>(0)).unwrap(), 3);
        assert!(db.save_budget(&json!({"id":"bad","scopeType":"blob","scopeId":gojo_id,"period":"day","metric":"tokens","hardLimit":10})).is_err());
    }
    #[test]
    fn retargeted_budget_policy_drops_old_active_reservations_before_reconcile() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-budget","provider":"codex"})).unwrap();
        let agent = db.agent_create(&json!({"name":"Budget owner","runtimeId":"rt-budget"})).unwrap().0;
        let agent_id = agent["id"].as_str().unwrap();
        db.create_session_for_agent("budget-session","rt-budget","codex",".","Budget owner",Some(agent_id)).unwrap();
        db.create_turn("old-turn","budget-session").unwrap();
        db.save_budget(&json!({"id":"reused-policy","scopeType":"global","period":"day","metric":"tokens","hardLimit":100,"enabled":true})).unwrap();
        assert!(db.reserve_applicable_budgets("old-turn","budget-session","rt-budget","codex",".",60).unwrap());
        db.save_budget(&json!({"id":"reused-policy","scopeType":"blob","scopeId":agent_id,"period":"day","metric":"tokens","hardLimit":10,"enabled":true})).unwrap();
        assert_eq!(db.conn.lock().unwrap().query_row("SELECT count(*) FROM budget_reservations WHERE policy_id='reused-policy'", [], |r| r.get::<_,i64>(0)).unwrap(), 0);
        db.create_turn("new-turn","budget-session").unwrap();
        assert!(db.reserve_applicable_budgets("new-turn","budget-session","rt-budget","codex",".",10).unwrap());
        db.reconcile_budget_turn_metrics("old-turn", &json!({"tokens":99})).unwrap();
        let listed = &db.budget_list().unwrap()["policies"][0];
        assert_eq!(listed["reserved"], 10);
        assert_eq!(listed["consumed"], 0);
    }
    #[test]
    fn turn_budget_totals_report_only_the_latest_turn() {
        let db = Storage::open_in_memory().unwrap();
        db.save_budget(&json!({"id":"turn","scopeType":"global","period":"turn","metric":"tokens","hardLimit":10,"enabled":true})).unwrap();
        assert!(db.reserve_applicable_budgets("turn-a", "s", "rt", "codex", "C:/repo", 7).unwrap());
        db.reconcile_budget_turn_metrics("turn-a", &json!({"tokens":7})).unwrap();
        assert!(db.reserve_applicable_budgets("turn-b", "s", "rt", "codex", "C:/repo", 3).unwrap());

        let policy = &db.budget_list().unwrap()["policies"][0];
        assert_eq!(policy["consumed"], 0);
        assert_eq!(policy["reserved"], 3);
        assert_eq!(policy["remaining"], 7);
    }
    #[test]
    fn multi_policy_budget_admission_rolls_back_and_reconciles() {
        let db = Storage::open_in_memory().unwrap();
        for (id, scope, scope_id, limit) in [
            ("global", "global", Value::Null, 10),
            ("session", "session", json!("s"), 5),
        ] {
            db.save_budget(&json!({"id":id,"scopeType":scope,"scopeId":scope_id,"period":"day","metric":"tokens","hardLimit":limit,"enabled":true})).unwrap();
        }
        assert!(!db
            .reserve_applicable_budgets("blocked", "s", "rt", "codex", "C:/repo", 7)
            .unwrap());
        assert!(db
            .reserve_applicable_budgets("accepted", "s", "rt", "codex", "C:/repo", 5)
            .unwrap());
        db.reconcile_budget_turn("accepted", 3).unwrap();
        assert!(db
            .reserve_applicable_budgets("next", "other-session", "rt", "codex", "C:/repo", 7)
            .unwrap());
        db.release_budget_turn("next").unwrap();
        assert!(db
            .reserve_applicable_budgets("final", "s", "rt", "codex", "C:/repo", 2)
            .unwrap());
    }
    #[test]
    fn racing_persistent_admissions_cannot_double_spend() {
        let db = std::sync::Arc::new(Storage::open_in_memory().unwrap());
        db.save_budget(&json!({"id":"global","scopeType":"global","period":"day","metric":"tokens","hardLimit":10,"enabled":true})).unwrap();
        let workers = (0..20)
            .map(|n| {
                let db = db.clone();
                std::thread::spawn(move || {
                    db.reserve_applicable_budgets(
                        &format!("t{n}"),
                        "s",
                        "rt",
                        "codex",
                        "C:/repo",
                        1,
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let accepted = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(accepted, 10);
    }
    #[test]
    fn agents_reorder_rotate_archive_and_usage_follow_session_owner() {
        let db=Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-agent","provider":"codex","status":"offline"})).unwrap();
        let make=|name:&str|db.agent_create(&json!({"name":name,"runtimeId":"rt-agent","instructions":"private instructions","customEnv":{"TERM":"xterm-256color"}})).unwrap().0;
        let a=make("Alpha");let b=make("Beta");let c=make("Gamma");
        let ids=vec![c["id"].as_str().unwrap().to_owned(),a["id"].as_str().unwrap().to_owned(),b["id"].as_str().unwrap().to_owned()];
        let (swapped,ev)=db.agent_reorder("rt-agent",&ids).unwrap();assert_eq!(swapped.iter().map(|x|x["id"].as_str().unwrap()).collect::<Vec<_>>(),ids.iter().map(String::as_str).collect::<Vec<_>>());assert_eq!(ev.len(),3);
        assert!(matches!(db.agent_reorder("rt-agent",&ids[..2]),Err(StorageError::InvalidAgent)));assert_eq!(db.agent_list(false,Some("rt-agent")).unwrap().iter().map(|x|x["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>(),ids);
        let rotated=vec![ids[1].clone(),ids[2].clone(),ids[0].clone()];let (order,_)=db.agent_reorder("rt-agent",&rotated).unwrap();assert_eq!(order.iter().map(|x|x["id"].as_str().unwrap()).collect::<Vec<_>>(),rotated.iter().map(String::as_str).collect::<Vec<_>>());
        let archived_before=db.agent_get(&rotated[1]).unwrap()["sortOrder"].as_i64().unwrap();let (archived,archive_events)=db.agent_archive(&rotated[1]).unwrap();assert!(archive_events.iter().any(|e|e["payload"]["action"]=="archived"));assert_eq!(archived["sortOrder"],archived_before);
        let active=db.agent_list(false,Some("rt-agent")).unwrap();assert_eq!(active.len(),2);assert_eq!(active[0]["sortOrder"],0);assert_eq!(active[1]["sortOrder"],1);
        assert_eq!(db.agent_list(true,Some("rt-agent")).unwrap().len(),3);
        let picked=db.agent_get(&rotated[0]).unwrap();db.create_session_for_agent("owned","rt-agent","codex","C:/tmp","title",Some(picked["id"].as_str().unwrap())).unwrap();
        db.insert_usage(&json!({"id":"u-owned","runtimeId":"rt-agent","sessionId":"owned","provider":"codex","timestamp":"2026-10-02T00:00:00.000Z","raw":{},"agentId":"wrong"})).unwrap();
        let c=db.conn.lock().unwrap();let attribution:String=c.query_row("SELECT agent_id FROM usage_events WHERE id='u-owned'",[],|r|r.get(0)).unwrap();assert_eq!(attribution,picked["id"]);drop(c);
        let snapshot=db.snapshot().unwrap();assert_eq!(snapshot["agents"].as_array().unwrap().len(),3);let cursor=snapshot["sequence"].as_u64().unwrap();assert!(cursor>0);let replay=db.replay_events(0,100).unwrap();assert!(replay.iter().any(|e|e["type"]=="agent.changed"));let (_,later)=db.agent_update(picked["id"].as_str().unwrap(),&json!({"description":"after snapshot"})).unwrap();assert_eq!(later.len(),1);let after=db.replay_events(cursor,100).unwrap();assert_eq!(after.len(),1);assert_eq!(after[0]["type"],"agent.changed");
        db.upsert_runtime(&json!({"id":"rt-next","provider":"codex"})).unwrap();let(moved,moved_events)=db.agent_update(picked["id"].as_str().unwrap(),&json!({"runtimeId":"rt-next"})).unwrap();assert_eq!(moved["sortOrder"],0);assert!(moved_events.iter().any(|e|e["payload"]["action"]=="updated"));assert_eq!(db.session_detail("owned").unwrap()["runtimeId"],"rt-agent");let remaining=db.agent_list(false,Some("rt-agent")).unwrap();for (index,agent) in remaining.iter().enumerate(){assert_eq!(agent["sortOrder"],index as i64);}
    }
    #[test]
    fn agent_validation_archived_session_noops_and_legacy_null_attribution(){
        let db=Storage::open_in_memory().unwrap();db.upsert_runtime(&json!({"id":"rt","provider":"codex"})).unwrap();db.upsert_runtime(&json!({"id":"other","provider":"claude"})).unwrap();
        let agent=db.agent_create(&json!({"name":"Agent","runtimeId":"rt"})).unwrap().0;let agent_id=agent["id"].as_str().unwrap();let second=db.agent_create(&json!({"name":"Second","runtimeId":"rt"})).unwrap().0;let second_id=second["id"].as_str().unwrap().to_owned();
        db.create_session("legacy","rt","codex",".","legacy").unwrap();db.create_session_for_agent("unassigned","rt","codex",".","unassigned",None).unwrap();
        for id in ["legacy","unassigned"]{assert!(db.session_detail(id).unwrap()["agentId"].is_null());assert!(db.sessions().unwrap().iter().find(|s|s["id"]==id).unwrap()["agentId"].is_null());}
        db.agent_archive(&second_id).unwrap();assert!(matches!(db.create_session_for_agent("archived","rt","codex",".","archived",Some(&second_id)),Err(StorageError::AgentConflict)));
        assert!(matches!(db.create_session_for_agent("mismatch","other","claude",".","mismatch",Some(agent_id)),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.create_session_for_agent("unknown","rt","codex",".","unknown",Some(&Uuid::new_v4().to_string())),Err(StorageError::AgentNotFound)));
        let canonical="123e4567-e89b-12d3-a456-426614174000";let forms=[format!("urn:uuid:{canonical}"),format!("{{{canonical}}}"),canonical.to_ascii_uppercase(),canonical.replace("-","")];for form in forms{assert!(matches!(db.agent_get(&form),Err(StorageError::InvalidAgent)),"accepted noncanonical UUID {form}");}
        db.agent_archive(&second_id).unwrap();let count=||{let c=db.conn.lock().unwrap();c.query_row("SELECT count(*) FROM app_events WHERE event_type='agent.changed'",[],|r|r.get::<_,i64>(0)).unwrap()};let before=count();
        let (_,updated_events)=db.agent_update(agent_id,&json!({"name":agent["name"],"runtimeId":agent["runtimeId"],"description":agent["description"],"instructions":agent["instructions"],"color":agent["color"],"model":agent["model"],"thinking":agent["thinking"],"serviceTier":agent["serviceTier"],"customArgs":agent["customArgs"],"customEnv":agent["customEnv"],"maxConcurrency":agent["maxConcurrency"],"defaultProject":agent["defaultProject"]})).unwrap();assert!(updated_events.is_empty());assert_eq!(count(),before);
        let order=db.agent_list(false,Some("rt")).unwrap().iter().map(|a|a["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();let(_,reorder_events)=db.agent_reorder("rt",&order).unwrap();assert!(reorder_events.is_empty());assert_eq!(count(),before);
        let(_,archive_events)=db.agent_archive(&second_id).unwrap();assert!(archive_events.is_empty());assert_eq!(count(),before);
    }

    #[test]
    fn outfit_storage_defaults_validates_updates_and_survives_snapshot() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-outfit","provider":"codex"})).unwrap();
        let legacy = db.agent_create(&json!({"name":"Legacy","runtimeId":"rt-outfit"})).unwrap().0;
        assert_eq!(legacy["outfit"], "auto");
        let id = legacy["id"].as_str().unwrap();
        for outfit in ["round-glasses", "pumpkin", "bunny-ears"] {
            let (updated, events) = db.agent_update(id, &json!({"outfit":outfit})).unwrap();
            assert_eq!(updated["outfit"], outfit);
            assert_eq!(events.len(), 1);
        }
        assert!(matches!(db.agent_update(id, &json!({"outfit":"unknown-outfit"})), Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Invalid","runtimeId":"rt-outfit","outfit":5})), Err(StorageError::InvalidAgent)));
        assert_eq!(db.snapshot().unwrap()["agents"][0]["outfit"], "bunny-ears");
        let c = db.conn.lock().unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 12);
    }

    #[test]
    fn outfit_migration_from_six_backs_up_and_defaults_existing_records() {
        let dir = std::env::temp_dir().join(format!("bloblex-outfit-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        let old = Storage::open_in_memory().unwrap();
        old.upsert_runtime(&json!({"id":"rt-old","provider":"codex"})).unwrap();
        old.agent_create(&json!({"name":"Old","runtimeId":"rt-old"})).unwrap();
        {
            let source = old.conn.lock().unwrap();
            source.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE IF EXISTS message_reactions; DROP INDEX IF EXISTS idx_messages_session_id_id; ALTER TABLE sessions DROP COLUMN model_lock_json; ALTER TABLE agents DROP COLUMN outfit; DROP TABLE IF EXISTS quota_snapshots; DELETE FROM schema_migrations WHERE version IN (7,8,9,10,11,12); PRAGMA user_version=6; DROP TABLE user_pricing_rules; CREATE TABLE user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate INTEGER,output_rate INTEGER,cache_read_rate INTEGER,cache_write_rate INTEGER,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL);").unwrap();
            let mut destination = Connection::open(&path).unwrap();
            Backup::new(&source, &mut destination).unwrap().run_to_completion(128, std::time::Duration::from_millis(10), None).unwrap();
        }
        drop(old);
        let backup_dir = dir.join("backups");
        assert!(!backup_dir.exists());
        {
            let db = Storage::open(&path).unwrap();
            assert_eq!(db.agent_list(false, None).unwrap()[0]["outfit"], "auto");
        }
        let after_migration = fs::read_dir(&backup_dir).unwrap().map(|entry| entry.unwrap().path()).collect::<Vec<_>>();
        let v6_database = after_migration.iter().find(|item| item.file_name().unwrap().to_string_lossy().starts_with("bloblex-pre-v6-") && item.extension().is_some_and(|extension| extension == "db")).unwrap();
        let v6_stem = v6_database.file_stem().unwrap().to_string_lossy();
        let v6_manifest = backup_dir.join(format!("{v6_stem}.manifest.json"));
        assert!(after_migration.iter().any(|item| item == &v6_manifest));
        let backup_read = Connection::open_with_flags(v6_database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(backup_read.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 6);
        assert_eq!(backup_read.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 6);
        assert!(!backup_read.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='outfit')", [], |row| row.get::<_, bool>(0)).unwrap());
        drop(backup_read);
        let manifest: Value = serde_json::from_slice(&fs::read(&v6_manifest).unwrap()).unwrap();
        assert_eq!(manifest["schemaVersion"], 6);
        assert_eq!(manifest["integrity"], "ok");
        let v7_database = after_migration.iter().find(|item| item.file_name().unwrap().to_string_lossy().starts_with("bloblex-pre-v7-") && item.extension().is_some_and(|extension| extension == "db")).unwrap();
        let v7_stem = v7_database.file_stem().unwrap().to_string_lossy();
        let v7_manifest = backup_dir.join(format!("{v7_stem}.manifest.json"));
        assert!(after_migration.iter().any(|item| item == &v7_manifest));
        let backup_v7 = Connection::open_with_flags(v7_database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(backup_v7.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
        assert_eq!(backup_v7.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
        assert!(backup_v7.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='outfit')", [], |row| row.get::<_, bool>(0)).unwrap());
        assert_eq!(backup_v7.query_row("SELECT type FROM pragma_table_info('user_pricing_rules') WHERE name='input_rate'", [], |row| row.get::<_, String>(0)).unwrap(), "INTEGER");
        drop(backup_v7);
        let manifest: Value = serde_json::from_slice(&fs::read(&v7_manifest).unwrap()).unwrap();
        assert_eq!(manifest["schemaVersion"], 7);
        assert_eq!(manifest["integrity"], "ok");
        let before_reopen = after_migration.iter().map(|item| item.file_name().unwrap().to_string_lossy().into_owned()).collect::<std::collections::BTreeSet<_>>();
        {
            let read = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            assert_eq!(read.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 12);
            assert_eq!(read.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 12);
            assert_eq!(read.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 12);
        }
        drop(Storage::open(&path).unwrap());
        let after_reopen = fs::read_dir(&backup_dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(after_reopen, before_reopen);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn v10_model_lock_migration_preserves_sessions_and_accepts_session_lock_updates() {
        let root = std::env::temp_dir().join(format!("bloblex-model-lock-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-lock","provider":"codex"})).unwrap();
            db.create_session("s-lock", "rt-lock", "codex", "C:/project", "Saved title").unwrap();
            db.update_session_state("s-lock", "idle").unwrap();
            db.create_turn("t-lock", "s-lock").unwrap();
            db.append_message("s-lock", "t-lock", "user", "saved message").unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("DROP TABLE message_reactions; DROP INDEX idx_messages_session_id_id; ALTER TABLE sessions DROP COLUMN model_lock_json; DELETE FROM schema_migrations WHERE version IN (11,12); PRAGMA user_version=10;").unwrap();
        }
        {
            let db = Storage::open(&path).unwrap();
            assert_eq!(db.conn.lock().unwrap().query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
            let before = db.session_detail("s-lock").unwrap();
            assert_eq!(before["title"], "Saved title");
            assert_eq!(before["messages"][0]["content"], "saved message");
            assert!(before["modelLock"].is_null());
            let lock = json!({"model":"gpt-5.6-luna","thinking":"high"});
            let updated = db.set_session_model_lock("s-lock", &lock).unwrap();
            assert_eq!(updated["modelLock"], lock);
            assert_eq!(db.session_detail("s-lock").unwrap()["modelLock"], lock);
            assert!(db.set_session_model_lock("missing", &lock).is_err());
            assert!(db.set_session_model_lock("s-lock", &json!({"model":12,"thinking":null})).is_err());
        }
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn agent_validation_is_safe_and_duplicate_names_are_conflicts() {
        let db=Storage::open_in_memory().unwrap();db.upsert_runtime(&json!({"id":"rt","provider":"codex"})).unwrap();
        let created=db.agent_create(&json!({"name":" Name ","runtimeId":"rt","color":"#aabbcc"})).unwrap().0;assert_eq!(created["color"],"#AABBCC");
        assert!(matches!(db.agent_create(&json!({"name":"name","runtimeId":"rt"})),Err(StorageError::AgentConflict)));
        let active=db.agent_list(false,None).unwrap().remove(0);db.agent_archive(active["id"].as_str().unwrap()).unwrap();assert!(db.agent_create(&json!({"name":"NAME","runtimeId":"rt"})).is_ok());
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","color":"#abc"})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","customEnv":{"API_TOKEN":"x"}})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","customArgs":["--dangerous"]})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","customEnv":{"LANG":"nul\u{0000}value"}})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","customEnv":{"SAFE_MODE":"yes"}})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"x".repeat(61),"runtimeId":"rt"})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"missing"})),Err(StorageError::AgentNotFound)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","description":"x".repeat(256)})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","instructions":"nul\u{0000}text"})),Err(StorageError::InvalidAgent)));
        assert!(matches!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt","maxConcurrency":51})),Err(StorageError::InvalidAgent)));
    }
    #[test]
    fn runtime_discovery_never_creates_blobs_and_preserves_existing_blobs(){
        let db=Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-claude","provider":"claude"})).unwrap();
        db.upsert_runtime(&json!({"id":"rt-codex","provider":"codex"})).unwrap();
        assert!(db.agent_list(true,None).unwrap().is_empty());
        let gojo=db.agent_create(&json!({"name":"Gojo","runtimeId":"rt-codex"})).unwrap().0;
        db.upsert_runtime(&json!({"id":"rt-codex-2","provider":"codex"})).unwrap();
        assert_eq!(db.agent_list(true,None).unwrap(), vec![gojo]);
    }
    #[test]
    fn v1_migration_backfills_once_creates_verified_backup_and_rolls_back_in_temp_paths(){
        let(dir,path)=v1_fixture();
        let baseline={let db=Storage::open(&path).unwrap();let s= db.sessions().unwrap();assert_eq!(s.len(),2);assert!(s.iter().find(|x|x["id"]=="s-missing").unwrap()["agentId"].is_null());assert_eq!(db.agent_list(true,None).unwrap().len(),2);(db.agent_list(true,None).unwrap(),s)};
        let backup_dir=dir.join("backups");let paths=fs::read_dir(&backup_dir).unwrap().map(|x|x.unwrap().path()).collect::<Vec<_>>();assert_eq!(paths.len(),22);assert_eq!(paths.iter().filter(|x|x.extension().is_some_and(|e|e=="db")).count(),11);assert!(paths.iter().all(|x|!x.file_name().unwrap().to_string_lossy().ends_with("-wal")&&!x.file_name().unwrap().to_string_lossy().ends_with("-shm")));let backup=paths.iter().find(|x|x.extension().is_some_and(|e|e=="db")&&x.file_name().unwrap().to_string_lossy().contains("v1")).unwrap().clone();let manifest_path=paths.iter().find(|x|x.file_name().unwrap().to_string_lossy().ends_with("manifest.json")&&x.file_name().unwrap().to_string_lossy().contains("v1")).unwrap();let manifest:Value=serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();assert_eq!(manifest["integrity"],"ok");assert_eq!(manifest["schemaVersion"],1);assert_eq!(manifest["tableRowCounts"]["sessions"],2);
        {let db=Storage::open(&path).unwrap();assert_eq!(db.agent_list(true,None).unwrap(),baseline.0);assert_eq!(db.sessions().unwrap(),baseline.1);}
        let read=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(read.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),12);assert_eq!(read.query_row("SELECT MAX(version) FROM schema_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),12);assert_eq!(read.query_row("SELECT count(*) FROM usage_events WHERE agent_id IS NOT NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);assert_eq!(read.query_row("SELECT agent_id FROM usage_events WHERE id='u-a'",[],|r|r.get::<_,Option<String>>(0)).unwrap(),Some(read.query_row("SELECT agent_id FROM sessions WHERE id='s-a'",[],|r|r.get::<_,String>(0)).unwrap()));assert_eq!(read.query_row("SELECT created_at FROM sessions WHERE id='s-a'",[],|r|r.get::<_,String>(0)).unwrap(),"2026-01-02T00:00:00.000Z");assert_eq!(read.query_row("SELECT a.color FROM agents a JOIN runtimes r ON r.id=a.runtime_id WHERE r.provider='codex'",[],|r|r.get::<_,String>(0)).unwrap(),"#82AAFF");assert_eq!(read.query_row("SELECT a.color FROM agents a JOIN runtimes r ON r.id=a.runtime_id WHERE r.provider='claude'",[],|r|r.get::<_,String>(0)).unwrap(),"#F38C6F");for (table,column) in [("sessions","agent_id"),("usage_events","agent_id"),("sessions","first_exec_snapshot_id"),("usage_events","usage_status"),("agents","approval_mode"),("permission_requests","resolved_by"),("sessions","title_override"),("sessions","archived"),("sessions","model_lock_json")] {assert!(read.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",params![table,column],|r|r.get::<_,bool>(0)).unwrap());}for index in ["idx_agents_active_name","idx_agents_active_runtime_order","idx_agents_runtime_archived_order","idx_sessions_agent_updated","idx_usage_agent_time","idx_usage_provider_update"]{assert!(read.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",[index],|r|r.get::<_,bool>(0)).unwrap());}drop(read);
        let failed=restore_verified_backup(&backup,&path,1).unwrap();assert!(failed.exists());let restored=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(restored.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert_eq!(restored.query_row("SELECT count(*) FROM sessions",[],|r|r.get::<_,i64>(0)).unwrap(),2);assert!(!restored.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='agent_id')",[],|r|r.get::<_,bool>(0)).unwrap());drop(restored);let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn backup_failure_aborts_before_schema_ddl(){
        let(dir,path)=v1_fixture();let before=Connection::open(&path).unwrap().query_row("PRAGMA schema_version",[],|r|r.get::<_,i64>(0)).unwrap();let blocker=dir.join("backups");fs::write(&blocker,b"not a directory").unwrap();
        assert!(Storage::open(&path).is_err());let c=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(c.query_row("PRAGMA schema_version",[],|r|r.get::<_,i64>(0)).unwrap(),before);
        assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='agent_id')",[],|r|r.get::<_,bool>(0)).unwrap());
        assert_eq!(c.query_row("SELECT MAX(version) FROM schema_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),1);drop(c);let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn opencode_effort_gate_is_opened_once_for_databases_seeded_closed() {
        let db = Storage::open_in_memory().unwrap();
        // A database seeded closed by an older build, before the marker existed.
        {
            let c = db.conn.lock().unwrap();
            c.execute("UPDATE settings SET value='false' WHERE key='exec_gate.opencode.thinking'", []).unwrap();
            c.execute("DELETE FROM settings WHERE key='migration.opencodeEffortGateOpened'", []).unwrap();
            ensure_opencode_effort_gate_open(&c).unwrap();
        }
        assert_eq!(db.settings().unwrap()["exec_gate.opencode.thinking"], true);
        // After the marker, a deliberate operator choice is kept.
        db.set_setting("exec_gate.opencode.thinking", &json!(false)).unwrap();
        {
            let c = db.conn.lock().unwrap();
            ensure_opencode_effort_gate_open(&c).unwrap();
        }
        assert_eq!(db.settings().unwrap()["exec_gate.opencode.thinking"], false);
    }
    #[test]
    fn migration_2_to_3_seeds_gates_preserves_operator_values_and_reopens_without_backup_or_sidecars(){
        let(dir,path)=v2_fixture();
        {let db=Storage::open(&path).unwrap();let settings=db.settings().unwrap();assert_eq!(settings["exec_gate.codex.model"],false);for key in ["exec_gate.claude.model","exec_gate.claude.thinking","exec_gate.claude.instructions","exec_gate.codex.thinking","exec_gate.codex.serviceTier","exec_gate.codex.instructions","exec_gate.opencode.model","exec_gate.opencode.thinking","exec_gate.opencode.instructions"]{assert_eq!(settings[key],true);}}
        let backup_dir=dir.join("backups");let before=fs::read_dir(&backup_dir).unwrap().count();assert_eq!(before,20);
        {let c=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),12);assert_eq!(c.query_row("SELECT MAX(version) FROM schema_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),12);assert_eq!(c.query_row("SELECT COUNT(*) FROM usage_events WHERE usage_status='unreported' AND exec_snapshot_id IS NULL AND provider_update_id IS NULL AND context_used IS NULL AND context_size IS NULL AND reported_cost_decimal IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),2);assert_eq!(c.query_row("SELECT count(*) FROM app_events WHERE event_type='settings.changed'",[],|r|r.get::<_,i64>(0)).unwrap(),10);for (table,column) in [("sessions","claude_instruction_sha256"),("sessions","codex_thread_instruction_sha256"),("sessions","opencode_cost_total"),("usage_events","reported_cost_decimal")] {assert_eq!(c.query_row("SELECT type FROM pragma_table_info(?1) WHERE name=?2",params![table,column],|r|r.get::<_,String>(0)).unwrap(),"TEXT");}assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='cumulative_cost_micros')",[],|r|r.get::<_,bool>(0)).unwrap());}
        drop(Storage::open(&path).unwrap());assert_eq!(fs::read_dir(&backup_dir).unwrap().count(),before);
        let c=Connection::open(&path).unwrap();c.pragma_update(None,"foreign_keys","OFF").unwrap();remove_session_controls_migration(&c);c.execute_batch("DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4; ALTER TABLE turns DROP COLUMN failure_class; ALTER TABLE turns DROP COLUMN started_at; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3; ALTER TABLE agents DROP COLUMN approval_mode; ALTER TABLE permission_requests DROP COLUMN resolved_by; DELETE FROM settings WHERE key='permissions.default_mode'; DELETE FROM schema_migrations WHERE version=3; PRAGMA user_version=2;").unwrap();drop(c);drop(Storage::open(&path).unwrap());
        let entries=fs::read_dir(&dir).unwrap().map(|e|e.unwrap().file_name().to_string_lossy().to_string()).collect::<Vec<_>>();assert!(entries.iter().all(|n|!n.ends_with("-wal")&&!n.ends_with("-shm")));let backup_entries=fs::read_dir(&backup_dir).unwrap().map(|e|e.unwrap().file_name().to_string_lossy().to_string()).collect::<Vec<_>>();assert!(backup_entries.iter().all(|n|!n.ends_with("-wal")&&!n.ends_with("-shm")));let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn snapshots_keep_only_normalized_option_data_and_link_first_latest_and_usage(){
        let db=Storage::open_in_memory().unwrap();db.create_session("s","rt","codex","C:/repo","Snapshot").unwrap();db.create_turn("t1","s").unwrap();
        let first=db.create_exec_snapshot("s","t1","snap1",&json!({"model":"gpt-6","thinking":"high","serviceTier":"priority","instructions":"do-not-store-this","instructionsPresent":true,"maxConcurrency":3,"customEnvKeys":["LANG"],"customEnv":{"LANG":"private-value"}}),&json!({"model":{"requested":"gpt-6","applied":true}}),&json!({"model":{"evidenceKind":"provider_echo","evidenceValue":"gpt-6"},"raw":"provider-json-must-not-be-here"}),Some("sha256-safe"),&json!({"adapter":"codex","version":"0.1"}),"applied").unwrap();
        let stored=first.to_string();assert!(!stored.contains("do-not-store-this"));assert!(!stored.contains("private-value"));assert!(!stored.contains("provider-json-must-not-be-here"));assert_eq!(first["requested"]["envKeys"][0],"LANG");assert_eq!(first["requested"]["extraArgs"],json!([]));
        db.insert_usage(&json!({"id":"u1","runtimeId":"rt","sessionId":"s","turnId":"t1","provider":"codex","timestamp":"2026-10-02T00:00:00Z","providerUpdateId":"update-1","usageStatus":"reported","contextUsed":12,"contextSize":100,"reportedCostDecimal":"0.000048588","raw":{"private":"raw-provider-data"}})).unwrap();
        let c=db.conn.lock().unwrap();
        // Flat tuple of the queried usage-event columns; a named type would only rename them.
        #[allow(clippy::type_complexity)]
        let row:(Option<String>,Option<String>,String,Option<i64>,Option<i64>,Option<String>,String)=c.query_row("SELECT exec_snapshot_id,provider_update_id,usage_status,context_used,context_size,reported_cost_decimal,raw FROM usage_events WHERE id='u1'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).unwrap();assert_eq!(row,(Some("snap1".into()),Some("update-1".into()),"reported".into(),Some(12),Some(100),None,"{}".into()));drop(c);
        db.create_turn("t2","s").unwrap();db.create_exec_snapshot("s","t2","snap2",&json!({"maxConcurrency":1}),&json!({}),&json!({}),None,&json!({}),"runtime_default").unwrap();assert_eq!(db.exec_snapshot_latest("s").unwrap().unwrap()["id"],"snap2");let (items,next)=db.exec_snapshot_list("s",Some("snap1"),10).unwrap();assert_eq!(items.len(),1);assert_eq!(items[0]["id"],"snap2");assert!(next.is_none());db.set_session_exec_snapshot("s","snap2",true).unwrap();let (_,event)=db.update_exec_snapshot_evidence("t2",&json!({"model":{"requested":"gpt-6","applied":true,"evidenceKind":"provider_echo","evidenceValue":"gpt-6"}})).unwrap();assert_eq!(event["type"],"exec.options.changed");let updated=db.exec_snapshot_get("snap2").unwrap().unwrap();assert_eq!(updated["applied"]["model"]["applied"],true);assert_eq!(updated["evidence"]["model"]["kind"],"provider_echo");let c=db.conn.lock().unwrap();let ptrs:(String,String)=c.query_row("SELECT first_exec_snapshot_id,latest_exec_snapshot_id FROM sessions WHERE id='s'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(ptrs,("snap1".into(),"snap2".into()));
    }
    #[test]
    fn claude_instruction_baseline_advances_only_after_successful_turn_evidence(){
        let db=Storage::open_in_memory().unwrap();db.create_session("s-instructions","rt","claude",".","instructions").unwrap();assert_eq!(db.claude_instruction_sha256("s-instructions").unwrap(),None);
        db.create_turn("t-success","s-instructions").unwrap();db.create_exec_snapshot("s-instructions","t-success","snap-success",&json!({"instructionsPresent":true}),&json!({}),&json!({}),Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),&json!({}),"partial").unwrap();
        let (_,event)=db.update_exec_snapshot_evidence("t-success",&json!({"instructions":{"requested":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","applied":true,"evidenceKind":"successful_turn","evidenceValue":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}})).unwrap();assert!(!event.to_string().contains("instruction text"));assert!(!event.to_string().contains("secret"));
        assert_eq!(db.claude_instruction_sha256("s-instructions").unwrap().as_deref(),Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        db.create_turn("t-failed","s-instructions").unwrap();db.create_exec_snapshot("s-instructions","t-failed","snap-failed",&json!({"instructionsPresent":true}),&json!({}),&json!({}),Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),&json!({}),"partial").unwrap();
        db.update_exec_snapshot_evidence("t-failed",&json!({"instructions":{"requested":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","applied":null,"evidenceKind":"none","reason":"failed_turn"}})).unwrap();
        assert_eq!(db.claude_instruction_sha256("s-instructions").unwrap().as_deref(),Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        db.create_turn("t-empty","s-instructions").unwrap();db.create_exec_snapshot("s-instructions","t-empty","snap-empty",&json!({"instructionsPresent":false}),&json!({}),&json!({}),None,&json!({}),"runtime_default").unwrap();
        db.update_exec_snapshot_evidence("t-empty",&json!({"instructions":{"requested":null,"applied":true,"evidenceKind":"successful_turn","evidenceValue":null}})).unwrap();
        assert_eq!(db.claude_instruction_sha256("s-instructions").unwrap(),None);
        db.create_session("s-codex-instructions","rt","codex",".","codex").unwrap();db.create_turn("t-codex","s-codex-instructions").unwrap();db.create_exec_snapshot("s-codex-instructions","t-codex","snap-codex",&json!({}),&json!({}),&json!({}),Some("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"),&json!({}),"partial").unwrap();db.update_exec_snapshot_evidence("t-codex",&json!({"instructions":{"applied":true}})).unwrap();assert_eq!(db.claude_instruction_sha256("s-codex-instructions").unwrap(),None);assert_eq!(db.codex_thread_instruction_sha256("s-codex-instructions").unwrap().as_deref(),Some("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"));
    }
    #[test]
    fn codex_thread_instruction_hash_advances_only_with_provider_echo_evidence(){
        let db=Storage::open_in_memory().unwrap();
        db.create_session("s-codex-echo","rt","codex",".","codex").unwrap();
        let first="a".repeat(64);let second="b".repeat(64);let third="c".repeat(64);
        // First write on a new thread keeps the COALESCE path.
        db.create_turn("e1","s-codex-echo").unwrap();
        db.create_exec_snapshot("s-codex-echo","e1","se1",&json!({}),&json!({}),&json!({}),Some(first.as_str()),&json!({}),"partial").unwrap();
        db.update_exec_snapshot_evidence("e1",&json!({"instructions":{"applied":true,"evidenceKind":"successful_turn"}})).unwrap();
        assert_eq!(db.codex_thread_instruction_sha256("s-codex-echo").unwrap().as_deref(),Some(first.as_str()));
        // Applied-with-evidence overwrites the stored thread hash.
        db.create_turn("e2","s-codex-echo").unwrap();
        db.create_exec_snapshot("s-codex-echo","e2","se2",&json!({}),&json!({}),&json!({}),Some(second.as_str()),&json!({}),"partial").unwrap();
        db.update_exec_snapshot_evidence("e2",&json!({"instructions":{"applied":true,"evidenceKind":"provider_echo"}})).unwrap();
        assert_eq!(db.codex_thread_instruction_sha256("s-codex-echo").unwrap().as_deref(),Some(second.as_str()));
        // An unverified (resumed) turn never changes it.
        db.create_turn("e3","s-codex-echo").unwrap();
        db.create_exec_snapshot("s-codex-echo","e3","se3",&json!({}),&json!({}),&json!({}),Some(third.as_str()),&json!({}),"partial").unwrap();
        db.update_exec_snapshot_evidence("e3",&json!({"instructions":{"applied":null,"evidenceKind":"none","reason":"instructions_sent_unverified"}})).unwrap();
        assert_eq!(db.codex_thread_instruction_sha256("s-codex-echo").unwrap().as_deref(),Some(second.as_str()));
    }
    #[test]
    fn rejected_turn_writes_error_message_snapshot_and_event_atomically_without_reservation(){
        let db=Storage::open_in_memory().unwrap();db.upsert_runtime(&json!({"id":"rt","provider":"claude"})).unwrap();db.create_session("s","rt","claude",".","test").unwrap();
        let (snapshot,event)=db.reject_exec_turn("s","t","snap","user turn text",&json!({"model":"custom","instructions":"secret instruction text","instructionsPresent":true,"customEnv":{"LANG":"secret env"},"customEnvKeys":["LANG"],"maxConcurrency":1}),&json!({"model":{"applied":false}}),&json!({"raw":"must-not-persist"}),None,&json!({"adapter":"claude"}),&json!({"agentId":null,"runtimeId":"rt","setting":"model","code":"unsupported","reason":"safe"})).unwrap();
        assert_eq!(snapshot["status"],"rejected");assert_eq!(snapshot["requested"]["instructionsPresent"],true);assert!(!snapshot.to_string().contains("secret instruction text"));assert!(!snapshot.to_string().contains("secret env"));assert!(!snapshot.to_string().contains("must-not-persist"));assert_eq!(event["type"],"exec.options.rejected");
        let c=db.conn.lock().unwrap();assert_eq!(c.query_row("SELECT state FROM turns WHERE id='t'",[],|r|r.get::<_,String>(0)).unwrap(),"error");assert_eq!(c.query_row("SELECT content FROM messages WHERE turn_id='t'",[],|r|r.get::<_,String>(0)).unwrap(),"user turn text");assert_eq!(c.query_row("SELECT count(*) FROM active_turn_reservations",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert_eq!(c.query_row("SELECT count(*) FROM app_events WHERE event_type='exec.options.rejected'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn exec_gate_setting_audit_is_atomic_and_suppresses_noop_events(){
        let db=Storage::open_in_memory().unwrap();let initial=db.set_setting("exec_gate.codex.model",&json!(false)).unwrap();assert_eq!(initial.len(),1);assert_eq!(initial[0]["type"],"settings.changed");assert_eq!(initial[0]["payload"],json!({"key":"exec_gate.codex.model","enabled":false}));assert!(db.set_setting("exec_gate.codex.model",&json!(false)).unwrap().is_empty());assert!(db.set_setting("ui.theme",&json!("dark")).unwrap().is_empty());assert_eq!(db.replay_events(initial[0]["sequence"].as_u64().unwrap()-1,5).unwrap().len(),1);
    }
    #[test]
    fn context_failure_class_round_trips_in_additive_storage_column() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"runtime","provider":"codex"})).unwrap();
        db.create_session("session", "runtime", "codex", ".", "Context").unwrap();
        db.create_turn("turn", "session").unwrap();
        db.update_turn_outcome("turn", "error", Some("context")).unwrap();
        assert_eq!(db.turn_failure_class("turn").unwrap().as_deref(), Some("context"));
        assert_eq!(analytics_failure_class(Some("context")), "context");
    }

    #[test]
    fn session_turn_dto_includes_nullable_class_and_safe_failure_message() {
        let db = Storage::open_in_memory().unwrap();
        db.create_session("session", "runtime", "codex", ".", "Turn DTO").unwrap();
        db.create_turn("failed", "session").unwrap();
        db.update_turn_outcome("failed", "error", Some("timeout")).unwrap();
        db.push_event("turn.error", &json!({"sessionId":"session","turnId":"failed","detail":"429 rate limit exceeded"})).unwrap();
        db.create_turn("successful", "session").unwrap();
        db.update_turn_outcome("successful", "completed", None).unwrap();
        let turns = db.session_detail("session").unwrap()["turns"].as_array().unwrap().clone();
        let failed = turns.iter().find(|turn| turn["id"] == "failed").unwrap();
        assert_eq!(failed["failureClass"], "timeout");
        assert_eq!(failed["failureMessage"], "The provider stopped making progress before the turn completed.");
        assert_eq!(failed["detail"], "429 rate limit exceeded");
        let successful = turns.iter().find(|turn| turn["id"] == "successful").unwrap();
        assert!(successful["failureClass"].is_null());
        assert!(successful["failureMessage"].is_null());
    }

    #[test]
    fn analytics_output_contains_usage_metrics_without_monetary_fields() {
        let metrics = AnalyticsAccumulator::default();
        let totals = metrics.totals_json();
        assert!(totals.get("cost").is_none());
        assert!(totals.get("unpricedModels").is_none());
    }

    #[test]
    fn provider_session_pointer_clears_only_when_explicitly_requested() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"runtime","provider":"codex"})).unwrap();
        db.create_session("session", "runtime", "codex", ".", "Resume").unwrap();
        db.set_session_provider_id("session", "native-id", true).unwrap();
        assert_eq!(db.session_detail("session").unwrap()["providerSessionId"], "native-id");
        db.clear_session_provider_id("session").unwrap();
        let row = db.session_detail("session").unwrap();
        assert!(row["providerSessionId"].is_null());
        assert_eq!(row["resumable"], false);
    }
    #[test]
    fn v2_backup_failure_and_corrupt_backup_both_fail_before_schema_changes(){
        let(dir,path)=v2_fixture();let before=Connection::open(&path).unwrap().query_row("PRAGMA schema_version",[],|r|r.get::<_,i64>(0)).unwrap();if dir.join("backups").exists(){fs::remove_dir_all(dir.join("backups")).unwrap();}fs::write(dir.join("backups"),b"cannot create backup directory").unwrap();
        assert!(Storage::open(&path).is_err());let c=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(c.query_row("PRAGMA schema_version",[],|r|r.get::<_,i64>(0)).unwrap(),before);assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),2);assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='first_exec_snapshot_id')",[],|r|r.get::<_,bool>(0)).unwrap());drop(c);
        let corrupted=dir.join("corrupt.db");fs::write(&corrupted,b"not a SQLite backup").unwrap();assert!(verify_backup_file(&corrupted,2,&std::collections::BTreeMap::new()).is_err());let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn team_projects_leader_side_sessions_and_questions_round_trip() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-team","provider":"codex"})).unwrap();
        let lead = db.agent_create(&json!({"name":"Lead","runtimeId":"rt-team"})).unwrap().0;
        let mate = db.agent_create(&json!({"name":"Mate","runtimeId":"rt-team"})).unwrap().0;
        let (lead_id, mate_id) = (lead["id"].as_str().unwrap().to_owned(), mate["id"].as_str().unwrap().to_owned());
        assert_eq!(lead["leader"], false);
        assert!(lead["projectId"].is_null());

        assert!(matches!(db.project_create("  ", None), Err(StorageError::InvalidAgent)));
        let (board, events) = db.project_create(" Board ", Some("C:/work/board")).unwrap();
        assert_eq!((board["name"].as_str(), board["path"].as_str(), board["sortOrder"].as_i64()), (Some("Board"), Some("C:/work/board"), Some(0)));
        assert_eq!(events[0]["type"], "project.changed");
        let side = db.project_create("Side", None).unwrap().0;
        assert_eq!(side["sortOrder"], 1);
        let board_id = board["id"].as_str().unwrap().to_owned();
        let renamed = db.project_update(&board_id, &json!({"name":"Board 2","path":null,"collapsed":true})).unwrap().0;
        assert_eq!((renamed["name"].as_str(), renamed["path"].is_null()), (Some("Board 2"), true));
        assert_eq!(db.project_list().unwrap().len(), 2);
        assert!(db.snapshot().unwrap()["projects"].as_array().is_some_and(|projects| projects.len() == 2));

        let placed = db.agent_set_team(&lead_id, &json!({"projectId":board_id,"role":" CTO ","leader":true})).unwrap().0;
        assert_eq!((placed["projectId"].as_str(), placed["role"].as_str(), placed["leader"].as_bool()), (Some(board_id.as_str()), Some("CTO"), Some(true)));
        assert!(matches!(db.agent_set_team(&mate_id, &json!({"projectId":"missing"})), Err(StorageError::AgentNotFound)));
        assert!(matches!(db.agent_set_team(&mate_id, &json!({"role":"x".repeat(41)})), Err(StorageError::InvalidAgent)));
        // Only one leader at a time.
        db.agent_set_team(&mate_id, &json!({"leader":true,"hidden":true})).unwrap();
        assert_eq!(db.leader_agent().unwrap().unwrap()["id"], mate_id.as_str());
        assert_eq!(db.agent_list(false, None).unwrap().iter().filter(|agent| agent["leader"] == true).count(), 1);
        db.agent_set_team(&mate_id, &json!({"leader":false})).unwrap();
        assert!(db.leader_agent().unwrap().is_none());

        // Deleting a project keeps its blobs as casual blobs.
        db.project_delete(&board_id).unwrap();
        assert!(db.agent_list(false, None).unwrap().iter().find(|agent| agent["id"] == lead_id.as_str()).unwrap()["projectId"].is_null());
        assert!(matches!(db.project_delete(&board_id), Err(StorageError::AgentNotFound)));

        db.create_session_for_agent("main", "rt-team", "codex", ".", "Main", Some(&lead_id)).unwrap();
        db.create_session_for_agent("side", "rt-team", "codex", ".", "Side", Some(&mate_id)).unwrap();
        assert_eq!(db.main_session(&mate_id).unwrap().as_deref(), Some("side"));
        let link = json!({"kind":"side","peerAgentId":lead_id,"peerName":"Lead","originSessionId":"main"});
        db.set_session_link("side", &link).unwrap();
        assert!(matches!(db.set_session_link("missing", &link), Err(StorageError::AgentNotFound)));
        assert_eq!(db.side_session(&mate_id, &lead_id).unwrap().as_deref(), Some("side"));
        assert!(db.side_session(&lead_id, &mate_id).unwrap().is_none());
        assert!(db.main_session(&mate_id).unwrap().is_none());
        assert_eq!(db.main_session(&lead_id).unwrap().as_deref(), Some("main"));
        assert_eq!(db.session_detail("side").unwrap()["link"]["originSessionId"], "main");

        db.create_turn("turn", "side").unwrap();
        db.append_message("side", "turn", "thinking", "hidden").unwrap();
        db.append_message("side", "turn", "assistant", "First part").unwrap();
        db.append_message("side", "turn", "assistant", "second part").unwrap();
        assert_eq!(db.turn_reply("side", "turn").unwrap().as_deref(), Some("First part\n\nsecond part"));
        assert!(db.turn_reply("side", "other").unwrap().is_none());

        let questions = json!([{"id":"q1","header":"Scope","question":"Which?","options":[{"label":"A","description":""}],"multiSelect":false,"allowOther":true}]);
        db.insert_question("perm-q", "main", "provider-q", "Questions", &questions, None).unwrap();
        db.insert_question("perm-ghost", "missing", "provider-q", "Questions", &questions, None).unwrap();
        assert_eq!(db.permission_kind("perm-q").unwrap().as_deref(), Some("question"));
        assert!(db.permission_kind("perm-ghost").unwrap().is_none());
        let pending = db.snapshot().unwrap()["permissions"].as_array().unwrap().iter().find(|perm| perm["id"] == "perm-q").cloned().unwrap();
        assert_eq!((pending["kind"].as_str(), pending["questions"][0]["id"].as_str()), (Some("question"), Some("q1")));
    }
    #[test]
    fn a_look_may_carry_bitbot_styling_but_only_valid_styling() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-bot","provider":"codex"})).unwrap();
        let styled = json!({"shape":"round","seed":"blob-1","bot":{"shape":"hexagon","shell":"#2b49a3","trim":"#93a6c8","screen":"#e8f2ff"}});
        let made = db.agent_create(&json!({"name":"Botty","runtimeId":"rt-bot","look":styled})).unwrap().0;
        assert_eq!(made["look"], styled);
        for bad in [
            json!({"shape":"round","bot":{"shape":"triangle"}}),
            json!({"shape":"round","bot":{"shell":"blue"}}),
            json!({"shape":"round","bot":{"antenna":true}}),
            json!({"shape":"round","bot":{"speed":2}}),
            json!({"shape":"round","bot":"yes"}),
        ] {
            assert!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt-bot","look":bad})).is_err(), "{bad}");
        }
    }
    #[test]
    fn blob_look_is_validated_saved_updated_and_cleared() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-look","provider":"codex"})).unwrap();
        let plain = db.agent_create(&json!({"name":"Plain","runtimeId":"rt-look"})).unwrap().0;
        assert!(plain["look"].is_null());
        let look = json!({"shape":"sun","seed":"blob-1","traits":{"sun.n":0.5,"eye.rx":1}});
        let made = db.agent_create(&json!({"name":"Sunny","runtimeId":"rt-look","look":look})).unwrap().0;
        assert_eq!(made["look"], look);
        let id = made["id"].as_str().unwrap();
        let (updated, events) = db.agent_update(id, &json!({"look":{"shape":"triangle"}})).unwrap();
        assert_eq!(updated["look"], json!({"shape":"triangle"}));
        assert!(!events.is_empty());
        let (same, none) = db.agent_update(id, &json!({"look":{"shape":"triangle"}})).unwrap();
        assert_eq!(same["look"], json!({"shape":"triangle"}));
        assert!(none.is_empty(), "an unchanged look is not an update");
        assert!(db.agent_update(id, &json!({"look":null})).unwrap().0["look"].is_null());
        for bad in [
            json!("round"), json!({"shape":"star"}), json!({"shape":"round","extra":1}), json!({"shape":"round","seed":""}),
            json!({"shape":"round","traits":{"eye.rx":1.5}}), json!({"shape":"round","traits":{"Eye":0.2}}), json!({"shape":"round","traits":[0.1]}),
        ] {
            assert!(matches!(db.agent_update(id, &json!({"look":bad.clone()})), Err(StorageError::InvalidAgent)), "{bad}");
        }
        let many = (0..49).map(|i| (format!("k{i}"), json!(0.5))).collect::<serde_json::Map<_, _>>();
        assert!(matches!(db.agent_create(&json!({"name":"Many","runtimeId":"rt-look","look":{"shape":"round","traits":many}})), Err(StorageError::InvalidAgent)));
        let listed = db.agent_list(false, None).unwrap();
        assert!(listed.iter().all(|agent| agent.get("look").is_some()));
        assert!(db.snapshot().unwrap()["agents"].as_array().unwrap().iter().all(|agent| agent.get("look").is_some()));
    }
    #[test]
    fn tool_details_are_bounded_provider_neutral_and_merge_start_with_completion() {
        let codex_command = tool_detail("commandExecution", &json!({"type":"commandExecution","command":"npm test","aggregatedOutput":"2 passing","exitCode":0}));
        assert_eq!(codex_command, json!({"command":"npm test","output":"2 passing","exitCode":0,"kind":"commandExecution"}));
        let mcp = tool_detail("mcpToolCall", &json!({"server":"bloblex","tool":"message_blob","arguments":{"blob":"Gogo"},"result":{"content":[{"type":"text","text":"Sent to Gogo."}]}}));
        assert_eq!(mcp["tool"], "bloblex · message_blob");
        assert!(mcp["input"].as_str().unwrap().contains("\"blob\": \"Gogo\""));
        assert_eq!(mcp["result"], "Sent to Gogo.");
        let modern_mcp = tool_detail("mcpToolCall", &json!({"type":"mcpToolCall","server":"bloblex","tool":"message_blob","arguments":{"blob":"Gogo"},"status":"completed","result":{"content":[{"type":"text","text":"Sent to Gogo."}]}}));
        assert_eq!(modern_mcp["resultStatus"], "completed");
        assert_eq!(modern_mcp["result"], "Sent to Gogo.");
        let modern_command = tool_detail("commandExecution", &json!({"type":"commandExecution","command":"cargo test","aggregatedOutput":"2 passing","exitCode":0,"status":"completed"}));
        assert_eq!(modern_command["resultStatus"], "completed");
        assert_eq!(modern_command["output"], "2 passing");
        let progress = tool_detail("mcpToolCall", &json!({"type":"mcpToolCall","progress":"Waiting for teammate"}));
        assert_eq!(progress["progress"], "Waiting for teammate");
        let dynamic = tool_detail("dynamicToolCall", &json!({"type":"dynamicToolCall","namespace":"search","tool":"find_page","arguments":{"query":"quota docs"},"contentItems":[{"type":"inputText","text":"Found usage documentation."}],"success":true,"status":"completed"}));
        assert_eq!(dynamic["tool"], "search · find_page");
        assert!(dynamic["input"].as_str().unwrap().contains("quota docs"));
        assert_eq!(dynamic["result"], "Found usage documentation.");
        assert_eq!(dynamic["success"], true);
        let claude = tool_detail("Bash", &json!({"type":"tool_use","name":"Bash","input":{"command":"ls"}}));
        assert_eq!((claude["command"].as_str(), claude["tool"].as_str()), (Some("ls"), Some("Bash")));
        let claude_result = tool_detail("other", &json!({"type":"tool_result","content":[{"type":"text","text":"a.txt"}],"is_error":false}));
        assert_eq!(claude_result["output"], "a.txt");
        assert_eq!(tool_detail("reasoning", &json!({"type":"reasoning","summary":[],"content":[]})), json!({}));
        let long = "x".repeat(DETAIL_TEXT_LIMIT + 50);
        assert!(tool_detail("exec", &json!({"command":"cat big","aggregatedOutput":long}))["output"].as_str().unwrap().chars().count() <= DETAIL_TEXT_LIMIT + 1);
        let file = file_detail("src/a.ts", &json!({"changes":[{"path":"src/a.ts","kind":{"type":"update"},"diff":"+line"}]}));
        assert_eq!(file, json!({"path":"src/a.ts","change":"update","diff":"+line"}));

        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-tools","provider":"codex"})).unwrap();
        db.create_session("s-tools", "rt-tools", "codex", ".", "Tools").unwrap();
        db.create_turn("t-tools", "s-tools").unwrap();
        db.upsert_tool_in_turn("s-tools", Some("t-tools"), "call", "commandExecution", "npm test", "running", &json!({"command":"npm test"})).unwrap();
        db.upsert_tool_in_turn("s-tools", Some("t-tools"), "call", "other", "Tool", "completed", &json!({"aggregatedOutput":"ok","exitCode":0})).unwrap();
        db.upsert_tool_in_turn("s-tools", Some("t-tools"), "stream", "commandExecution", "cargo test", "running", &json!({"command":"cargo test"})).unwrap();
        db.upsert_tool_in_turn("s-tools", Some("t-tools"), "stream", "other", "Activity", "running", &json!({"type":"commandExecution","outputDelta":"first "})).unwrap();
        db.upsert_tool_in_turn("s-tools", Some("t-tools"), "stream", "other", "Activity", "running", &json!({"type":"commandExecution","outputDelta":"second"})).unwrap();
        db.upsert_tool_in_turn("s-tools", Some("t-tools"), "stream", "other", "Activity", "completed", &json!({"type":"commandExecution","aggregatedOutput":"first second","exitCode":0,"status":"completed"})).unwrap();
        db.insert_file_in_turn("s-tools", Some("t-tools"), "src/a.ts", &json!({"changes":[{"path":"src/a.ts","diff":"+x"}]})).unwrap();
        let detail = db.session_detail("s-tools").unwrap();
        let tool = &detail["tools"][0];
        assert_eq!((tool["turnId"].as_str(), tool["title"].as_str(), tool["state"].as_str()), (Some("t-tools"), Some("npm test"), Some("completed")));
        assert_eq!(tool["detail"]["command"], "npm test", "the command from the start survives the completion");
        assert_eq!(tool["detail"]["output"], "ok");
        let stream = detail["tools"].as_array().unwrap().iter().find(|item| item["id"] == "stream").unwrap();
        assert_eq!(stream["detail"]["command"], "cargo test");
        assert_eq!(stream["detail"]["output"], "first second");
        assert_eq!(stream["detail"]["resultStatus"], "completed");
        assert!(tool["startedAt"].is_string() && tool["completedAt"].is_string());
        assert!(tool.get("raw").is_none(), "raw provider payloads stay in the daemon");
        assert_eq!(detail["files"][0]["turnId"], "t-tools");
        assert_eq!(detail["files"][0]["detail"]["diff"], "+x");
    }

    #[test]
    fn message_reactions_and_reply_sources_are_scoped_and_persisted() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-message","provider":"codex"})).unwrap();
        db.create_session("s-message", "rt-message", "codex", ".", "Message actions").unwrap();
        db.create_session("s-other", "rt-message", "codex", ".", "Other").unwrap();
        db.create_turn("t-message", "s-message").unwrap();
        let source = db.append_message_with_data("s-message", "t-message", "assistant", "**A real reply** with details.", &json!({})).unwrap();
        let message_id = source["id"].as_str().unwrap();
        assert_eq!(db.message_reply_source("s-message", message_id).unwrap()["content"], "**A real reply** with details.");
        assert!(db.message_reply_source("s-other", message_id).is_err(), "a message id from another session cannot be silently resolved");
        let added = db.toggle_message_reaction("s-message", message_id, "👍").unwrap();
        assert_eq!(added["type"], "message.reactions.changed");
        assert_eq!(added["payload"]["reactions"], json!(["👍"]));
        let detail = db.session_detail("s-message").unwrap();
        assert_eq!(detail["messages"][0]["reactions"], json!(["👍"]));
        let removed = db.toggle_message_reaction("s-message", message_id, "👍").unwrap();
        assert_eq!(removed["payload"]["reactions"], json!([]));
        assert!(db.toggle_message_reaction("s-message", message_id, "🔥").is_err(), "only the bounded curated palette is accepted");
        assert!(db.toggle_message_reaction("s-message", "missing", "❤️").is_err());
        assert!(db.toggle_message_reaction("s-other", message_id, "❤️").is_err());
        let notice = db.append_message_with_data("s-message", "t-message", "notice", "Internal notice", &json!({})).unwrap();
        assert!(db.message_reply_source("s-message", notice["id"].as_str().unwrap()).is_err(), "only visible user and assistant messages can be quoted");
        db.update_session_state("s-message", "idle").unwrap();
        db.session_delete("s-message").unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM message_reactions WHERE session_id='s-message'", [], |r| r.get::<_,i64>(0)).unwrap(), 0, "deleting a conversation removes its reactions");
    }

    #[test]
    fn a_message_keeps_at_most_one_reaction_and_toggling_replaces_or_removes_it() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-reaction","provider":"codex"})).unwrap();
        db.create_session("s-react", "rt-reaction", "codex", ".", "Reactions").unwrap();
        db.create_turn("t-react", "s-react").unwrap();
        let message = db.append_message("s-react", "t-react", "assistant", "A reply").unwrap();
        let id = message["id"].as_str().unwrap();
        let first = db.toggle_message_reaction("s-react", id, "👍").unwrap();
        assert_eq!(first["payload"]["reactions"], json!(["👍"]));
        assert_eq!(first["payload"]["selected"], true);
        let replaced = db.toggle_message_reaction("s-react", id, "❤️").unwrap();
        assert_eq!(replaced["payload"]["reactions"], json!(["❤️"]), "a different emoji replaces the previous one");
        assert_eq!(replaced["payload"]["selected"], true);
        assert_eq!(db.session_detail("s-react").unwrap()["messages"][0]["reactions"], json!(["❤️"]));
        let removed = db.toggle_message_reaction("s-react", id, "❤️").unwrap();
        assert_eq!(removed["payload"]["reactions"], json!([]), "toggling the sole reaction removes it");
        assert_eq!(removed["payload"]["selected"], false);
        assert_eq!(db.session_detail("s-react").unwrap()["messages"][0]["reactions"], json!([]));
        // A legacy message that still carries several reactions collapses to the chosen one.
        {
            let conn = db.conn.lock().unwrap();
            for emoji in ["👍", "😂"] {
                conn.execute("INSERT INTO message_reactions(session_id,message_id,emoji,created_at) VALUES(?1,?2,?3,?4)", params!["s-react", id, emoji, "2026-01-01T00:00:00Z"]).unwrap();
            }
        }
        let collapsed = db.toggle_message_reaction("s-react", id, "😂").unwrap();
        assert_eq!(collapsed["payload"]["reactions"], json!(["😂"]), "several reactions collapse to the chosen one");
        assert_eq!(collapsed["payload"]["selected"], true);
        assert_eq!(db.session_detail("s-react").unwrap()["messages"][0]["reactions"], json!(["😂"]));
    }

    #[test]
    fn schema_v11_upgrades_add_reactions_and_survives_reopen_without_losing_messages() {
        let root = std::env::temp_dir().join(format!("bloblex-message-reactions-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("isolated.db");
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-upgrade","provider":"codex"})).unwrap();
            db.create_session("s-upgrade", "rt-upgrade", "codex", ".", "Upgrade").unwrap();
            db.create_turn("t-upgrade", "s-upgrade").unwrap();
            db.append_message("s-upgrade", "t-upgrade", "assistant", "Keep this message").unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("DROP TABLE message_reactions; DROP INDEX idx_messages_session_id_id; DELETE FROM schema_migrations WHERE version=12; PRAGMA user_version=11;").unwrap();
            assert!(schema_v11_valid(&conn).unwrap());
        }
        {
            let db = Storage::open(&path).unwrap();
            let detail = db.session_detail("s-upgrade").unwrap();
            let message_id = detail["messages"][0]["id"].as_str().unwrap();
            assert_eq!(detail["messages"][0]["content"], "Keep this message");
            assert_eq!(db.toggle_message_reaction("s-upgrade", message_id, "🎉").unwrap()["payload"]["reactions"], json!(["🎉"]));
        }
        {
            let db = Storage::open(&path).unwrap();
            assert_eq!(db.session_detail("s-upgrade").unwrap()["messages"][0]["reactions"], json!(["🎉"]));
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ui_preference_settings_validate_default_and_announce_their_changes() {
        let db = Storage::open_in_memory().unwrap();
        // Unset: the daemon stores nothing until the user changes a value.
        let initial = db.settings().unwrap();
        assert!(initial.get("appearance.density").is_none());
        assert!(initial.get("hints.seen").is_none());
        assert!(initial.get("onboarding.tour").is_none());
        // Valid: each key is stored and broadcast as settings.changed.
        assert_eq!(db.set_setting("appearance.density", &json!("compact")).unwrap()[0]["payload"], json!({"key":"appearance.density","value":"compact"}));
        assert!(db.set_setting("appearance.density", &json!("compact")).unwrap().is_empty(), "an unchanged value is not announced");
        assert_eq!(db.set_setting("hints.seen", &json!(["companion.drag"])).unwrap()[0]["payload"], json!({"key":"hints.seen","value":["companion.drag"]}));
        let tour = json!({"version":1,"done":false,"step":2});
        assert_eq!(db.set_setting("onboarding.tour", &tour).unwrap()[0]["payload"], json!({"key":"onboarding.tour","value":tour}));
        let saved = db.settings().unwrap();
        assert_eq!(saved["appearance.density"], "compact");
        assert_eq!(saved["hints.seen"], json!(["companion.drag"]));
        assert_eq!(saved["onboarding.tour"], tour);
        // Invalid: density, hint ids and the tour shape are all rejected.
        assert!(db.set_setting("appearance.density", &json!("tiny")).is_err());
        assert!(db.set_setting("appearance.density", &json!(2)).is_err());
        assert!(db.set_setting("hints.seen", &json!("companion.drag")).is_err());
        assert!(db.set_setting("hints.seen", &json!(["Companion drag"])).is_err());
        assert!(db.set_setting("hints.seen", &json!(["ok", "x".repeat(49)])).is_err());
        let too_many: Vec<String> = (0..65).map(|index| format!("hint-{index}")).collect();
        assert!(db.set_setting("hints.seen", &json!(too_many)).is_err());
        assert!(db.set_setting("onboarding.tour", &json!({"version":1,"done":false})).is_err());
        assert!(db.set_setting("onboarding.tour", &json!({"version":1000,"done":false,"step":0})).is_err());
        assert!(db.set_setting("onboarding.tour", &json!({"version":0,"done":"yes","step":0})).is_err());
        assert!(db.set_setting("onboarding.tour", &json!({"version":0,"done":true,"step":21})).is_err());
    }

    #[test]
    fn experimental_and_companion_settings_announce_their_changes() {
        let db = Storage::open_in_memory().unwrap();
        let events = db.set_setting("experimental.activityDetails", &json!(true)).unwrap();
        assert_eq!(events[0]["type"], "settings.changed");
        assert_eq!(events[0]["payload"], json!({"key":"experimental.activityDetails","value":true}));
        assert!(db.set_setting("experimental.activityDetails", &json!(true)).unwrap().is_empty(), "an unchanged value is not announced");
        assert_eq!(db.set_setting("companion.chatSize", &json!("large")).unwrap()[0]["payload"]["value"], "large");
        assert_eq!(db.set_setting("speech.enabled", &json!(false)).unwrap()[0]["payload"], json!({"key":"speech.enabled","value":false}));
        assert_eq!(db.set_setting("experimental.usageTips", &json!(true)).unwrap()[0]["payload"], json!({"key":"experimental.usageTips","value":true}));
        let dismissal = json!([{"provider":"codex","windowKey":"weekly-primary","resetAt":"2026-10-12T12:00:00Z","threshold":75}]);
        assert_eq!(db.set_setting("experimental.usageTipDismissals", &dismissal).unwrap()[0]["payload"]["value"], dismissal);
        assert!(db.set_setting("experimental.usageTipDismissals", &json!((0..25).map(|index| json!({"provider":"codex","windowKey":format!("weekly-{index}"),"resetAt":null,"threshold":75})).collect::<Vec<_>>())).is_err());
        assert!(db.set_setting("experimental.usageTipDismissals", &json!([{"provider":"codex","windowKey":"bad key","resetAt":null,"threshold":75}])).is_err());
        // C7/C8 companion preferences: a boolean Focus mode and a small map of
        // per-display positions.
        assert_eq!(db.set_setting("companion.focusMode", &json!(true)).unwrap()[0]["payload"], json!({"key":"companion.focusMode","value":true}));
        assert!(db.set_setting("companion.focusMode", &json!("true")).is_err());
        assert!(db.set_setting("companion.focusMode", &json!(1)).is_err());
        let positions = json!({"\\\\.\\DISPLAY1":{"x":120,"y":900},"\\\\.\\DISPLAY2":{"x":-40,"y":12}});
        assert_eq!(db.set_setting("companion.positions", &positions).unwrap()[0]["payload"]["value"], positions);
        assert!(db.set_setting("companion.positions", &json!({"M":{"x":1}})).is_err());
        assert!(db.set_setting("companion.positions", &json!({"M":{"x":"1","y":2}})).is_err());
        assert!(db.set_setting("companion.positions", &json!({"":{"x":1,"y":2}})).is_err());
        let mut too_many_positions = serde_json::Map::new();
        for index in 0..9 { too_many_positions.insert(format!("M{index}"), json!({"x":index,"y":index})); }
        assert!(db.set_setting("companion.positions", &Value::Object(too_many_positions)).is_err());
        assert!(db.set_setting("profile.name", &json!("Sam")).unwrap().is_empty());
    }

    #[test]
    fn queued_prompts_order_reorder_update_and_delete_follow_state_rules() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-queue","provider":"codex"})).unwrap();
        db.create_session("s-queue", "rt-queue", "codex", ".", "Queue").unwrap();
        {
            let c = db.conn.lock().unwrap();
            ensure_queue_schema(&c).unwrap();
            ensure_queue_schema(&c).unwrap();
        }
        assert!(matches!(db.queue_add("missing", &json!({"text":"x"}), "user", None), Err(StorageError::AgentNotFound)));
        let first = db.queue_add("s-queue", &json!({"text":"first","attachments":[]}), "user", None).unwrap();
        let second = db.queue_add("s-queue", &json!({"text":"second","attachments":[]}), "user", None).unwrap();
        let due = "2026-01-01T00:00:05.000Z";
        let scheduled = db.queue_add("s-queue", &json!({"text":"later","attachments":[],"conversationRefs":["ref"],"replyTo":{"sourceSessionId":"s-queue","messageId":"m"}}), "send_later", Some(due)).unwrap();
        let items = db.queue_list("s-queue").unwrap();
        assert_eq!(items.iter().map(|item| item["text"].as_str().unwrap()).collect::<Vec<_>>(), vec!["later","first","second"]);
        assert_eq!(items[0]["kind"], "send_later");
        assert_eq!(items[0]["dueAt"], due);
        assert_eq!(items[0]["conversationRefs"], json!(["ref"]));
        assert_eq!(items[0]["replyTo"]["messageId"], "m");
        let first_id = first["id"].as_str().unwrap().to_owned();
        let second_id = second["id"].as_str().unwrap().to_owned();
        let scheduled_id = scheduled["id"].as_str().unwrap().to_owned();
        assert!(matches!(db.queue_reorder("s-queue", std::slice::from_ref(&second_id)), Err(StorageError::InvalidAgent)), "a partial set is invalid");
        assert!(matches!(db.queue_reorder("s-queue", &[second_id.clone(), second_id.clone()]), Err(StorageError::InvalidAgent)), "duplicates are invalid");
        db.queue_reorder("s-queue", &[second_id.clone(), first_id.clone()]).unwrap();
        let items = db.queue_list("s-queue").unwrap();
        assert_eq!(items.iter().map(|item| item["text"].as_str().unwrap()).collect::<Vec<_>>(), vec!["later","second","first"]);
        let converted = db.queue_update("s-queue", &scheduled_id, Some("scheduled"), Some(None)).unwrap();
        assert_eq!((converted["kind"].as_str(), converted["text"].as_str()), (Some("user"), Some("scheduled")));
        assert!(converted["dueAt"].is_null());
        let claimed = db.queue_claim_next("s-queue", "9999-01-01T00:00:00.000Z", true).unwrap().unwrap();
        let claimed_id = claimed["id"].as_str().unwrap().to_owned();
        assert_eq!(claimed["status"], "sending");
        assert!(matches!(db.queue_update("s-queue", &claimed_id, Some("x"), None), Err(StorageError::AgentConflict)), "only queued items can be edited");
        assert!(matches!(db.queue_delete("s-queue", &claimed_id), Err(StorageError::AgentConflict)), "a sending item cannot be deleted");
        db.queue_mark_failed(&claimed_id, "no longer available").unwrap();
        let failed = db.queue_get("s-queue", &claimed_id).unwrap();
        assert_eq!((failed["status"].as_str(), failed["error"].as_str()), (Some("failed"), Some("no longer available")));
        db.queue_delete("s-queue", &claimed_id).unwrap();
        assert!(matches!(db.queue_delete("s-queue", "missing"), Err(StorageError::AgentNotFound)));
        assert_eq!(db.queue_count_queued("s-queue").unwrap(), 2);
    }

    #[test]
    fn session_delete_cascades_the_prompt_queue_and_restart_fails_interrupted_sends() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-queue2","provider":"codex"})).unwrap();
        db.create_session("s-queue2", "rt-queue2", "codex", ".", "Queue").unwrap();
        let item = db.queue_add("s-queue2", &json!({"text":"x","attachments":[]}), "user", None).unwrap();
        let id = item["id"].as_str().unwrap().to_owned();
        let claimed = db.queue_claim("s-queue2", &id, "2026-01-01T00:00:00.000Z").unwrap().unwrap();
        assert_eq!(claimed["status"], "sending");
        db.recover_after_restart().unwrap();
        let settled = db.queue_get("s-queue2", &id).unwrap();
        assert_eq!(settled["status"], "failed");
        assert_eq!(settled["error"], "Interrupted by a restart. Check the conversation before sending again.");
        db.update_session_state("s-queue2", "idle").unwrap();
        db.session_delete("s-queue2").unwrap();
        assert!(matches!(db.queue_get("s-queue2", &id), Err(StorageError::AgentNotFound)));
    }

    fn split_fixture() -> Storage {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-split","provider":"codex"})).unwrap();
        db.create_session("split", "rt-split", "codex", ".", "Split").unwrap();
        db.create_turn("turn-split", "split").unwrap();
        db
    }

    fn delegation_notice(db: &Storage, session: &str, content: &str) {
        db.append_message_with_data(session, "", "notice", content, &json!({"meta":{"kind":"delegation","direction":"sent"}})).unwrap();
    }

    fn message_shape(db: &Storage, session: &str) -> Vec<(String, String)> {
        db.session_detail(session).unwrap()["messages"].as_array().unwrap().iter()
            .map(|m| (m["role"].as_str().unwrap_or("").to_owned(), m["content"].as_str().unwrap_or("").to_owned()))
            .collect()
    }

    #[test]
    fn a_delegation_notice_sits_above_the_text_its_turn_already_streamed() {
        let db = split_fixture();
        db.append_message("split", "turn-split", "user", "Ask Mate what model they are").unwrap();
        let streamed = db.append_message_delta("split", "turn-split", "I asked Mate. ").unwrap();
        let meta = json!({"meta":{"kind":"delegation","direction":"sent"}});
        let (notice, before) = db.append_notice_above_turn_text("split", "turn-split", "Messaged Mate", &meta).unwrap();
        assert_eq!(before.as_deref(), streamed["id"].as_str(), "the event names the row the notice sits above");
        assert!(notice["sequence"].as_i64() < db.session_detail("split").unwrap()["messages"][2]["sequence"].as_i64());
        // Text that follows the call keeps landing on the same assistant row, below the notice.
        db.append_message_delta("split", "turn-split", "They will reply here.").unwrap();
        // The relayed answer arrives later and reads below.
        db.append_message_with_data("split", "", "notice", "Message from Mate", &json!({"meta":{"kind":"delegation","direction":"received"}})).unwrap();
        assert_eq!(message_shape(&db, "split"), vec![
            ("user".to_owned(), "Ask Mate what model they are".to_owned()),
            ("notice".to_owned(), "Messaged Mate".to_owned()),
            ("assistant".to_owned(), "I asked Mate. They will reply here.".to_owned()),
            ("notice".to_owned(), "Message from Mate".to_owned()),
        ]);
    }

    #[test]
    fn a_delegation_notice_with_no_turn_text_is_an_ordinary_append() {
        let db = split_fixture();
        db.append_message("split", "turn-split", "user", "Ask Mate").unwrap();
        let meta = json!({"meta":{"kind":"delegation","direction":"sent"}});
        let (_, before) = db.append_notice_above_turn_text("split", "turn-split", "Messaged Mate", &meta).unwrap();
        assert!(before.is_none());
        db.append_message_delta("split", "turn-split", "Asked.").unwrap();
        assert_eq!(message_shape(&db, "split"), vec![
            ("user".to_owned(), "Ask Mate".to_owned()),
            ("notice".to_owned(), "Messaged Mate".to_owned()),
            ("assistant".to_owned(), "Asked.".to_owned()),
        ]);
    }

    #[test]
    fn an_above_notice_keeps_a_split_turn_in_order_and_survives_reopen() {
        let dir = std::env::temp_dir().join(format!("bloblex-above-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-above","provider":"codex"})).unwrap();
            db.create_session("above", "rt-above", "codex", ".", "Above").unwrap();
            db.create_turn("turn-above", "above").unwrap();
            db.append_message("above", "turn-above", "user", "Ask").unwrap();
            db.append_message_delta("above", "turn-above", "Preface. ").unwrap();
            let meta = json!({"meta":{"kind":"delegation","direction":"sent"}});
            db.append_notice_above_turn_text("above", "turn-above", "Messaged A", &meta).unwrap();
            db.append_notice_above_turn_text("above", "turn-above", "Messaged B", &meta).unwrap();
            db.append_message_delta("above", "turn-above", "Both asked.").unwrap();
        }
        let db = Storage::open(&path).unwrap();
        let shape = message_shape(&db, "above");
        assert_eq!(shape.iter().map(|(role, content)| format!("{role}:{content}")).collect::<Vec<_>>(), vec![
            "user:Ask".to_owned(), "notice:Messaged A".to_owned(), "notice:Messaged B".to_owned(), "assistant:Preface. Both asked.".to_owned(),
        ]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delegation_notice_splits_assistant_rows_in_sequence_order() {
        let db = split_fixture();
        let first = db.append_message_delta("split", "turn-split", "I asked Mate. ").unwrap();
        delegation_notice(&db, "split", "Messaged Mate");
        let second = db.append_message_delta("split", "turn-split", "Mate could not answer.").unwrap();
        assert_ne!(first["id"], second["id"]);
        assert!(first["sequence"].as_i64() < second["sequence"].as_i64());
        assert_eq!(message_shape(&db, "split"), vec![
            ("assistant".to_owned(), "I asked Mate. ".to_owned()),
            ("notice".to_owned(), "Messaged Mate".to_owned()),
            ("assistant".to_owned(), "Mate could not answer.".to_owned()),
        ]);
        // Later deltas of the same turn keep appending to the split row.
        db.append_message_delta("split", "turn-split", " Waiting.").unwrap();
        assert_eq!(message_shape(&db, "split")[2].1, "Mate could not answer. Waiting.");
    }

    #[test]
    fn non_delegation_notices_keep_a_single_assistant_row() {
        let db = split_fixture();
        db.append_message_delta("split", "turn-split", "First").unwrap();
        db.append_message_with_data("split", "", "notice", "Context reset", &json!({"meta":{"kind":"context_reset"}})).unwrap();
        db.append_message_delta("split", "turn-split", " second").unwrap();
        assert_eq!(message_shape(&db, "split"), vec![
            ("assistant".to_owned(), "First second".to_owned()),
            ("notice".to_owned(), "Context reset".to_owned()),
        ]);
    }

    #[test]
    fn two_delegation_notices_split_a_turn_into_three_rows() {
        let db = split_fixture();
        db.append_message_delta("split", "turn-split", "One").unwrap();
        delegation_notice(&db, "split", "Messaged Mate");
        db.append_message_delta("split", "turn-split", "Two").unwrap();
        delegation_notice(&db, "split", "Reply from Mate");
        db.append_message_delta("split", "turn-split", "Three").unwrap();
        assert_eq!(message_shape(&db, "split"), vec![
            ("assistant".to_owned(), "One".to_owned()),
            ("notice".to_owned(), "Messaged Mate".to_owned()),
            ("assistant".to_owned(), "Two".to_owned()),
            ("notice".to_owned(), "Reply from Mate".to_owned()),
            ("assistant".to_owned(), "Three".to_owned()),
        ]);
    }

    #[test]
    fn split_turn_order_and_text_survive_reopen() {
        let root = std::env::temp_dir().join(format!("bloblex-split-reopen-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-split-file","provider":"codex"})).unwrap();
            db.create_session("split-file", "rt-split-file", "codex", ".", "Split").unwrap();
            db.create_turn("turn-file", "split-file").unwrap();
            db.append_message_delta("split-file", "turn-file", "One").unwrap();
            delegation_notice(&db, "split-file", "Messaged Mate");
            db.append_message_delta("split-file", "turn-file", "Two").unwrap();
        }
        // A reload reads the persisted rows, not any in-memory ordering.
        let db = Storage::open(&path).unwrap();
        assert_eq!(message_shape(&db, "split-file"), vec![
            ("assistant".to_owned(), "One".to_owned()),
            ("notice".to_owned(), "Messaged Mate".to_owned()),
            ("assistant".to_owned(), "Two".to_owned()),
        ]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn finalize_partitions_the_full_turn_text_across_split_rows() {
        let db = split_fixture();
        let first = db.append_message_delta("split", "turn-split", "Alpha").unwrap();
        delegation_notice(&db, "split", "Messaged Mate");
        let second = db.append_message_delta("split", "turn-split", "Beta").unwrap();
        // The provider repeats the whole turn: the pre-split text stays on the
        // first row and only the remainder lands on the split row.
        let done = db.finalize_latest_assistant("split", "turn-split", "AlphaBeta").unwrap();
        assert_eq!(done["id"], second["id"]);
        assert_eq!(done["content"], "Beta");
        assert_eq!(message_shape(&db, "split"), vec![
            ("assistant".to_owned(), "Alpha".to_owned()),
            ("notice".to_owned(), "Messaged Mate".to_owned()),
            ("assistant".to_owned(), "Beta".to_owned()),
        ]);
        // A final message that does not repeat the earlier text cannot be
        // partitioned, so every row keeps what it streamed.
        db.finalize_latest_assistant("split", "turn-split", "Gamma").unwrap();
        assert_eq!(db.session_detail("split").unwrap()["messages"][2]["content"], "Beta");
        assert_ne!(done["id"], first["id"]);
    }

    #[test]
    fn finalize_after_a_notice_starts_the_post_notice_row() {
        let db = split_fixture();
        db.append_message_delta("split", "turn-split", "I asked Mate.").unwrap();
        delegation_notice(&db, "split", "Messaged Mate");
        // The provider never streamed the post-notice text: finalization puts it
        // in a new row after the notice instead of rewriting the earlier one.
        db.finalize_latest_assistant("split", "turn-split", "I asked Mate.Mate replied.").unwrap();
        assert_eq!(message_shape(&db, "split"), vec![
            ("assistant".to_owned(), "I asked Mate.".to_owned()),
            ("notice".to_owned(), "Messaged Mate".to_owned()),
            ("assistant".to_owned(), "Mate replied.".to_owned()),
        ]);
    }

    #[test]
    fn finalize_without_a_split_still_replaces_the_single_row() {
        let db = split_fixture();
        db.append_message_delta("split", "turn-split", "Draft").unwrap();
        let done = db.finalize_latest_assistant("split", "turn-split", "Final text").unwrap();
        assert_eq!(done["content"], "Final text");
        assert_eq!(message_shape(&db, "split"), vec![("assistant".to_owned(), "Final text".to_owned())]);
    }
}

#[cfg(test)]
mod automation_tests {
    use super::*;
    use chrono::{Duration, SecondsFormat};

    fn fixture() -> (Storage, String) {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-auto","provider":"codex"})).unwrap();
        let (agent, _) = db.agent_create(&json!({"name":"Timer","runtimeId":"rt-auto"})).unwrap();
        (db, agent["id"].as_str().unwrap().to_owned())
    }

    fn now_text() -> String {
        chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn cron_task(agent_id: &str, name: &str, enabled: bool) -> Value {
        json!({"agentId":agent_id,"name":name,"prompt":"p","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"Europe/Berlin"},"enabled":enabled})
    }

    #[test]
    fn automation_create_defaults_validates_and_persists() {
        let (db, agent_id) = fixture();
        let created = db
            .automation_create(&json!({"agentId":agent_id,"name":"Morning","prompt":"Say hi","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"Europe/Berlin"}}))
            .unwrap();
        assert_eq!(created["enabled"], false, "new automations default disabled");
        assert_eq!(created["approvalMode"], "auto");
        assert_eq!(created["sessionMode"], "new");
        assert_eq!(created["maxRuntimeSecs"], 1800);
        assert_eq!(created["createdBy"], "user");
        assert_eq!(created["running"], false);
        assert!(created["nextRunAt"].is_string());
        let id = created["id"].as_str().unwrap();
        assert_eq!(db.automation_get(id).unwrap()["name"], "Morning");
        assert_eq!(db.automation_list(Some(&agent_id)).unwrap().len(), 1);
        assert_eq!(db.automation_count().unwrap(), 1);

        let future = (chrono::Utc::now() + Duration::days(1)).to_rfc3339();
        assert_eq!(db.automation_create(&json!({"agentId":agent_id,"name":"Once","prompt":"x","schedule":{"kind":"once","at":future}})).unwrap()["enabled"], false);
        assert_eq!(db.automation_count().unwrap(), 2);

        for bad in [
            json!({"agentId":agent_id,"name":"","prompt":"x","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"UTC"}}),
            json!({"agentId":agent_id,"name":"x","prompt":"","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"UTC"}}),
            json!({"agentId":agent_id,"name":"x","prompt":"y","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"Nope/Nope"}}),
            json!({"agentId":agent_id,"name":"x","prompt":"y","schedule":{"kind":"cron","cron":"bogus","timezone":"UTC"}}),
            json!({"agentId":agent_id,"name":"x","prompt":"y","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"UTC"},"approvalMode":"bypass"}),
            json!({"agentId":agent_id,"name":"x","prompt":"y","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"UTC"},"approvalMode":"ask"}),
            json!({"agentId":agent_id,"name":"x","prompt":"y","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"UTC"},"maxRuntimeSecs":10}),
            json!({"agentId":agent_id,"name":"x","prompt":"y","schedule":{"kind":"once","at":(chrono::Utc::now()+Duration::seconds(10)).to_rfc3339()}}),
            json!({"agentId":"missing","name":"x","prompt":"y","schedule":{"kind":"cron","cron":"0 9 * * *","timezone":"UTC"}}),
        ] {
            assert!(db.automation_create(&bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn automation_update_pause_resume_and_delete_behave() {
        let (db, agent_id) = fixture();
        let created = db.automation_create(&cron_task(&agent_id, "First", true)).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["enabled"], true);
        let updated = db.automation_update(&id, &json!({"name":"Renamed","maxRuntimeSecs":600})).unwrap();
        assert_eq!(updated["name"], "Renamed");
        assert_eq!(updated["maxRuntimeSecs"], 600);
        assert!(db.automation_update(&id, &json!({"approvalMode":"bypass"})).is_err());
        let paused = db.automation_pause(&id).unwrap();
        assert_eq!(paused["enabled"], false);
        assert_eq!(paused["pauseReason"], "user");
        let resumed = db.automation_resume(&id).unwrap();
        assert_eq!(resumed["enabled"], true);
        assert_eq!(resumed["pauseReason"], Value::Null);
        assert_eq!(resumed["consecutiveFailures"], 0);
        for index in 0..49 {
            db.automation_create(&cron_task(&agent_id, &format!("Task {index}"), false)).unwrap();
        }
        assert!(db.automation_create(&cron_task(&agent_id, "Overflow", false)).is_err(), "50 automation cap");
        db.automation_run_insert("run-keep", &id, Some("sess-keep"), "completed", None, None, &now_text()).unwrap();
        db.automation_delete(&id).unwrap();
        assert!(db.automation_get(&id).is_err());
        assert_eq!(db.automation_run_get("run-keep").unwrap()["status"], "completed", "run history survives deletion");
        assert!(db.automation_delete("missing").is_err());
    }

    #[test]
    fn automation_runs_are_single_flight_and_ordered_newest_first() {
        let (db, agent_id) = fixture();
        let created = db.automation_create(&cron_task(&agent_id, "Runs", true)).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        db.automation_run_insert("r1", &id, Some("s1"), "running", None, None, "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(db.automation_running_count().unwrap(), 1);
        assert!(db.automation_run_running_for(&id).unwrap().is_some());
        assert!(db.automation_run_insert("r2", &id, Some("s2"), "running", None, None, &now_text()).is_err(), "single-flight unique index");
        assert!(db.automation_run_finish("r1", "completed", Some("late:120")).unwrap().is_some());
        assert!(db.automation_run_finish("r1", "failed", None).unwrap().is_none(), "already finished");
        db.automation_run_insert("r2", &id, Some("s2"), "failed", Some("provider_error"), None, "2026-01-02T00:00:00.000Z").unwrap();
        db.automation_run_insert("r3", &id, Some("s3"), "skipped", Some("still_running"), None, "2026-01-03T00:00:00.000Z").unwrap();
        let runs = db.automation_runs_list(&id, 10, None).unwrap();
        assert_eq!(runs[0]["id"], "r3", "newest first");
        assert_eq!(runs[2]["id"], "r1");
        let page = db.automation_runs_list(&id, 10, Some("r3")).unwrap();
        assert_eq!(page[0]["id"], "r2");
        assert_eq!(page.len(), 2);
        assert_eq!(db.automation_interrupt_running().unwrap(), 0);
        db.automation_run_insert("r4", &id, Some("s4"), "running", None, None, &now_text()).unwrap();
        assert_eq!(db.automation_interrupt_running().unwrap(), 1);
        assert_eq!(db.automation_run_get("r4").unwrap()["status"], "interrupted");
    }

    #[test]
    fn automation_settings_and_agent_pause_are_validated() {
        let (db, agent_id) = fixture();
        assert!(db.set_setting("automations.paused", &json!("yes")).is_err());
        assert!(db.set_setting("automations.maxConcurrent", &json!(0)).is_err());
        assert!(db.set_setting("automations.maxConcurrent", &json!(4)).is_err());
        assert_eq!(db.set_setting("automations.paused", &json!(true)).unwrap()[0]["payload"], json!({"key":"automations.paused","value":true}));
        assert_eq!(db.set_setting("automations.maxConcurrent", &json!(2)).unwrap()[0]["type"], "settings.changed");
        let created = db.automation_create(&cron_task(&agent_id, "Agent task", true)).unwrap();
        assert_eq!(created["enabled"], true);
        let paused = db.automation_pause_for_agent(&agent_id).unwrap();
        assert_eq!(paused.len(), 1);
        assert_eq!(paused[0]["enabled"], false);
        assert_eq!(paused[0]["pauseReason"], "user");
        assert!(db.automation_pause_for_agent(&agent_id).unwrap().is_empty(), "already paused");
    }
}

#[cfg(test)]
mod memory_tests {
    use super::*;

    fn fixture() -> (Storage, String, String) {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-mem","provider":"codex","status":"online"})).unwrap();
        let (agent, _) = db.agent_create(&json!({"name":"Memory","runtimeId":"rt-mem"})).unwrap();
        let (project, _) = db.project_create("Proj", None).unwrap();
        (db, agent["id"].as_str().unwrap().to_owned(), project["id"].as_str().unwrap().to_owned())
    }
    fn note(scope: &str, scope_id: Option<&str>, title: &str, body: &str) -> Value {
        let mut input = json!({"scope":scope,"kind":"fact","title":title,"body":body});
        if let Some(id) = scope_id { input["scopeId"] = json!(id); }
        input
    }

    #[test]
    fn fts5_is_available_and_schema_is_idempotent() {
        let (db, agent, _) = fixture();
        {
            let c = db.conn.lock().unwrap();
            ensure_memory_schema(&c).unwrap();
            ensure_memory_schema(&c).unwrap();
            let fts: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_fts')", [], |r| r.get(0)).unwrap();
            assert!(fts, "bundled rusqlite must provide FTS5");
        }
        db.memory_create(&note("blob", Some(&agent), "Deploy notes", "The release runs on staging first")).unwrap();
        let hits = db.memory_visible_search(&agent, None, "release", 8).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["title"], "Deploy notes");
    }

    #[test]
    fn a_query_is_ranked_by_relevance() {
        let (db, agent, _) = fixture();
        db.memory_create(&note("blob", Some(&agent), "Second", "ranking appears once")).unwrap();
        db.memory_create(&note("blob", Some(&agent), "First", "ranking ranking ranking")).unwrap();
        let hits = db.memory_visible_search(&agent, None, "ranking", 8).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["title"], "First", "the denser match ranks first");
    }

    #[test]
    fn crud_and_optimistic_versions() {
        let (db, agent, _) = fixture();
        let created = db.memory_create(&note("blob", Some(&agent), "Coffee", "The user prefers oat milk")).unwrap();
        assert_eq!(created["version"], 1);
        assert_eq!(created["reviewed"], true);
        assert_eq!(created["origin"], "user");
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(db.memory_get(&id).unwrap()["title"], "Coffee");
        let updated = db.memory_update(&id, 1, &json!({"body":"The user prefers oat milk, no sugar"}), "user").unwrap();
        assert_eq!(updated["version"], 2);
        assert_eq!(updated["body"], "The user prefers oat milk, no sugar");
        assert!(matches!(db.memory_update(&id, 1, &json!({"title":"Stale"}), "user"), Err(StorageError::AgentConflict)));
        assert!(matches!(db.memory_update(&id, 2, &json!({"importance":200}), "user"), Err(StorageError::InvalidAgent)));
        assert_eq!(db.memory_list(&json!({})).unwrap().len(), 1);
        assert_eq!(db.memory_list(&json!({"scope":"blob","scopeId":agent})).unwrap().len(), 1);
        assert_eq!(db.memory_list(&json!({"scope":"project"})).unwrap().len(), 0);
        assert_eq!(db.memory_list(&json!({"query":"oat"})).unwrap().len(), 1);
        assert_eq!(db.memory_list(&json!({"query":"missing-term"})).unwrap().len(), 0);
    }

    #[test]
    fn soft_delete_restore_and_version_history() {
        let (db, agent, _) = fixture();
        let created = db.memory_create(&note("blob", Some(&agent), "Note", "initial body")).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        let deleted = db.memory_delete(&id, Some(1), "user").unwrap();
        assert!(deleted["deletedAt"].is_string());
        assert_eq!(db.memory_list(&json!({})).unwrap().len(), 0, "soft-deleted records leave the list");
        assert_eq!(db.memory_list(&json!({"includeDeleted":true})).unwrap().len(), 1);
        assert_eq!(db.memory_visible_search(&agent, None, "initial", 8).unwrap().len(), 0, "deleted rows leave the index");
        assert!(matches!(db.memory_delete(&id, None, "user"), Err(StorageError::AgentConflict)));
        let restored = db.memory_restore(&id).unwrap();
        assert!(restored["deletedAt"].is_null());
        assert_eq!(db.memory_visible_search(&agent, None, "initial", 8).unwrap().len(), 1);
        for index in 0..15 {
            db.memory_update(&id, index + 1, &json!({"body": format!("body {index}")}), "user").unwrap();
        }
        let c = db.conn.lock().unwrap();
        let versions: i64 = c.query_row("SELECT COUNT(*) FROM memory_versions WHERE record_id=?1", [&id], |r| r.get(0)).unwrap();
        assert_eq!(versions, 10, "only the ten newest versions are kept");
    }

    #[test]
    fn catalog_orders_pinned_then_importance_then_recency() {
        let (db, agent, _) = fixture();
        db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"fact","title":"A","body":"aaa","importance":10})).unwrap();
        db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"fact","title":"B","body":"bbb","importance":1,"pinned":true})).unwrap();
        db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"fact","title":"C","body":"ccc","importance":90})).unwrap();
        let order = db.memory_visible_catalog(&agent, None).unwrap().iter().map(|record| record["title"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(order, ["B", "C", "A"]);
    }

    #[test]
    fn caps_are_enforced_per_scope() {
        let (db, agent, _) = fixture();
        for index in 0..300 {
            db.memory_create(&note("blob", Some(&agent), &format!("Note {index}"), "body")).unwrap();
        }
        assert!(matches!(db.memory_create(&note("blob", Some(&agent), "Overflow", "body")), Err(StorageError::InvalidAgent)));
    }

    #[test]
    fn visibility_is_scoped_to_blob_project_and_shared() {
        let (db, agent_a, project) = fixture();
        let (agent_b, _) = db.agent_create(&json!({"name":"Other","runtimeId":"rt-mem"})).unwrap();
        let agent_b = agent_b["id"].as_str().unwrap().to_owned();
        db.memory_create(&note("blob", Some(&agent_a), "A private", "only agent a")).unwrap();
        db.memory_create(&note("blob", Some(&agent_b), "B private", "only agent b")).unwrap();
        db.memory_create(&note("project", Some(&project), "Project", "shared within the project")).unwrap();
        db.memory_create(&note("shared", None, "Shared", "everyone")).unwrap();
        let catalog = db.memory_visible_catalog(&agent_a, Some(&project)).unwrap();
        let titles = catalog.iter().filter_map(|row| row["title"].as_str()).collect::<Vec<_>>();
        assert!(titles.contains(&"A private") && titles.contains(&"Project") && titles.contains(&"Shared"));
        assert!(!titles.contains(&"B private"), "another blob's private notes are never visible");
        let b_catalog = db.memory_visible_catalog(&agent_b, None).unwrap();
        let b_titles = b_catalog.iter().filter_map(|row| row["title"].as_str()).collect::<Vec<_>>();
        assert!(!b_titles.contains(&"A private") && !b_titles.contains(&"Project"), "no project when the blob has none");
        assert!(db.memory_visible_get(catalog[0]["id"].as_str().unwrap(), &agent_a, Some(&project)).unwrap().is_some());
    }

    #[test]
    fn unreviewed_records_are_hidden_until_approved() {
        let (db, agent, _) = fixture();
        let mut input = note("blob", Some(&agent), "Agent note", "written by the agent");
        input["origin"] = json!("agent");
        input["reviewed"] = json!(false);
        let created = db.memory_create(&input).unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["reviewed"], false);
        assert_eq!(db.memory_visible_search(&agent, None, "agent", 8).unwrap().len(), 0, "unreviewed records are not searchable");
        assert!(db.memory_visible_get(&id, &agent, None).unwrap().is_none());
        assert_eq!(db.memory_visible_catalog(&agent, None).unwrap().len(), 0);
        assert_eq!(db.memory_list(&json!({"status":"unreviewed"})).unwrap().len(), 1, "the review list still sees it");
        let approved = db.memory_approve(&id).unwrap();
        assert_eq!(approved["reviewed"], true);
        assert_eq!(db.memory_visible_search(&agent, None, "agent", 8).unwrap().len(), 1);
        assert!(db.memory_visible_get(&id, &agent, None).unwrap().is_some());
        assert_eq!(db.memory_visible_catalog(&agent, None).unwrap().len(), 1);
    }

    #[test]
    fn create_validates_scope_scope_id_kind_and_lengths() {
        let (db, agent, _) = fixture();
        assert!(db.memory_create(&json!({"scope":"galaxy","kind":"fact","title":"t","body":"b"})).is_err());
        assert!(db.memory_create(&json!({"scope":"blob","scopeId":"missing","kind":"fact","title":"t","body":"b"})).is_err());
        assert!(db.memory_create(&json!({"scope":"project","scopeId":"missing","kind":"fact","title":"t","body":"b"})).is_err());
        assert!(db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"rumour","title":"t","body":"b"})).is_err());
        assert!(db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"fact","title":"","body":"b"})).is_err());
        assert!(db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"fact","title":&"t".repeat(121),"body":"b"})).is_err());
        assert!(db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"fact","title":"t","body":&"b".repeat(2001)})).is_err());
        assert!(db.memory_create(&json!({"scope":"blob","scopeId":agent,"kind":"fact","title":"t","body":"b","tags":["a","b","c","d","e","f","g","h","i"]})).is_err());
        assert!(db.memory_create(&json!({"scope":"shared","kind":"fact","title":"t","body":"b","tags":[]})).is_ok());
    }

    #[test]
    fn notification_level_column_is_idempotent_and_round_trips_in_dtos_and_events() {
        let root = std::env::temp_dir().join(format!("bloblex-notify-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        let kept_id;
        {
            let db = Storage::open(&path).unwrap();
            db.upsert_runtime(&json!({"id":"rt-notify","provider":"codex"})).unwrap();
            let (agent, events) = db.agent_create(&json!({"name":"Quiet","runtimeId":"rt-notify","notificationLevel":"muted"})).unwrap();
            assert_eq!(agent["notificationLevel"], "muted");
            assert_eq!(events[0]["payload"]["notificationLevel"], "muted");
            kept_id = agent["id"].as_str().unwrap().to_owned();
            let (default_agent, _) = db.agent_create(&json!({"name":"Loud","runtimeId":"rt-notify"})).unwrap();
            assert_eq!(default_agent["notificationLevel"], "all", "a missing level normalises to all");
            assert!(db.agent_list(false, None).unwrap()[0]["notificationLevel"].is_string());
            let columns: i64 = db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name='notification_level'", [], |r| r.get(0)).unwrap();
            assert_eq!(columns, 1);
            assert!(db.agent_create(&json!({"name":"Bad","runtimeId":"rt-notify","notificationLevel":"loud"})).is_err());
            let (updated, events) = db.agent_update(&kept_id, &json!({"notificationLevel":"input"})).unwrap();
            assert_eq!(updated["notificationLevel"], "input");
            assert_eq!(events[0]["payload"]["notificationLevel"], "input");
            let (cleared, _) = db.agent_update(&kept_id, &json!({"notificationLevel":null})).unwrap();
            assert_eq!(cleared["notificationLevel"], "all");
            assert!(db.agent_update(&kept_id, &json!({"notificationLevel":"loud"})).is_err());
        }
        {
            // Reopening an existing database re-runs the additive column ensure.
            let db = Storage::open(&path).unwrap();
            assert_eq!(db.agent_get(&kept_id).unwrap()["notificationLevel"], "all");
            let columns: i64 = db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name='notification_level'", [], |r| r.get(0)).unwrap();
            assert_eq!(columns, 1);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_project_backfill_is_idempotent() {
        let db = Storage::open_in_memory().unwrap();
        db.upsert_runtime(&json!({"id":"rt-p","provider":"codex"})).unwrap();
        let project = db.project_create("Repo", Some("C:/repo")).unwrap().0;
        let project_id = project["id"].as_str().unwrap().to_owned();
        db.create_session("old", "rt-p", "codex", "C:/repo", "Old").unwrap();
        // Clear the marker and run the one-off backfill as an older database would.
        {
            let c = db.conn.lock().unwrap();
            c.execute("DELETE FROM settings WHERE key='migration.sessionProjectBackfill'", []).unwrap();
            ensure_session_project_backfill(&c).unwrap();
            let stamp: Option<String> = c.query_row("SELECT json_extract(data,'$.projectId') FROM sessions WHERE id='old'", [], |r| r.get(0)).unwrap();
            assert_eq!(stamp.as_deref(), Some(project_id.as_str()));
        }
        // With the marker set, a later run rewrites nothing.
        db.conn.lock().unwrap().execute("UPDATE sessions SET data=json_remove(data,'$.projectId') WHERE id='old'", []).unwrap();
        {
            let c = db.conn.lock().unwrap();
            ensure_session_project_backfill(&c).unwrap();
            let stamp: Option<String> = c.query_row("SELECT json_extract(data,'$.projectId') FROM sessions WHERE id='old'", [], |r| r.get(0)).unwrap();
            assert_eq!(stamp, None, "the marker keeps the backfill to a single run");
        }
        // A session outside every project stays unstamped.
        db.create_session("elsewhere", "rt-p", "codex", "C:/elsewhere", "Other").unwrap();
        {
            let c = db.conn.lock().unwrap();
            c.execute("DELETE FROM settings WHERE key='migration.sessionProjectBackfill'", []).unwrap();
            ensure_session_project_backfill(&c).unwrap();
            let stamp: Option<String> = c.query_row("SELECT json_extract(data,'$.projectId') FROM sessions WHERE id='elsewhere'", [], |r| r.get(0)).unwrap();
            assert_eq!(stamp, None);
        }
    }
}
