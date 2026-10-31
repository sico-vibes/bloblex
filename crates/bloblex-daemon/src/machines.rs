//! Phase 4: machine identity, links and reading the other machine.
//!
//! A machine link is this daemon acting as a paired device of another
//! machine's Remote gateway ([`crate::machine_client`]). The window never talks
//! to the other machine, there is no new listener and no relay. Everything the
//! owner sees of the other machine is read through the gateway, so its
//! redaction and tier rules apply, and none of it is stored here: the bots and
//! conversations of the other machine live in memory only.
//!
//! The device token is never in the database. It sits in a user-only file in
//! the data folder (`machine_client::token_path`) and is read for one request.

use crate::machine_client::{self as client, ClientError, Trust};
use crate::remote::pairing::{DEVICE_COOKIE, PAIR_COOKIE};
use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use zeroize::Zeroizing;

/// The handoff format this build speaks. `machine.info` reports it.
pub const HANDOFF_VERSION: u64 = 1;
/// `machine.name` is this long.
const NAME_MAX: usize = 60;
/// Most pairing jobs kept in memory.
const MAX_JOBS: usize = 20;
/// How many times in a row a poll may fail before the pairing is given up.
const MAX_POLL_FAILURES: u32 = 8;

pub const SETTING_ID: &str = "machine.id";
pub const SETTING_NAME: &str = "machine.name";

/// The clocks. Tests shorten them; production uses the defaults.
#[derive(Clone, Copy)]
pub struct Timing {
    /// How often the loop reads each machine.
    pub interval: Duration,
    /// Limit for one machine's whole read, and for each of its calls.
    pub call_timeout: Duration,
    /// How often a pairing asks whether the other owner has approved.
    pub poll_every: Duration,
    /// How long a pairing waits for that approval.
    pub pair_window: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(20),
            call_timeout: Duration::from_secs(10),
            poll_every: Duration::from_secs(2),
            pair_window: Duration::from_secs(5 * 60),
        }
    }
}

/// What the last read of one machine showed. Memory only.
#[derive(Clone, Default, PartialEq)]
struct Snapshot {
    version: Option<String>,
    bots: Vec<Value>,
    detail: Option<String>,
}

#[derive(Clone)]
struct Job {
    id: String,
    url: String,
    state: &'static str,
    detail: Option<String>,
    machine: Value,
}

impl Job {
    fn to_value(&self) -> Value {
        json!({"id": self.id, "url": self.url, "state": self.state, "detail": self.detail, "machine": self.machine})
    }
}

/// Everything this module keeps in memory, held in `AppState`.
pub struct Machines {
    identity: Mutex<()>,
    jobs: Mutex<Vec<Job>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    snapshots: Mutex<HashMap<String, Snapshot>>,
    looping: AtomicBool,
    wake: Notify,
    timing: Mutex<Timing>,
}

impl Default for Machines {
    fn default() -> Self {
        Self {
            identity: Mutex::new(()),
            jobs: Mutex::new(Vec::new()),
            cancels: Mutex::new(HashMap::new()),
            snapshots: Mutex::new(HashMap::new()),
            looping: AtomicBool::new(false),
            wake: Notify::new(),
            timing: Mutex::new(Timing::default()),
        }
    }
}

impl Machines {
    fn timing(&self) -> Timing {
        *self.timing.lock().unwrap()
    }

    #[cfg(test)]
    pub fn set_timing(&self, timing: Timing) {
        *self.timing.lock().unwrap() = timing;
    }

