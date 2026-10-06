use chrono::{DateTime, Datelike, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{backup::Backup, params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};
use thiserror::Error;
use uuid::Uuid;

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
    let gates=[("exec_gate.claude.model",true),("exec_gate.claude.thinking",true),("exec_gate.claude.instructions",true),("exec_gate.codex.model",true),("exec_gate.codex.thinking",true),("exec_gate.codex.serviceTier",true),("exec_gate.codex.instructions",true),("exec_gate.opencode.model",true),("exec_gate.opencode.thinking",false),("exec_gate.opencode.instructions",true)];
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

fn push_settings_event(tx:&Transaction<'_>,key:&str,enabled:bool)->Result<Value,StorageError>{
    let payload=json!({"key":key,"enabled":enabled});let id=Uuid::new_v4().to_string();let ts=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
    tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'settings.changed',?3)",params![id,ts,payload.to_string()])?;
    Ok(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":"settings.changed","payload":payload}))
}

pub struct Storage {
    conn: Mutex<Connection>,
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
            if ledger>11||(user!=0&&user!=ledger)||(ledger>=2&&user!=ledger){return Err(StorageError::InvalidAgent)}
            if ledger==11 {
                if !schema_v11_valid(&conn)? { return Err(StorageError::InvalidAgent); }
                return Ok(Self { conn: Mutex::new(conn) });
            }
            if ledger==10 {
                if !schema_v10_valid(&conn)? { return Err(StorageError::InvalidAgent); }
                let backup_done = if let Some(path) = path { verified_backup(&conn, path, 10)?; true } else { false };
                migrate_session_model_lock(&mut conn, path, backup_done)?;
                return Ok(Self { conn: Mutex::new(conn) });
            }
            if ledger==9 {
                if !schema_v9_valid(&conn)? { return Err(StorageError::InvalidAgent); }
                let backup_done = if let Some(path) = path { verified_backup(&conn, path, 9)?; true } else { false };
                migrate_quota_snapshots(&mut conn, path, backup_done)?;
                let model_lock_backup = if let Some(path) = path { verified_backup(&conn, path, 10)?; true } else { false };
                migrate_session_model_lock(&mut conn, path, model_lock_backup)?;
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
            if ledger>11||(user!=0&&user!=ledger)||(ledger>=2&&user!=ledger){return Err(StorageError::InvalidAgent)}
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
        if path.is_some() { let ledger:i64=conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))?; if ledger==3 { verified_backup(&conn,path.unwrap(),3)?; backup_v3_done=true; } }
        migrate_approval_modes(&mut conn,path,backup_v3_done)?;
        let mut backup_v4_done = false;
        if path.is_some() {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 4 { verified_backup(&conn, path.unwrap(), 4)?; backup_v4_done = true; }
        }
        migrate_turn_analytics(&mut conn, path, backup_v4_done)?;
        migrate_context_failure_class(&mut conn)?;
        migrate_session_controls(&mut conn, path, backup_v5_done)?;
        migrate_agent_outfits(&mut conn, path, backup_v6_done)?;
        let backup_v7_done = if path.is_some() {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 7 { verified_backup(&conn, path.unwrap(), 7)?; true } else { false }
        } else { false };
        migrate_exact_price_overrides(&mut conn, path, backup_v7_done)?;
        let backup_v8_done = if path.is_some() {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 8 { verified_backup(&conn, path.unwrap(), 8)?; true } else { false }
        } else { false };
        migrate_agent_outfit_ids(&mut conn, path, backup_v8_done)?;
        let backup_v9_done = if path.is_some() {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 9 { verified_backup(&conn, path.unwrap(), 9)?; true } else { false }
        } else { false };
        migrate_quota_snapshots(&mut conn, path, backup_v9_done)?;
        let backup_v10_done = if path.is_some() {
            let ledger: i64 = conn.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))?;
            if ledger == 10 { verified_backup(&conn, path.unwrap(), 10)?; true } else { false }
        } else { false };
        migrate_session_model_lock(&mut conn, path, backup_v10_done)?;
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
            let mut q=c.prepare("SELECT json_object('id',id,'name',name,'description',description,'instructions',instructions,'color',color,'outfit',outfit,'runtimeId',runtime_id,'model',model,'thinking',thinking,'serviceTier',service_tier,'approvalMode',approval_mode,'effectiveApprovalMode',COALESCE(approval_mode,(SELECT json_extract(value,'$') FROM settings WHERE key='permissions.default_mode'),'ask'),'customArgs',json(custom_args),'customEnv',json(custom_env),'maxConcurrency',max_concurrency,'defaultProject',default_project,'sortOrder',sort_order,'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at) FROM agents WHERE (?1 OR archived=0) AND (?2 IS NULL OR runtime_id=?2) ORDER BY runtime_id,sort_order,created_at,id")?;
            let vals=q.query_map(params![include_archived,runtime_id],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            vals.into_iter().map(|v|Ok(serde_json::from_str(&v)?)).collect()
        }
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
        let mut next=old.clone(); for k in ["name","runtimeId","description","instructions","color","outfit","model","thinking","serviceTier","approvalMode","customArgs","customEnv","maxConcurrency","defaultProject"]{if let Some(v)=input.get(k){next[k]=v.clone();}}
        let name=next["name"].as_str().unwrap_or("").trim().to_owned(); let key=name.to_lowercase(); ensure_name_free(&tx,&key,Some(id))?;
        let old_runtime=old["runtimeId"].as_str().unwrap_or("").to_owned(); let runtime=next["runtimeId"].as_str().unwrap_or("").to_owned(); if !runtime_exists(&tx,&runtime)?{return Err(StorageError::AgentNotFound)}
        let old_order=if runtime!=old_runtime{active_order(&tx,&old_runtime)?}else{vec![]};
        let unchanged= ["name","runtimeId","description","instructions","color","outfit","model","thinking","serviceTier","approvalMode","customArgs","customEnv","maxConcurrency","defaultProject"].iter().all(|k|next[*k]==old[*k]);
        if unchanged { tx.commit()?; return Ok((old,vec![])); }
        let color=next["color"].as_str().unwrap_or("mint");let color=if color.starts_with('#'){color.to_ascii_uppercase()}else{color.to_owned()};
        let now=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);
        if runtime!=old_runtime { let pos:i64=tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM agents WHERE runtime_id=?1 AND archived=0",[&runtime],|r|r.get(0))?;tx.execute("UPDATE agents SET runtime_id=?2,sort_order=?3 WHERE id=?1",params![id,runtime,pos])?;shift_active(&tx,&old_runtime)?;let old_ids=old_order.iter().filter(|a|a["id"]!=id).map(|a|a["id"].as_str().unwrap_or("").to_owned()).collect::<Vec<_>>();assign_active_order(&tx,&old_ids,&old_order,&now)?; }
        tx.execute("UPDATE agents SET name=?2,name_key=?3,description=?4,instructions=?5,color=?6,outfit=?7,model=?8,thinking=?9,service_tier=?10,approval_mode=?11,custom_args=?12,custom_env=?13,max_concurrency=?14,default_project=?15,updated_at=?16 WHERE id=?1",params![id,name,key,next["description"].as_str().unwrap_or(""),next["instructions"].as_str().unwrap_or(""),color,next["outfit"].as_str().unwrap_or("auto"),nullable(&next["model"]),nullable(&next["thinking"]),nullable(&next["serviceTier"]),nullable(&next["approvalMode"]),next["customArgs"].to_string(),next["customEnv"].to_string(),next["maxConcurrency"].as_i64().unwrap_or(1),nullable(&next["defaultProject"]),now])?;
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
        if snapshot["provider"]=="codex"&&outcomes["instructions"]["applied"]==true { tx.execute("UPDATE sessions SET codex_thread_instruction_sha256=COALESCE(codex_thread_instruction_sha256,?2) WHERE id=?1",params![snapshot["sessionId"].as_str().unwrap_or(""),snapshot["instructionSha256"].as_str()])?; }
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
        let mut s=c.prepare("SELECT id,runtime_id,provider,provider_session_id,project_path,COALESCE(title_override,title),state,resumable,created_at,updated_at,agent_id,archived,model_lock_json FROM sessions WHERE (?1 OR archived=0) ORDER BY updated_at DESC")?;
        let iter=s.query_map([include_archived],|r|Ok(json!({"id":r.get::<_,String>(0)?,"runtimeId":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?,"providerSessionId":r.get::<_,Option<String>>(3)?,"projectPath":r.get::<_,String>(4)?,"title":r.get::<_,String>(5)?,"state":r.get::<_,String>(6)?,"resumable":r.get::<_,bool>(7)?,"createdAt":r.get::<_,String>(8)?,"updatedAt":r.get::<_,String>(9)?,"agentId":r.get::<_,Option<String>>(10)?,"archived":r.get::<_,bool>(11)?,"modelLock":r.get::<_,Option<String>>(12)?.and_then(|value|serde_json::from_str::<Value>(&value).ok())})))?;
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
        tx.execute("DELETE FROM app_events WHERE json_valid(payload) AND (json_extract(payload,'$.sessionId')=?1 OR json_extract(payload,'$.session.id')=?1 OR (event_type='session.changed' AND json_extract(payload,'$.id')=?1))", [id])?;
        tx.execute("DELETE FROM sessions WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
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
            let values = rows.collect::<Result<Vec<_>, _>>()?;
            values
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
        c.execute("INSERT INTO messages(id,session_id,turn_id,sequence,role,content,created_at) VALUES(?1,?2,NULLIF(?3,''),?4,?5,?6,?7)",params![id,session,turn,sequence,role,content,now])?;
        Ok(
            json!({"id":id,"sessionId":session,"turnId":turn,"sequence":sequence,"role":role,"content":content,"createdAt":now}),
        )
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
        let row:Option<(String,String,i64,String)>=c.query_row("SELECT id,content,sequence,created_at FROM messages WHERE session_id=?1 AND role=?2 AND ((?3='' AND turn_id IS NULL) OR turn_id=?3) ORDER BY sequence DESC LIMIT 1",params![session,role,turn],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
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
    pub fn finalize_latest_assistant(
        &self,
        session: &str,
        turn: &str,
        content: &str,
    ) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(Value::Null); }
        let row:Option<(String,i64,String)>=c.query_row("SELECT id,sequence,created_at FROM messages WHERE session_id=?1 AND role='assistant' AND turn_id=?2 ORDER BY sequence DESC LIMIT 1",params![session,turn],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((id, seq, created)) = row {
            c.execute(
                "UPDATE messages SET content=?2 WHERE id=?1",
                params![id, content],
            )?;
            Ok(
                json!({"id":id,"sessionId":session,"turnId":turn,"sequence":seq,"role":"assistant","content":content,"createdAt":created}),
            )
        } else {
            drop(c);
            self.append_message(session, turn, "assistant", content)
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
    pub fn upsert_tool(
        &self,
        session: &str,
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
        let v =
            json!({"id":id,"sessionId":session,"kind":kind,"title":title,"state":state,"raw":raw});
        c.execute("INSERT INTO tool_calls(id,session_id,state,data) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",params![id,session,state,v.to_string()])?;
        Ok(v)
    }
    pub fn insert_file(&self, session: &str, path: &str, raw: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)", [session], |r| r.get(0))?;
        if !exists { return Ok(()); }
        c.execute(
            "INSERT INTO file_changes(id,session_id,path,data) VALUES(?1,?2,?3,?4)",
            params![Uuid::new_v4().to_string(), session, path, raw.to_string()],
        )?;
        Ok(())
    }
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
        let found:Option<(String,Option<String>,String)>=tx.query_row("SELECT session_id,provider_request_id,data FROM permission_requests WHERE id=?1 AND status='pending'",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((session, provider, data)) = found else {
            tx.rollback()?;
            return Ok(None);
        };
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
        if !["policy:auto","policy:bypass"].contains(&resolved_by){return Err(StorageError::InvalidAgent)}
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
        let (used, size) = session_context_locked(&c, id)?;
        Ok((used.and_then(|value| u64::try_from(value).ok()), size.and_then(|value| u64::try_from(value).ok())))
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
        if k=="permissions.default_mode" && !v.as_str().is_some_and(|s|["ask","auto"].contains(&s)){return Err(StorageError::InvalidAgent)}
        if k=="notifications.enabled" && !v.is_boolean(){return Err(StorageError::InvalidAgent)}
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous:Option<String>=tx.query_row("SELECT value FROM settings WHERE key=?1",[k],|r|r.get(0)).optional()?;
        tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![k,v.to_string()])?;
        let mut events=Vec::new();
        if k.starts_with("exec_gate.") {
            let enabled=v.as_bool().ok_or(StorageError::InvalidAgent)?;
            let same=previous.as_deref().and_then(|old|serde_json::from_str::<Value>(old).ok()).as_ref()==Some(v);
            if !same { events.push(push_settings_event(&tx,k,enabled)?); }
        } else if k=="permissions.default_mode" {
            let same=previous.as_deref().and_then(|old|serde_json::from_str::<Value>(old).ok()).as_ref()==Some(v);
            if !same {let payload=json!({"key":k,"mode":v});let id=Uuid::new_v4().to_string();let ts=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'settings.changed',?3)",params![id,ts,payload.to_string()])?;events.push(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":"settings.changed","payload":payload}));}
        }
        tx.commit()?;Ok(events)
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
            "SELECT json_object('id',p.id,'sessionId',p.session_id,'runtimeId',s.runtime_id,'title',json_extract(p.data,'$.title'),'detail',json_extract(p.data,'$.detail'),'choices',json_extract(p.data,'$.choices'),'status',p.status,'expiresAt',p.expires_at) FROM permission_requests p JOIN sessions s ON s.id=p.session_id WHERE p.status='pending' AND s.archived=0 ORDER BY p.rowid",
            "",
        )?;
        let usage = self.usage_rows_locked(c)?;
        let settings = self.settings_locked(c)?;
        let agents=self.agent_rows_locked(c,true)?;
        let result=json!({"snapshotVersion":1,"sequence":seq,"daemon":{"state":"ready"},"hosts":[{"id":"host_windows_local","name":std::env::var("COMPUTERNAME").unwrap_or_else(|_|"Windows Local".into()),"kind":"windows","status":"online"}],"runtimes":runtimes,"sessions":session_values,"agents":agents,"permissions":permissions,"usageSummary":usage,"settings":settings});
        tx.commit()?;
        Ok(result)
    }
    fn agent_rows_locked(&self,c:&Connection,include_archived:bool)->Result<Vec<Value>,StorageError>{
        let sql="SELECT json_object('id',id,'name',name,'description',description,'instructions',instructions,'color',color,'outfit',outfit,'runtimeId',runtime_id,'model',model,'thinking',thinking,'serviceTier',service_tier,'customArgs',json(custom_args),'customEnv',json(custom_env),'maxConcurrency',max_concurrency,'defaultProject',default_project,'sortOrder',sort_order,'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at) FROM agents WHERE (?1 OR archived=0) ORDER BY runtime_id,sort_order,created_at,id";
        let mut q=c.prepare(sql)?;let vals=q.query_map([include_archived],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;vals.into_iter().map(|v|Ok(serde_json::from_str(&v)?)).collect()
    }
    fn session_detail_locked(&self, c: &Connection, id: &str) -> Result<Value, StorageError> {
        let base:Option<String>=c.query_row("SELECT json_object('id',id,'runtimeId',runtime_id,'agentId',agent_id,'provider',provider,'providerSessionId',provider_session_id,'projectPath',project_path,'title',COALESCE(title_override,title),'modelLock',json(model_lock_json),'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'state',state,'resumable',json(CASE WHEN resumable!=0 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at) FROM sessions WHERE id=?1",[id],|r|r.get(0)).optional()?;
        let mut v: Value =
            serde_json::from_str(&base.ok_or(rusqlite::Error::QueryReturnedNoRows)?)?;
        let (context_used, context_size) = session_context_locked(c, id)?;
        v["contextUsed"] = json!(context_used);
        v["contextSize"] = json!(context_size);
        let turns=query_jsons(c,"SELECT json_object('id',t.id,'state',t.state,'createdAt',t.created_at,'completedAt',t.completed_at,'failureClass',COALESCE(t.failure_class_v2,t.failure_class),'failureMessage',CASE COALESCE(t.failure_class_v2,t.failure_class) WHEN 'context' THEN 'Context window is full. Start a new conversation.' WHEN 'timeout' THEN 'The provider stopped making progress before the turn completed.' WHEN 'permission_denied' THEN 'A required permission was denied.' WHEN 'cancelled' THEN 'The turn was cancelled.' WHEN 'budget_stop' THEN 'The turn stopped because an applicable budget was reached.' WHEN 'config_unsupported' THEN 'Requested execution settings were unsupported.' WHEN 'provider_error' THEN 'The provider reported a turn error.' WHEN 'other' THEN 'The turn could not be completed.' ELSE NULL END,'detail',(SELECT json_extract(e.payload,'$.detail') FROM app_events e WHERE e.event_type='turn.error' AND json_extract(e.payload,'$.turnId')=t.id ORDER BY e.sequence DESC LIMIT 1)) FROM turns t WHERE t.session_id=?1 ORDER BY t.created_at",id)?;
        let msgs=query_jsons(c,"SELECT json_object('id',id,'turnId',turn_id,'sequence',sequence,'role',role,'content',content,'createdAt',created_at) FROM messages WHERE session_id=?1 ORDER BY sequence",id)?;
        v["turns"] = json!(turns);
        v["messages"] = json!(msgs);
        v["tools"] = json!(query_jsons(c,"SELECT json_object('id',id,'sessionId',session_id,'kind',json_extract(data,'$.kind'),'title',json_extract(data,'$.title'),'state',state) FROM tool_calls WHERE session_id=?1 ORDER BY rowid",id)?);
        v["files"] = json!(query_jsons(c,"SELECT json_object('id',id,'path',path) FROM file_changes WHERE session_id=?1 ORDER BY rowid",id)?);
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
}

fn session_event_summary_locked(c: &Connection, id: &str) -> Result<Value, StorageError> {
    let json: Option<String> = c.query_row(
        "SELECT json_object('id',id,'runtimeId',runtime_id,'agentId',agent_id,'provider',provider,'title',COALESCE(title_override,title),'modelLock',json(model_lock_json),'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'state',state,'resumable',json(CASE WHEN resumable!=0 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at) FROM sessions WHERE id=?1",
        [id],
        |r| r.get(0),
    ).optional()?;
    let mut summary: Value = serde_json::from_str(&json.ok_or(StorageError::AgentNotFound)?)?;
    let (context_used, context_size) = session_context_locked(c, id)?;
    summary["contextUsed"] = json!(context_used);
    summary["contextSize"] = json!(context_size);
    Ok(summary)
}

fn session_context_locked(c: &Connection, id: &str) -> Result<(Option<i64>, Option<i64>), StorageError> {
    let event: Option<(String, String)> = c.query_row(
        "SELECT event_type,payload FROM app_events WHERE event_type IN ('session.context.updated','session.context.reset') AND json_valid(payload) AND json_extract(payload,'$.sessionId')=?1 ORDER BY sequence DESC LIMIT 1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    if let Some((event_type, payload)) = event {
        if event_type == "session.context.reset" { return Ok((None, None)); }
        let payload: Value = serde_json::from_str(&payload)?;
        return Ok((payload["contextUsed"].as_i64(), payload["contextSize"].as_i64()));
    }
    let context: Option<(Option<i64>, Option<i64>)> = c.query_row(
        "SELECT context_used,context_size FROM usage_events WHERE session_id=?1 AND (context_used IS NOT NULL OR context_size IS NOT NULL) ORDER BY rowid DESC LIMIT 1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    Ok(context.unwrap_or((None, None)))
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
    if v.get("outfit").is_some_and(|value| !value.as_str().is_some_and(|s| ["auto","none","party-hat","beanie","crown","sunglasses","round-glasses","bow","scarf","witch-hat","santa-hat","pumpkin","bunny-ears"].contains(&s))) { return Err(StorageError::InvalidAgent); }
    if create && (!v["name"].is_string()||!v["runtimeId"].is_string()){return Err(StorageError::InvalidAgent)}
    if let Some(name)=v["name"].as_str(){let n=name.trim();if n.chars().count()==0||n.chars().count()>60{return Err(StorageError::InvalidAgent)}}
    if v["description"].as_str().is_some_and(|x|x.chars().count()>255)||v["instructions"].as_str().is_some_and(|x|x.contains('\0')){return Err(StorageError::InvalidAgent)}
    if let Some(color)=v["color"].as_str(){let named=["coral","orange","amber","lemon","lime","mint","teal","cyan","sky","blue","violet","pink"].contains(&color);let b=color.as_bytes();let hex=b.len()==7&&b[0]==b'#'&&b[1..].iter().all(u8::is_ascii_hexdigit);if !named&&!hex{return Err(StorageError::InvalidAgent)}}
    if let Some(env)=v["customEnv"].as_object(){for(k,val)in env{let valid=!k.is_empty()&&k.chars().enumerate().all(|(i,c)|if i==0{c=='_'||c.is_ascii_alphabetic()}else{c=='_'||c.is_ascii_alphanumeric()});let upper=k.to_ascii_uppercase();if !valid||!["LANG","LC_ALL","TZ","NO_COLOR","TERM"].contains(&upper.as_str())||["TOKEN","SECRET","PASSWORD","PASSWD","KEY","AUTH","CREDENTIAL","COOKIE"].iter().any(|needle|upper.contains(needle))||val.as_str().is_none_or(|s|s.contains('\0')){return Err(StorageError::InvalidAgent)}}}
    Ok(())
}
fn runtime_exists(c:&Connection,id:&str)->Result<bool,StorageError>{Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM runtimes WHERE id=?1)",[id],|r|r.get(0))?)}
fn ensure_name_free(c:&Connection,key:&str,except:Option<&str>)->Result<(),StorageError>{let n:i64=c.query_row("SELECT count(*) FROM agents WHERE name_key=?1 AND archived=0 AND (?2 IS NULL OR id!=?2)",params![key,except],|r|r.get(0))?;if n>0{Err(StorageError::AgentConflict)}else{Ok(())}}
fn agent_read(c:&Connection,id:&str)->Result<Value,StorageError>{let raw:Option<String>=c.query_row("SELECT json_object('id',id,'name',name,'description',description,'instructions',instructions,'color',color,'outfit',outfit,'runtimeId',runtime_id,'model',model,'thinking',thinking,'serviceTier',service_tier,'approvalMode',approval_mode,'effectiveApprovalMode',COALESCE(approval_mode,(SELECT json_extract(value,'$') FROM settings WHERE key='permissions.default_mode'),'ask'),'customArgs',json(custom_args),'customEnv',json(custom_env),'maxConcurrency',max_concurrency,'defaultProject',default_project,'sortOrder',sort_order,'archived',json(CASE WHEN archived=1 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at) FROM agents WHERE id=?1",[id],|r|r.get(0)).optional()?;Ok(serde_json::from_str(&raw.ok_or(StorageError::AgentNotFound)?)?)}
fn insert_agent(tx:&Transaction<'_>,id:&str,v:&Value,name:&str,key:&str,pos:i64,now:&str)->Result<(),StorageError>{let color=v["color"].as_str().unwrap_or("mint");let color=if color.starts_with('#'){color.to_ascii_uppercase()}else{color.into()};tx.execute("INSERT INTO agents(id,name,name_key,description,instructions,color,outfit,runtime_id,model,thinking,service_tier,approval_mode,custom_args,custom_env,max_concurrency,default_project,sort_order,archived,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,0,?18,?18)",params![id,name,key,v["description"].as_str().unwrap_or(""),v["instructions"].as_str().unwrap_or(""),color,v["outfit"].as_str().unwrap_or("auto"),v["runtimeId"].as_str().unwrap_or(""),nullable(&v["model"]),nullable(&v["thinking"]),nullable(&v["serviceTier"]),nullable(&v["approvalMode"]),v.get("customArgs").cloned().unwrap_or(json!([])).to_string(),v.get("customEnv").cloned().unwrap_or(json!({})).to_string(),v["maxConcurrency"].as_i64().unwrap_or(1),nullable(&v["defaultProject"]),pos,now])?;Ok(())}
fn push_agent_event(tx:&Transaction<'_>,action:&str,a:&Value)->Result<Value,StorageError>{let payload=json!({"action":action,"agentId":a["id"],"runtimeId":a["runtimeId"],"updatedAt":a["updatedAt"],"archived":a["archived"],"sortOrder":a["sortOrder"]});let id=Uuid::new_v4().to_string();let ts=Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true);tx.execute("INSERT INTO app_events(event_id,timestamp,event_type,payload) VALUES(?1,?2,'agent.changed',?3)",params![id,ts,payload.to_string()])?;Ok(json!({"v":1,"eventId":id,"sequence":tx.last_insert_rowid(),"timestamp":ts,"type":"agent.changed","payload":payload}))}
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
            c.execute_batch("PRAGMA foreign_keys=OFF; ALTER TABLE sessions DROP COLUMN model_lock_json; DROP TABLE IF EXISTS quota_snapshots; DROP TABLE user_pricing_rules; CREATE TABLE user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate INTEGER,output_rate INTEGER,cache_read_rate INTEGER,cache_write_rate INTEGER,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL); DELETE FROM schema_migrations WHERE version IN (8,9,10,11); PRAGMA user_version=7;").unwrap();
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
            assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 11);
        drop(c);
        drop(db);
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn remove_session_controls_migration(c: &Connection) {
        c.execute_batch("ALTER TABLE sessions DROP COLUMN model_lock_json; DROP TABLE IF EXISTS quota_snapshots; DELETE FROM schema_migrations WHERE version IN (6,7,8,9,10,11); PRAGMA user_version=5; ALTER TABLE sessions DROP COLUMN archived; ALTER TABLE sessions DROP COLUMN title_override; ALTER TABLE agents DROP COLUMN outfit; DROP TABLE user_pricing_rules; CREATE TABLE user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate INTEGER,output_rate INTEGER,cache_read_rate INTEGER,cache_write_rate INTEGER,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL);").unwrap();
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
            conn.execute_batch("ALTER TABLE sessions DROP COLUMN model_lock_json; DROP TABLE quota_snapshots; DELETE FROM schema_migrations WHERE version IN (10,11); PRAGMA user_version=9;").unwrap();
            assert!(schema_v9_valid(&conn).unwrap());
        }
        let _ = fs::remove_dir_all(root.join("backups"));
        {
            let db = Storage::open(&path).unwrap();
            let conn = db.conn.lock().unwrap();
            assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 11);
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
    fn session_metadata_migration_rename_archive_and_delete_are_durable_and_scoped() {
        let path = std::env::temp_dir().join(format!("bloblex-session-controls-{}.db", Uuid::new_v4()));
        {
            let db = Storage::open(&path).unwrap();
            let version: i64 = db.conn.lock().unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(version, 11);
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
            db.push_event("session.context.reset", &json!({"sessionId":"s-controls"})).unwrap();
            assert!(db.session_detail("s-controls").unwrap()["contextUsed"].is_null());
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
        {let db=Storage::open(&path).unwrap();assert_eq!(db.default_approval_mode().unwrap(),"ask");let agent=db.agent_get(&agent_id).unwrap();assert!(agent["approvalMode"].is_null());assert_eq!(agent["effectiveApprovalMode"],"ask");let c=Connection::open(&path).unwrap();assert_eq!(c.query_row("SELECT status FROM permission_requests WHERE id='perm-v4'",[],|r|r.get::<_,String>(0)).unwrap(),"pending");assert!(c.query_row("SELECT resolved_by FROM permission_requests WHERE id='perm-v4'",[],|r|r.get::<_,Option<String>>(0)).unwrap().is_none());assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),11);}
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
        assert_eq!(c.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 11);
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
            source.execute_batch("PRAGMA foreign_keys=OFF; ALTER TABLE sessions DROP COLUMN model_lock_json; ALTER TABLE agents DROP COLUMN outfit; DROP TABLE IF EXISTS quota_snapshots; DELETE FROM schema_migrations WHERE version IN (7,8,9,10,11); PRAGMA user_version=6; DROP TABLE user_pricing_rules; CREATE TABLE user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate INTEGER,output_rate INTEGER,cache_read_rate INTEGER,cache_write_rate INTEGER,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL);").unwrap();
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
            assert_eq!(read.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), 11);
            assert_eq!(read.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 11);
            assert_eq!(read.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 11);
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
            conn.execute_batch("ALTER TABLE sessions DROP COLUMN model_lock_json; DELETE FROM schema_migrations WHERE version=11; PRAGMA user_version=10;").unwrap();
        }
        {
            let db = Storage::open(&path).unwrap();
            assert_eq!(db.conn.lock().unwrap().query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 11);
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
        let backup_dir=dir.join("backups");let paths=fs::read_dir(&backup_dir).unwrap().map(|x|x.unwrap().path()).collect::<Vec<_>>();assert_eq!(paths.len(),20);assert_eq!(paths.iter().filter(|x|x.extension().is_some_and(|e|e=="db")).count(),10);assert!(paths.iter().all(|x|!x.file_name().unwrap().to_string_lossy().ends_with("-wal")&&!x.file_name().unwrap().to_string_lossy().ends_with("-shm")));let backup=paths.iter().find(|x|x.extension().is_some_and(|e|e=="db")&&x.file_name().unwrap().to_string_lossy().contains("v1")).unwrap().clone();let manifest_path=paths.iter().find(|x|x.file_name().unwrap().to_string_lossy().ends_with("manifest.json")&&x.file_name().unwrap().to_string_lossy().contains("v1")).unwrap();let manifest:Value=serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();assert_eq!(manifest["integrity"],"ok");assert_eq!(manifest["schemaVersion"],1);assert_eq!(manifest["tableRowCounts"]["sessions"],2);
        {let db=Storage::open(&path).unwrap();assert_eq!(db.agent_list(true,None).unwrap(),baseline.0);assert_eq!(db.sessions().unwrap(),baseline.1);}
        let read=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(read.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),11);assert_eq!(read.query_row("SELECT MAX(version) FROM schema_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),11);assert_eq!(read.query_row("SELECT count(*) FROM usage_events WHERE agent_id IS NOT NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);assert_eq!(read.query_row("SELECT agent_id FROM usage_events WHERE id='u-a'",[],|r|r.get::<_,Option<String>>(0)).unwrap(),Some(read.query_row("SELECT agent_id FROM sessions WHERE id='s-a'",[],|r|r.get::<_,String>(0)).unwrap()));assert_eq!(read.query_row("SELECT created_at FROM sessions WHERE id='s-a'",[],|r|r.get::<_,String>(0)).unwrap(),"2026-01-02T00:00:00.000Z");assert_eq!(read.query_row("SELECT a.color FROM agents a JOIN runtimes r ON r.id=a.runtime_id WHERE r.provider='codex'",[],|r|r.get::<_,String>(0)).unwrap(),"#82AAFF");assert_eq!(read.query_row("SELECT a.color FROM agents a JOIN runtimes r ON r.id=a.runtime_id WHERE r.provider='claude'",[],|r|r.get::<_,String>(0)).unwrap(),"#F38C6F");for (table,column) in [("sessions","agent_id"),("usage_events","agent_id"),("sessions","first_exec_snapshot_id"),("usage_events","usage_status"),("agents","approval_mode"),("permission_requests","resolved_by"),("sessions","title_override"),("sessions","archived"),("sessions","model_lock_json")] {assert!(read.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",params![table,column],|r|r.get::<_,bool>(0)).unwrap());}for index in ["idx_agents_active_name","idx_agents_active_runtime_order","idx_agents_runtime_archived_order","idx_sessions_agent_updated","idx_usage_agent_time","idx_usage_provider_update"]{assert!(read.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",[index],|r|r.get::<_,bool>(0)).unwrap());}drop(read);
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
    fn migration_2_to_3_seeds_gates_preserves_operator_values_and_reopens_without_backup_or_sidecars(){
        let(dir,path)=v2_fixture();
        {let db=Storage::open(&path).unwrap();let settings=db.settings().unwrap();assert_eq!(settings["exec_gate.codex.model"],false);for key in ["exec_gate.claude.model","exec_gate.claude.thinking","exec_gate.claude.instructions","exec_gate.codex.thinking","exec_gate.codex.serviceTier","exec_gate.codex.instructions","exec_gate.opencode.model","exec_gate.opencode.instructions"]{assert_eq!(settings[key],true);}assert_eq!(settings["exec_gate.opencode.thinking"],false);}
        let backup_dir=dir.join("backups");let before=fs::read_dir(&backup_dir).unwrap().count();assert_eq!(before,18);
        {let c=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),11);assert_eq!(c.query_row("SELECT MAX(version) FROM schema_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),11);assert_eq!(c.query_row("SELECT COUNT(*) FROM usage_events WHERE usage_status='unreported' AND exec_snapshot_id IS NULL AND provider_update_id IS NULL AND context_used IS NULL AND context_size IS NULL AND reported_cost_decimal IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),2);assert_eq!(c.query_row("SELECT count(*) FROM app_events WHERE event_type='settings.changed'",[],|r|r.get::<_,i64>(0)).unwrap(),9);for (table,column) in [("sessions","claude_instruction_sha256"),("sessions","codex_thread_instruction_sha256"),("sessions","opencode_cost_total"),("usage_events","reported_cost_decimal")] {assert_eq!(c.query_row("SELECT type FROM pragma_table_info(?1) WHERE name=?2",params![table,column],|r|r.get::<_,String>(0)).unwrap(),"TEXT");}assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='cumulative_cost_micros')",[],|r|r.get::<_,bool>(0)).unwrap());}
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
        let c=db.conn.lock().unwrap();let row:(Option<String>,Option<String>,String,Option<i64>,Option<i64>,Option<String>,String)=c.query_row("SELECT exec_snapshot_id,provider_update_id,usage_status,context_used,context_size,reported_cost_decimal,raw FROM usage_events WHERE id='u1'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).unwrap();assert_eq!(row,(Some("snap1".into()),Some("update-1".into()),"reported".into(),Some(12),Some(100),None,"{}".into()));drop(c);
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
}
