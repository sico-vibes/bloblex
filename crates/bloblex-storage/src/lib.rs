use chrono::{Datelike, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};
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
}

pub struct Storage {
    conn: Mutex<Connection>,
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let conn = Connection::open(path)?;
        Self::migrate(conn)
    }
    pub fn open_in_memory() -> Result<Self, StorageError> {
        Self::migrate(Connection::open_in_memory()?)
    }
    fn migrate(conn: Connection) -> Result<Self, StorageError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
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
          CREATE TABLE IF NOT EXISTS user_pricing_rules(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,aliases TEXT NOT NULL,input_rate INTEGER,output_rate INTEGER,cache_read_rate INTEGER,cache_write_rate INTEGER,currency TEXT NOT NULL,effective_from TEXT NOT NULL,effective_to TEXT,source_url TEXT,data TEXT NOT NULL);
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
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let now = Utc::now().to_rfc3339();
        c.execute("INSERT INTO sessions(id,runtime_id,provider,project_path,title,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'starting',?6,?6)",params![id,runtime_id,provider,project,title,now])?;
        Ok(())
    }
    pub fn set_session_provider_id(
        &self,
        id: &str,
        provider_id: &str,
        resumable: bool,
    ) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE sessions SET provider_session_id=?2,resumable=?3, state='idle',updated_at=?4 WHERE id=?1",params![id,provider_id,resumable, Utc::now().to_rfc3339()])?;
        Ok(())
    }
    pub fn sessions(&self) -> Result<Vec<Value>, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let mut s=c.prepare("SELECT id,runtime_id,provider,provider_session_id,project_path,title,state,resumable,created_at,updated_at FROM sessions ORDER BY updated_at DESC")?;
        let iter=s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"runtimeId":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?,"providerSessionId":r.get::<_,Option<String>>(3)?,"projectPath":r.get::<_,String>(4)?,"title":r.get::<_,String>(5)?,"state":r.get::<_,String>(6)?,"resumable":r.get::<_,bool>(7)?,"createdAt":r.get::<_,String>(8)?,"updatedAt":r.get::<_,String>(9)?})))?;
        iter.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }
    pub fn insert_usage(&self, u: &Value) -> Result<(), StorageError> {
        let mut c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = u["id"].as_str().unwrap_or("");
        tx.execute("INSERT INTO usage_events(id,runtime_id,session_id,turn_id,provider,model,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,reported_cost_minor,reported_currency,source,raw) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",params![id,u["runtimeId"].as_str().unwrap_or(""),u["sessionId"].as_str().unwrap_or(""),u["turnId"].as_str(),u["provider"].as_str().unwrap_or(""),u["model"].as_str(),u["timestamp"].as_str().unwrap_or(""),u["inputTokens"].as_i64(),u["outputTokens"].as_i64(),u["cacheReadTokens"].as_i64(),u["cacheWriteTokens"].as_i64(),u["reasoningTokens"].as_i64(),u["providerReportedCostMinor"].as_i64(),u["providerReportedCurrency"].as_str(),u["source"].as_str().unwrap_or("unknown"),u["raw"].to_string()])?;
        if !u["valuation"].is_null() {
            let v = &u["valuation"];
            tx.execute("INSERT INTO usage_valuations(usage_event_id,basis,amount_minor,currency,pricing_rule_id,status,valued_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,v["basis"].as_str().unwrap_or("unknown"),v["amountMinor"].as_i64(),v["currency"].as_str(),v["pricingRuleId"].as_str(),v["status"].as_str().unwrap_or("unavailable"),u["timestamp"].as_str().unwrap_or("")])?;
        }
        tx.commit()?;
        Ok(())
    }
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
            let used: i64 = if period == "turn" {
                tx.query_row("SELECT COALESCE(SUM(CASE WHEN status='active' THEN amount WHEN status='reconciled' THEN COALESCE(reconciled_amount,amount) ELSE 0 END),0) FROM budget_reservations WHERE policy_id=?1 AND turn_id=?2", params![id, turn_id], |r| r.get(0))?
            } else {
                tx.query_row("SELECT COALESCE(SUM(CASE WHEN status='active' THEN amount WHEN status='reconciled' THEN COALESCE(reconciled_amount,amount) ELSE 0 END),0) FROM budget_reservations WHERE policy_id=?1 AND created_at>=?2", params![id, start], |r| r.get(0))?
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
    pub fn reconcile_budget_turn(&self, turn_id: &str, actual: i64) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("UPDATE budget_reservations SET status='reconciled',reconciled_amount=?2 WHERE turn_id=?1 AND status='active'", params![turn_id, actual.max(0)])?;
        Ok(())
    }
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
    pub fn release_budget_turn(&self, turn_id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "UPDATE budget_reservations SET status='released' WHERE turn_id=?1 AND status='active'",
            [turn_id],
        )?;
        Ok(())
    }
    pub fn budget_usage(&self, policy_id: &str, period: &str) -> Result<(i64, i64), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        budget_totals_locked(&c, policy_id, period).map_err(StorageError::from)
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
        c.execute(
            "INSERT INTO turns(id,session_id,state,created_at) VALUES(?1,?2,'working',?3)",
            params![id, session, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
    pub fn update_session_state(&self, id: &str, state: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "UPDATE sessions SET state=?2,updated_at=?3 WHERE id=?1",
            params![id, state, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
    /// Convert volatile running state left by an unclean daemon exit into a
    /// resumable offline session. Partial messages and native IDs are retained.
    /// Reservations for turns with durable rows remain charged conservatively;
    /// reservations without a durable turn are safe to release.
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
        tx.execute("UPDATE turns SET state='error',completed_at=?1 WHERE state IN ('starting','working','waiting_permission','cancelling')", [&now])?;
        tx.execute("UPDATE sessions SET state='offline',updated_at=?1 WHERE state IN ('starting','working','waiting_permission','cancelling')", [&now])?;
        tx.execute("UPDATE permission_requests SET status='expired',data=json_set(data,'$.status','expired','$.resolution','daemon_restarted') WHERE status IN ('pending','resolving')", [])?;
        tx.execute("UPDATE budget_reservations SET status='reconciled',reconciled_amount=amount WHERE status='active' AND turn_id IN (SELECT id FROM turns WHERE state='error')", [])?;
        tx.execute("UPDATE budget_reservations SET status='released' WHERE status='active' AND turn_id NOT IN (SELECT id FROM turns)", [])?;
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
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute(
            "UPDATE turns SET state=?2,completed_at=?3 WHERE id=?1",
            params![
                id,
                state,
                if state == "working" {
                    None
                } else {
                    Some(Utc::now().to_rfc3339())
                }
            ],
        )?;
        Ok(())
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
    pub fn session_detail(&self, id: &str) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        self.session_detail_locked(&c, id)
    }
    pub fn budget_list(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(json!({"policies":self.budget_list_locked(&c)?}))
    }
    pub fn save_budget(&self, p: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let metric = p["metric"].as_str().unwrap_or("tokens");
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
        c.execute("INSERT INTO budget_policies(id,scope_type,scope_id,period,metric,hard_limit,warning_json,created_at,enabled,currency) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET scope_type=excluded.scope_type,scope_id=excluded.scope_id,period=excluded.period,metric=excluded.metric,hard_limit=excluded.hard_limit,warning_json=excluded.warning_json,enabled=excluded.enabled,currency=excluded.currency",params![p["id"].as_str().unwrap_or_else(||p["policyId"].as_str().unwrap_or("")),p["scopeType"].as_str().unwrap_or("global"),p["scopeId"].as_str(),p["period"].as_str().unwrap_or("day"),metric,p["hardLimit"].as_i64().unwrap_or(0),p["warningThresholds"].to_string(),Utc::now().to_rfc3339(),p["enabled"].as_bool().unwrap_or(true),p["currency"].as_str().unwrap_or("USD")])?;
        Ok(())
    }
    pub fn delete_budget(&self, id: &str) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("DELETE FROM budget_policies WHERE id=?1", [id])?;
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
    pub fn set_setting(&self, k: &str, v: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![k,v.to_string()])?;
        Ok(())
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
    pub fn pricing_list(&self, provider: Option<&str>) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        let sql = if provider.is_some() {
            "SELECT data FROM user_pricing_rules WHERE provider=?1 ORDER BY model"
        } else {
            "SELECT data FROM user_pricing_rules ORDER BY provider,model"
        };
        let mut s = c.prepare(sql)?;
        let rows = s
            .query_map([provider.unwrap_or("")], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(
            json!({"rules":rows.into_iter().filter_map(|x|serde_json::from_str::<Value>(&x).ok()).collect::<Vec<_>>()}),
        )
    }
    pub fn save_pricing(&self, p: &Value) -> Result<(), StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        c.execute("INSERT INTO user_pricing_rules(id,provider,model,aliases,input_rate,output_rate,cache_read_rate,cache_write_rate,currency,effective_from,effective_to,source_url,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![p["id"].as_str().unwrap_or(""),p["provider"].as_str().unwrap_or(""),p["canonicalModelId"].as_str().unwrap_or(""),p["aliases"].to_string(),p["inputPerMillion"].as_i64(),p["outputPerMillion"].as_i64(),p["cacheReadPerMillion"].as_i64(),p["cacheWritePerMillion"].as_i64(),p["currency"].as_str().unwrap_or("USD"),p["effectiveFrom"].as_str().unwrap_or(""),p["effectiveTo"].as_str(),p["sourceUrl"].as_str(),p.to_string()])?;
        Ok(())
    }
    pub fn subscriptions(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
        self.subscriptions_locked(&c)
    }
    fn subscriptions_locked(&self, c: &Connection) -> Result<Value, StorageError> {
        let rows = query_column_json(
            c,
            "SELECT data FROM subscription_plans ORDER BY provider",
            "",
        )?;
        Ok(json!({"plans":rows}))
    }
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
        let mut q = c.prepare("SELECT v.basis,v.currency,v.status,SUM(v.amount_minor),COUNT(*) FROM usage_valuations v JOIN usage_events e ON e.id=v.usage_event_id WHERE e.timestamp>=?1 AND e.timestamp<=?2 GROUP BY v.basis,v.currency,v.status ORDER BY v.basis,v.currency,v.status")?;
        let valuations = q.query_map(params![from,to],|r|Ok(json!({"basis":r.get::<_,String>(0)?,"currency":r.get::<_,Option<String>>(1)?,"status":r.get::<_,String>(2)?,"amountMinor":r.get::<_,Option<i64>>(3)?,"eventCount":r.get::<_,i64>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
        let actual = valuations.iter().filter(|v|v["basis"]=="provider_reported_actual").collect::<Vec<_>>();
        let estimates = valuations.iter().filter(|v|v["basis"]=="api_rate_estimate").collect::<Vec<_>>();
        let actual_amount = single_currency_total(&actual);
        let estimate_amount = single_currency_total(&estimates);
        let subscriptions = self.subscriptions_locked(&c)?;
        Ok(json!({"from":from,"to":to,"inputTokens":i,"outputTokens":o,"cacheReadTokens":cr,"cacheWriteTokens":cw,"reasoningTokens":r,"providerReportedCostMinor":actual_amount.0,"providerReportedCurrency":actual_amount.1,"apiEstimateMinor":estimate_amount.0,"apiEstimateCurrency":estimate_amount.1,"pricingStatus":if estimates.is_empty(){"unavailable"}else{"available"},"valuations":valuations,"subscriptionFixedMinor":null,"subscriptionCurrency":null,"subscriptions":subscriptions["plans"],"quotaState":"unknown"}))
    }
    pub fn snapshot(&self) -> Result<Value, StorageError> {
        let c = self.conn.lock().map_err(|_| StorageError::Poisoned)?;
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
            let mut q = c.prepare("SELECT id FROM sessions ORDER BY updated_at DESC")?;
            let collected = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            collected
        };
        let mut session_values = Vec::new();
        for id in sessions {
            session_values.push(self.session_detail_locked(&c, &id)?)
        }
        let permissions = query_jsons(
            &c,
            "SELECT json_object('id',p.id,'sessionId',p.session_id,'runtimeId',s.runtime_id,'title',json_extract(p.data,'$.title'),'detail',json_extract(p.data,'$.detail'),'choices',json_extract(p.data,'$.choices'),'status',p.status,'expiresAt',p.expires_at) FROM permission_requests p JOIN sessions s ON s.id=p.session_id WHERE p.status='pending' ORDER BY p.rowid",
            "",
        )?;
        let budgets = self.budget_list_locked(&c)?;
        let usage = self.usage_rows_locked(&c)?;
        let settings = self.settings_locked(&c)?;
        Ok(
            json!({"snapshotVersion":1,"sequence":seq,"daemon":{"state":"ready"},"hosts":[{"id":"host_windows_local","name":std::env::var("COMPUTERNAME").unwrap_or_else(|_|"Windows Local".into()),"kind":"windows","status":"online"}],"runtimes":runtimes,"sessions":session_values,"permissions":permissions,"usageSummary":usage,"budgets":budgets,"settings":settings}),
        )
    }
    fn session_detail_locked(&self, c: &Connection, id: &str) -> Result<Value, StorageError> {
        let base:Option<String>=c.query_row("SELECT json_object('id',id,'runtimeId',runtime_id,'provider',provider,'providerSessionId',provider_session_id,'projectPath',project_path,'title',title,'state',state,'resumable',json(CASE WHEN resumable!=0 THEN 'true' ELSE 'false' END),'createdAt',created_at,'updatedAt',updated_at) FROM sessions WHERE id=?1",[id],|r|r.get(0)).optional()?;
        let mut v: Value =
            serde_json::from_str(&base.ok_or(rusqlite::Error::QueryReturnedNoRows)?)?;
        let turns=query_jsons(c,"SELECT json_object('id',id,'state',state,'createdAt',created_at,'completedAt',completed_at) FROM turns WHERE session_id=?1 ORDER BY created_at",id)?;
        let msgs=query_jsons(c,"SELECT json_object('id',id,'turnId',turn_id,'sequence',sequence,'role',role,'content',content,'createdAt',created_at) FROM messages WHERE session_id=?1 ORDER BY sequence",id)?;
        v["turns"] = json!(turns);
        v["messages"] = json!(msgs);
        v["tools"] = json!(query_jsons(c,"SELECT json_object('id',id,'sessionId',session_id,'kind',json_extract(data,'$.kind'),'title',json_extract(data,'$.title'),'state',state) FROM tool_calls WHERE session_id=?1 ORDER BY rowid",id)?);
        v["files"] = json!(query_jsons(c,"SELECT json_object('id',id,'path',path) FROM file_changes WHERE session_id=?1 ORDER BY rowid",id)?);
        Ok(v)
    }
    fn budget_list_locked(&self, c: &Connection) -> Result<Value, StorageError> {
        let mut s=c.prepare("SELECT id,scope_type,scope_id,period,metric,hard_limit,warning_json,enabled,currency FROM budget_policies ORDER BY scope_type")?;
        let rows=s.query_map([],|r| {
            let id: String = r.get(0)?;
            let period: String = r.get(3)?;
            let limit: i64 = r.get(5)?;
            let (consumed,reserved) = budget_totals_locked(c, &id, &period)?;
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

fn budget_totals_locked(
    c: &Connection,
    policy_id: &str,
    period: &str,
) -> Result<(i64, i64), rusqlite::Error> {
    let start = period_start(&Utc::now(), period);
    if period == "turn" {
        c.query_row(
            "SELECT COALESCE(SUM(CASE WHEN status='reconciled' THEN COALESCE(reconciled_amount,amount) ELSE 0 END),0),COALESCE(SUM(CASE WHEN status='active' THEN amount ELSE 0 END),0) FROM budget_reservations WHERE policy_id=?1",
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
fn single_currency_total<'a>(rows: &[&'a Value]) -> (Option<i64>, Option<&'a str>) {
    let mut currency: Option<&str> = None;
    let mut total = 0i64;
    for row in rows {
        let Some(current) = row["currency"].as_str() else {
            return (None, None);
        };
        let Some(amount) = row["amountMinor"].as_i64() else {
            return (None, None);
        };
        if currency.is_some_and(|existing| existing != current) {
            return (None, None);
        }
        currency = Some(current);
        total = total.saturating_add(amount);
    }
    (currency.map(|_| total), currency)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrations_create_idempotent_database_and_events_replay() {
        let db = Storage::open_in_memory().unwrap();
        db.push_event("x", &json!({"n":1})).unwrap();
        let ev = db.replay_events(0, 10).unwrap();
        assert_eq!(ev[0]["type"], "x");
        assert_eq!(db.snapshot().unwrap()["sequence"], 1);
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
}