    /// Whether the background loop is running.
    #[cfg(test)]
    pub fn loop_active(&self) -> bool {
        self.looping.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// Identity

fn internal(error: impl ToString) -> DispatchError {
    derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR)
}

fn invalid(message: &str) -> DispatchError {
    derr("invalid_argument", message, StatusCode::BAD_REQUEST)
}

/// This machine's id: made once, at first need, and kept.
pub fn machine_id(st: &AppState) -> String {
    let _guard = st.machines.identity.lock().unwrap();
    let settings = st.db.settings().unwrap_or(Value::Null);
    if let Some(id) = settings.get(SETTING_ID).and_then(Value::as_str).filter(|id| client::safe_id(id)) {
        return id.to_string();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = st.db.set_setting(SETTING_ID, &json!(id));
    id
}

/// The name the other machines see: the owner's choice, else the host name.
pub fn machine_name(st: &AppState) -> String {
    let settings = st.db.settings().unwrap_or(Value::Null);
    settings
        .get(SETTING_NAME)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(crate::remote::host_name)
}

fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn self_value(st: &AppState) -> Value {
    json!({"id": machine_id(st), "name": machine_name(st), "version": version()})
}

fn info_value(st: &AppState) -> Value {
    json!({"machineId": machine_id(st), "name": machine_name(st), "version": version(), "handoffVersion": HANDOFF_VERSION})
}

fn self_rename(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let name = p["name"].as_str().ok_or_else(|| invalid("name is required"))?.trim();
    if !(1..=NAME_MAX).contains(&name.chars().count()) {
        return Err(invalid("The name must be 1 to 60 characters."));
    }
    st.db.set_setting(SETTING_NAME, &json!(name)).map_err(internal)?;
    Ok(self_value(st))
}

// ---------------------------------------------------------------------------
// Rows

/// The row the window sees. The device id on the other machine stays here.
fn row_of(st: &AppState, link: &Value) -> Value {
    let id = link["id"].as_str().unwrap_or("");
    let snapshot = st.machines.snapshots.lock().unwrap().get(id).cloned().unwrap_or_default();
    json!({
        "id": link["id"],
        "name": link["name"],
        "url": link["url"],
        "auth": link["auth"],
        "fingerprint": link["fingerprint"],
        "tier": link["tier"],
        "pairedAt": link["pairedAt"],
        "lastSeenAt": link["lastSeenAt"],
        "state": link["state"],
        "detail": snapshot.detail,
        "version": snapshot.version,
        "bots": snapshot.bots,
    })
}

fn row_by_id(st: &AppState, id: &str) -> Option<Value> {
    let link = st.db.machine_link_get(id).ok().flatten()?;
    Some(row_of(st, &link))
}

fn list_value(st: &AppState) -> Result<Value, DispatchError> {
    let links = st.db.machine_links().map_err(internal)?;
    Ok(json!({"machines": links.iter().map(|link| row_of(st, link)).collect::<Vec<_>>()}))
}

fn link_or_missing(st: &AppState, id: &str) -> Result<Value, DispatchError> {
    st.db
        .machine_link_get(id)
        .map_err(internal)?
        .ok_or_else(|| derr("not_found", "That machine isn't linked.", StatusCode::NOT_FOUND))
}

fn id_param<'a>(p: &'a Value, key: &str) -> Result<&'a str, DispatchError> {
    p[key].as_str().filter(|id| !id.is_empty()).ok_or_else(|| invalid(&format!("{key} is required")))
}

// ---------------------------------------------------------------------------
// The other machine's lists

fn is_busy_state(state: &str) -> bool {
    matches!(state, "starting" | "working" | "waiting_permission" | "cancelling")
}

/// A conversation counts for its bot unless it is an automation's or a handoff's.
fn counts_as_conversation(session: &Value) -> bool {
    !session["archived"].as_bool().unwrap_or(false)
        && !matches!(session["link"]["kind"].as_str(), Some("automation" | "handoff"))
}

/// The bots of the other machine, from its `agent.list` and `session.list`.
/// Hidden bots are left out.
pub(crate) fn bots_from(agents: &Value, sessions: &Value) -> Vec<Value> {
    let sessions = sessions["sessions"].as_array().cloned().unwrap_or_default();
    agents["agents"]
        .as_array()
        .map(|agents| {
            agents
                .iter()
                .filter(|agent| !agent["hidden"].as_bool().unwrap_or(false))
                .filter_map(|agent| {
                    let id = agent["id"].as_str()?;
                    let own: Vec<&Value> = sessions.iter().filter(|session| session["agentId"].as_str() == Some(id)).collect();
                    let conversations = own.iter().filter(|session| counts_as_conversation(session)).count();
                    let live = own
                        .iter()
                        .filter(|session| !session["archived"].as_bool().unwrap_or(false))
                        .filter(|session| session["state"].as_str().is_some_and(is_busy_state))
                        .max_by_key(|session| session["updatedAt"].as_str().unwrap_or("").to_string());
                    let provider = own
                        .iter()
                        .max_by_key(|session| session["updatedAt"].as_str().unwrap_or("").to_string())
                        .and_then(|session| session["provider"].as_str());
                    Some(json!({
                        "id": id,
                        "name": agent["name"],
                        "color": agent["color"],
                        "outfit": agent["outfit"],
                        "look": agent["look"],
                        "role": agent["role"],
                        "provider": provider,
                        "model": agent["model"],
                        "busy": live.is_some(),
                        "activeSessionId": live.and_then(|session| session["id"].as_str()),
                        "conversations": conversations,
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Reading one machine

fn unreachable_detail(name: &str) -> String {
    format!("{name} can't be reached right now.")
}

/// One read of one machine: `machine.info`, `agent.list` and `session.list`
/// under one limit. Updates the link's state and the in-memory snapshot, and
/// emits `machine.changed` when something the window shows changed. Returns the
/// row, or `None` when the link is gone.
pub async fn refresh_one(st: &AppState, id: &str) -> Option<Value> {
    let link = st.db.machine_link_get(id).ok().flatten()?;
    let name = link["name"].as_str().unwrap_or("That machine").to_string();
    let before = row_of(st, &link);
    // A revoked link stays revoked until it is paired again; asking would only
    // fail the same way.
    if link["state"] == "revoked" {
        return Some(before);
    }
    let timeout = st.machines.timing().call_timeout;
    let read = tokio::time::timeout(timeout, async {
        tokio::join!(
            client::rpc_with_timeout(st, id, "machine.info", json!({}), timeout),
            client::rpc_with_timeout(st, id, "agent.list", json!({}), timeout),
            client::rpc_with_timeout(st, id, "session.list", json!({}), timeout),
            client::device_tier(st, id, timeout),
        )
    })
    .await;
    // The device's own tier is read with the rest; a failed read keeps the stored one.
    let (read, tier) = match read {
        Ok((info, agents, sessions, tier)) => (Ok((info, agents, sessions)), tier.ok()),
        Err(elapsed) => (Err(elapsed), None),
    };
    // The link may have been removed while the calls were in flight.
    st.db.machine_link_get(id).ok().flatten()?;
    let mut previous = st.machines.snapshots.lock().unwrap().get(id).cloned().unwrap_or_default();
    let (state, snapshot) = match read {
        Ok((Ok(info), Ok(agents), Ok(sessions))) if info["machineId"].as_str() == Some(id) => {
            let seen = Snapshot { version: info["version"].as_str().map(str::to_string), bots: bots_from(&agents, &sessions), detail: None };
            ("online", seen)
        }
        Ok((Ok(info), Ok(_), Ok(_))) if info["machineId"].as_str() != Some(id) => {
            previous.detail = Some(format!("The address for {name} now belongs to a different machine."));
            ("offline", previous)
        }
        Ok((a, b, c)) if [&a, &b, &c].iter().any(|result| matches!(result, Err(ClientError::Revoked))) => {
            previous.detail = Some(format!("{name} removed this computer's pairing. Pair it again."));
            ("revoked", previous)
        }
        _ => {
            previous.detail = Some(unreachable_detail(&name));
            ("offline", previous)
        }
    };
    let _ = st.db.machine_link_set_state(id, state, state == "online");
    if let Some(tier) = tier.filter(|tier| state == "online" && link["tier"].as_str() != Some(tier.as_str())) {
        let _ = st.db.machine_link_set_tier(id, &tier);
    }
    st.machines.snapshots.lock().unwrap().insert(id.to_string(), snapshot);
    let after = row_by_id(st, id)?;
    let shown = |row: &Value| json!([row["state"], row["detail"], row["version"], row["bots"], row["tier"]]);
    if shown(&before) != shown(&after) {
        // Nothing about the other machine's bots goes into an event, because
        // events are stored: the window reloads `machine.list` when it sees this.
        st.emit("machine.changed", json!({"machineId": id, "state": after["state"]})).await;
    }
    Some(after)
}

pub(crate) async fn refresh_all(st: &AppState) {
    let ids: Vec<String> = st
        .db
        .machine_links()
        .unwrap_or_default()
        .iter()
        .filter_map(|link| link["id"].as_str().map(str::to_string))
        .collect();
    // Each machine is read on its own, so one that never answers holds up
    // nobody but itself.
    let reads = ids.iter().map(|id| refresh_one(st, id));
    futures_util::future::join_all(reads).await;
}

/// Starts the background loop when there is a link and none is running. The
/// loop ends by itself once the last link is gone.
pub fn ensure_loop(st: &AppState) {
    if st.db.machine_link_count().unwrap_or(0) == 0 || st.machines.looping.swap(true, Ordering::SeqCst) {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move { run_loop(st).await });
}

async fn run_loop(st: AppState) {
    loop {
        if st.db.machine_link_count().unwrap_or(0) == 0 {
            st.machines.looping.store(false, Ordering::SeqCst);
            // A link added between the check and the store must not be missed.
            if st.db.machine_link_count().unwrap_or(0) == 0 || st.machines.looping.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        refresh_all(&st).await;
        let interval = st.machines.timing().interval;
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = st.machines.wake.notified() => {}
            _ = st.stopping.notified() => {
                st.machines.looping.store(false, Ordering::SeqCst);
                return;
            }
        }
    }
}

/// At boot: make the identity and start the loop when there are links.
pub async fn start_at_boot(st: &AppState) {
    machine_id(st);
    ensure_loop(st);
}

// ---------------------------------------------------------------------------
// Reads that go straight through

fn failure(st: &AppState, machine_id: &str, error: ClientError) -> DispatchError {
    let name = st
        .db
        .machine_link_get(machine_id)
        .ok()
        .flatten()
        .and_then(|link| link["name"].as_str().map(str::to_string))
        .unwrap_or_else(|| "That machine".to_string());
    match error {
        ClientError::Remote { code, message } => {
            let status = match code.as_str() {
                "not_found" => StatusCode::NOT_FOUND,
                "invalid_argument" | "invalid_params" => StatusCode::BAD_REQUEST,
                "forbidden_remote" | "forbidden" => StatusCode::FORBIDDEN,
                _ => StatusCode::BAD_GATEWAY,
            };
            derr(&code, &message, status)
        }
        ClientError::Revoked => derr(
            "provider_unavailable",
            &format!("{name} removed this computer's pairing. Pair it again."),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        ClientError::Invalid(message) => derr("invalid_argument", &message, StatusCode::BAD_REQUEST),
        ClientError::Unreachable | ClientError::TooLarge => {
            derr("provider_unavailable", &unreachable_detail(&name), StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

async fn read_through(st: &AppState, machine_id: &str, method: &str, params: Value) -> Result<Value, DispatchError> {
    link_or_missing(st, machine_id)?;
    client::rpc(st, machine_id, method, params).await.map_err(|error| failure(st, machine_id, error))
}

// ---------------------------------------------------------------------------
// Probe

/// What `/api/ping` showed at an address.
struct Probed {
    reachable: bool,
    is_bitbots: bool,
    trusted: bool,
    fingerprint: Option<[u8; 32]>,
}

fn pings_as_bitbots(body: &Value) -> bool {
    body["app"] == "bitbots" && body["role"] == "remote-gateway"
}

/// `GET /api/ping` with no credential and no `Origin`. Web PKI first; when that
/// refuses the certificate, once more with a verifier that only records it.
async fn probe_origin(origin: &str, timeout: Duration) -> Probed {
    if let Ok(reply) = client::send(&Trust::WebPki, Method::GET, origin, "/api/ping", false, None, None, timeout).await {
        return Probed { reachable: true, is_bitbots: pings_as_bitbots(&reply.json()), trusted: true, fingerprint: None };
    }
    let seen = Arc::new(Mutex::new(None));
    match client::send(&Trust::Record(seen.clone()), Method::GET, origin, "/api/ping", false, None, None, timeout).await {
        Ok(reply) => {
            let fingerprint = *seen.lock().unwrap();
            Probed { reachable: true, is_bitbots: pings_as_bitbots(&reply.json()), trusted: false, fingerprint }
        }
        Err(_) => Probed { reachable: false, is_bitbots: false, trusted: false, fingerprint: None },
    }
}

async fn probe(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let origin = client::clean_origin(p["url"].as_str().unwrap_or("")).map_err(|error| invalid(&error.message()))?;
    let probed = probe_origin(&origin, st.machines.timing().call_timeout).await;
    Ok(json!({
        "origin": origin,
        "reachable": probed.reachable,
        "isBitbots": probed.is_bitbots,
        "auth": if probed.trusted || !probed.reachable { "code" } else { "password" },
        "fingerprint": if probed.trusted { None } else { probed.fingerprint.map(|digest| client::format_fingerprint(&digest)) },
        "trusted": probed.trusted,
    }))
}

// ---------------------------------------------------------------------------
// Pairing

/// How the owner proved themselves to the other machine.
enum Proof {
    /// A pairing code, over a certificate web PKI trusts.
    Code(Zeroizing<String>),
    /// The other machine's password sign-in, over the certificate the owner
    /// compared and accepted.
    Password { username: String, password: Zeroizing<String>, fingerprint: [u8; 32] },
}

fn set_job(st: &AppState, id: &str, state: &'static str, detail: Option<String>, machine: Option<Value>) -> Option<Value> {
    let mut jobs = st.machines.jobs.lock().unwrap();
    let job = jobs.iter_mut().find(|job| job.id == id)?;
    job.state = state;
    job.detail = detail;
    if let Some(mut machine) = machine {
        // The job is stored with its event, so its machine never carries bots.
        machine["bots"] = json!([]);
        job.machine = machine;
    }
    Some(job.to_value())
}

async fn announce_job(st: &AppState, id: &str, state: &'static str, detail: Option<String>, machine: Option<Value>) {
    if let Some(job) = set_job(st, id, state, detail, machine) {
        st.emit("machine.pair.changed", json!({"job": job})).await;
    }
}

async fn pair_begin(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if p["confirm"] != true {
        return Err(invalid("Confirm linking this machine first."));
    }
    let origin = client::clean_origin(p["url"].as_str().unwrap_or("")).map_err(|error| invalid(&error.message()))?;
    let text = |key: &str| p[key].as_str().map(str::trim).filter(|value| !value.is_empty());
    let proof = if let Some(fingerprint) = text("fingerprint") {
        let username = text("username").ok_or_else(|| invalid("The other machine's user name is required."))?;
        let password = p["password"].as_str().filter(|value| !value.is_empty()).ok_or_else(|| invalid("The other machine's password is required."))?;
        let fingerprint = client::parse_fingerprint(fingerprint).ok_or_else(|| invalid("The certificate fingerprint can't be read."))?;
        Proof::Password { username: username.to_string(), password: Zeroizing::new(password.to_string()), fingerprint }
    } else {
        let code = text("code").ok_or_else(|| invalid("The pairing code is required."))?;
        Proof::Code(Zeroizing::new(code.to_string()))
    };
    let id = format!("job_{}", uuid::Uuid::new_v4().simple());
    let job = Job { id: id.clone(), url: origin.clone(), state: "pending", detail: None, machine: Value::Null };
    let value = job.to_value();
    {
        let mut jobs = st.machines.jobs.lock().unwrap();
        jobs.push(job);
        let extra = jobs.len().saturating_sub(MAX_JOBS);
        let dropped: Vec<String> = jobs.drain(..extra).map(|job| job.id).collect();
        let mut cancels = st.machines.cancels.lock().unwrap();
        for old in dropped {
            cancels.remove(&old);
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    st.machines.cancels.lock().unwrap().insert(id.clone(), cancel.clone());
    st.emit("machine.pair.changed", json!({"job": value})).await;
    let state = st.clone();
    tokio::spawn(async move { run_pair(state, id, origin, proof, cancel).await });
    Ok(json!({"job": value}))
}

async fn run_pair(st: AppState, id: String, origin: String, proof: Proof, cancel: Arc<AtomicBool>) {
    match pair_flow(&st, &origin, proof, &cancel).await {
        Ok(machine) => announce_job(&st, &id, "approved", None, Some(machine)).await,
        Err((state, detail)) => announce_job(&st, &id, state, Some(detail), None).await,
    }
    st.machines.cancels.lock().unwrap().remove(&id);
}

type PairFailure = (&'static str, String);

fn failed(detail: &str) -> PairFailure {
    ("failed", detail.to_string())
}

/// Best effort: the other machine forgets this device. Never an error.
async fn sign_out(trust: &Trust, origin: &str, token: &str) -> bool {
    client::send(trust, Method::POST, origin, "/api/logout", true, Some(&client::device_cookie(token)), None, Duration::from_secs(5))
        .await
        .is_ok_and(|reply| reply.status.is_success())
}

async fn pair_flow(st: &AppState, origin: &str, proof: Proof, cancel: &AtomicBool) -> Result<Value, PairFailure> {
    let timing = st.machines.timing();
    // 1. Look again: the address, and the certificate the owner accepted.
    let probed = probe_origin(origin, timing.call_timeout).await;
    if !probed.reachable {
        return Err(failed("That address can't be reached right now."));
    }
    if !probed.is_bitbots {
        return Err(failed("That address isn't a Bitbots Remote address."));
    }
    let (trust, auth, pin, submit_path, submit_body) = match &proof {
        Proof::Code(code) => {
            if !probed.trusted {
                return Err(failed("That machine now asks for its password. Start again."));
            }
            (Trust::WebPki, "code", None, "/api/pair", json!({"code": code.as_str(), "name": machine_name(st), "kind": "machine", "platform": "windows"}))
        }
        Proof::Password { username, password, fingerprint } => {
            let same = probed.fingerprint.is_some_and(|seen| subtle::ConstantTimeEq::ct_eq(seen.as_slice(), fingerprint.as_slice()).into());
            if !same {
                return Err(failed("The other machine's certificate changed."));
            }
            (
                Trust::Pin(*fingerprint),
                "password",
                Some(client::format_fingerprint(fingerprint)),
                "/api/login",
                json!({"username": username, "password": password.as_str(), "name": machine_name(st), "kind": "machine", "platform": "windows"}),
            )
        }
    };
    // 2. Ask. The password and the code are used for this one request.
    let reply = client::send(&trust, Method::POST, origin, submit_path, true, None, Some(&submit_body), timing.call_timeout)
        .await
        .map_err(|error| failed(&error.message()))?;
    drop(submit_body);
    drop(proof);
    let pair_cookie = reply.cookie(PAIR_COOKIE);
    if reply.status.as_u16() != 202 || pair_cookie.is_none() {
        let message = reply.json()["error"]["message"].as_str().unwrap_or("The other machine refused the request.").to_string();
        return Err(("failed", message));
    }
    let pair_cookie = format!("{PAIR_COOKIE}={}", pair_cookie.unwrap_or_default());
    // 3. Wait for the other owner, up to the window.
    let deadline = tokio::time::Instant::now() + timing.pair_window;
    let mut failures = 0u32;
    let approved = loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(("cancelled", "Linking was cancelled.".to_string()));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(("expired", "Nobody approved this on the other machine in time.".to_string()));
        }
        tokio::time::sleep(timing.poll_every).await;
        match client::send(&trust, Method::GET, origin, "/api/pair", true, Some(&pair_cookie), None, timing.call_timeout).await {
            Ok(reply) => {
                failures = 0;
                let body = reply.json();
                match body["state"].as_str() {
                    Some("approved") => break (reply, body),
                    Some("rejected") => return Err(("rejected", "The other machine's owner said no.".to_string())),
                    Some("expired") => return Err(("expired", "That request ran out of time. Start again.".to_string())),
                    _ => {}
                }
            }
            Err(_) => {
                failures += 1;
                if failures >= MAX_POLL_FAILURES {
                    return Err(failed("The other machine stopped answering."));
                }
            }
        }
    };
    // 4. Take the device sign-in, then learn who this is.
    let (reply, body) = approved;
    let token = Zeroizing::new(reply.cookie(DEVICE_COOKIE).ok_or_else(|| failed("The other machine didn't give this computer a sign-in."))?);
    let tier = body["device"]["tier"].as_str().filter(|tier| matches!(*tier, "viewer" | "chat" | "operator")).unwrap_or("viewer").to_string();
    let device_id = body["device"]["id"].as_str().map(str::to_string);
    let info = match client::rpc_direct(&trust, origin, &token, "machine.info", json!({}), timing.call_timeout).await {
        Ok(info) => info,
        Err(ClientError::Unreachable) => {
            sign_out(&trust, origin, &token).await;
            return Err(failed("The other machine stopped answering."));
        }
        Err(_) => {
            sign_out(&trust, origin, &token).await;
            return Err(failed("That machine needs a newer version of Bitbots."));
        }
    };
    let Some(other_id) = info["machineId"].as_str().filter(|id| client::safe_id(id)).map(str::to_string) else {
        sign_out(&trust, origin, &token).await;
        return Err(failed("That machine needs a newer version of Bitbots."));
    };
    if other_id == machine_id(st) {
        sign_out(&trust, origin, &token).await;
        client::delete_token(st, &other_id).await;
        return Err(failed("That's this machine."));
    }
    // 5. Keep the link. A second pairing replaces the old token.
    if client::write_token(st, &other_id, &token).await.is_err() {
        sign_out(&trust, origin, &token).await;
        return Err(failed("The sign-in for that machine could not be saved."));
    }
    let name: String = info["name"].as_str().map(str::trim).filter(|name| !name.is_empty()).unwrap_or("Another machine").chars().take(NAME_MAX).collect();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let saved = st.db.machine_link_upsert(&json!({
        "id": other_id,
        "name": name,
        "url": origin,
        "auth": auth,
        "fingerprint": pin,
        "tier": tier,
        "pairedAt": now,
        "lastSeenAt": now,
        "state": "online",
        "deviceId": device_id,
    }));
    let Ok(link) = saved else {
        client::delete_token(st, &other_id).await;
        sign_out(&trust, origin, &token).await;
        return Err(failed("The link could not be saved."));
    };
    st.machines.snapshots.lock().unwrap().remove(&other_id);
    ensure_loop(st);
    st.machines.wake.notify_one();
    Ok(row_of(st, &link))
}

fn pair_cancel(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = id_param(p, "id")?;
    let job = st
        .machines
        .jobs
        .lock()
        .unwrap()
        .iter()
        .find(|job| job.id == id)
        .map(Job::to_value)
        .ok_or_else(|| derr("not_found", "That pairing isn't running.", StatusCode::NOT_FOUND))?;
    if let Some(flag) = st.machines.cancels.lock().unwrap().get(id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(json!({"job": job}))
}

fn pair_list(st: &AppState) -> Value {
    json!({"jobs": st.machines.jobs.lock().unwrap().iter().map(Job::to_value).collect::<Vec<_>>()})
}

// ---------------------------------------------------------------------------
// Rename and remove

fn rename(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = id_param(p, "id")?;
    let name = p["name"].as_str().ok_or_else(|| invalid("name is required"))?.trim();
    if !(1..=NAME_MAX).contains(&name.chars().count()) {
        return Err(invalid("The name must be 1 to 60 characters."));
    }
    link_or_missing(st, id)?;
    st.db.machine_link_rename(id, name).map_err(internal)?;
    row_by_id(st, id).ok_or_else(|| derr("not_found", "That machine isn't linked.", StatusCode::NOT_FOUND))
}

async fn remove(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let id = id_param(p, "id")?;
    if p["confirm"] != true {
        return Err(invalid("Confirm removing this machine first."));
    }
    let link = link_or_missing(st, id)?;
    // Best effort: when the other machine is away, removal still succeeds.
    let signed_out = match (client::trust_of(&link), client::read_token(st, id).await) {
        (Ok(trust), Some(token)) => sign_out(&trust, link["url"].as_str().unwrap_or(""), &token).await,
        _ => false,
    };
    client::delete_token(st, id).await;
    let removed = st.db.machine_link_delete(id).map_err(internal)?;
    st.machines.snapshots.lock().unwrap().remove(id);
    st.machines.wake.notify_one();
    Ok(json!({"removed": removed, "signedOut": signed_out}))
}

// ---------------------------------------------------------------------------
// The RPC table

pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "machine.self" => Ok(self_value(st)),
        "machine.self.rename" => self_rename(st, p),
        "machine.info" => Ok(info_value(st)),
        "machine.probe" => probe(st, p).await,
        "machine.pair.begin" => pair_begin(st, p).await,
        "machine.pair.cancel" => pair_cancel(st, p),
        "machine.pair.list" => Ok(pair_list(st)),
        "machine.list" => list_value(st),
        "machine.rename" => rename(st, p),
        "machine.remove" => remove(st, p).await,
        "machine.refresh" => {
            let id = id_param(p, "id")?;
            link_or_missing(st, id)?;
            refresh_one(st, id).await.ok_or_else(|| derr("not_found", "That machine isn't linked.", StatusCode::NOT_FOUND))
        }
        "machine.conversations" => {
            let machine = id_param(p, "machineId")?;
            let agent = id_param(p, "agentId")?;
            read_through(st, machine, "agent.conversations", json!({"agentId": agent})).await
        }
        "machine.conversation" => {
            let machine = id_param(p, "machineId")?;
            let session = id_param(p, "sessionId")?;
            read_through(st, machine, "session.get", json!({"sessionId": session})).await.map(|session| json!({"session": session}))
        }
        _ => Err(derr("not_found", "unknown machine method", StatusCode::NOT_FOUND)),
    }
}
