//! Remote mode (P1): the host-side gateway, its cycle and its `remote.*` API.
//!
//! Files here: [`policy`] (the shared tier and redaction policy, WP6a),
//! [`tailscale`] (the CLI seam), [`pairing`] (codes, offers, tokens) and
//! [`web`] (the HTTP and WebSocket surface, WP6b). This module owns the
//! lifecycle: [`RemoteState`] lives in `AppState`, `remote.*` is dispatched
//! here, and the listener starts at boot when `remote.enabled` is true.
//!
//! Rules that shape every line (see `AGENTS.md` and `docs/remote/PROTOCOL.md`):
//!
//! * the gateway binds `127.0.0.1` only, never `0.0.0.0`, a LAN address or
//!   `[::]`;
//! * it calls `dispatch()` in process and never reads, accepts, logs or returns
//!   the daemon capability;
//! * it never runs `tailscale funnel` or `tailscale serve reset`;
//! * `tailscale status --json` is never logged (it carries the owner's email).

pub mod pairing;
pub mod policy;
pub mod tailscale;
pub mod web;
#[cfg(test)]
mod tests;

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use chrono::{DateTime, Local, Timelike, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;
use tokio::sync::{Notify, RwLock};

/// `remote.port` default. The gateway binds this on loopback.
pub const DEFAULT_REMOTE_PORT: u16 = 48620;
/// A request body larger than this is `payload_too_large`.
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// Per-device token bucket: sustained rate and burst.
pub const RATE_LIMIT_PER_SECOND: f64 = 20.0;
pub const RATE_LIMIT_BURST: f64 = 40.0;
/// `remote.activity.list` default page size.
pub const ACTIVITY_DEFAULT_LIMIT: usize = 100;

/// The default `remote.security` value, matching `REMOTE_TIERS` defaults.
pub fn default_security() -> Security {
    Security {
        approvals_from_remote: false,
        idle_expiry_days: 30,
        quiet_hours: QuietHours {
            enabled: false,
            from: "22:00".to_string(),
            to: "07:00".to_string(),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuietHours {
    pub enabled: bool,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Security {
    pub approvals_from_remote: bool,
    /// Days of silence after which a device is removed; 0 means never.
    pub idle_expiry_days: u32,
    pub quiet_hours: QuietHours,
}

impl Security {
    pub fn from_value(value: &Value) -> Self {
        let defaults = default_security();
        let Some(object) = value.as_object() else { return defaults };
        let quiet = object.get("quietHours").and_then(Value::as_object);
        Self {
            approvals_from_remote: object
                .get("approvalsFromRemote")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.approvals_from_remote),
            idle_expiry_days: object
                .get("idleExpiryDays")
                .and_then(Value::as_u64)
                .map(|days| days.min(3_650) as u32)
                .unwrap_or(defaults.idle_expiry_days),
            quiet_hours: QuietHours {
                enabled: quiet
                    .and_then(|quiet| quiet.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(defaults.quiet_hours.enabled),
                from: quiet
                    .and_then(|quiet| quiet.get("from"))
                    .and_then(Value::as_str)
                    .filter(|text| parse_clock(text).is_some())
                    .unwrap_or(&defaults.quiet_hours.from)
                    .to_string(),
                to: quiet
                    .and_then(|quiet| quiet.get("to"))
                    .and_then(Value::as_str)
                    .filter(|text| parse_clock(text).is_some())
                    .unwrap_or(&defaults.quiet_hours.to)
                    .to_string(),
            },
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "approvalsFromRemote": self.approvals_from_remote,
            "idleExpiryDays": self.idle_expiry_days,
            "quietHours": {
                "enabled": self.quiet_hours.enabled,
                "from": self.quiet_hours.from,
                "to": self.quiet_hours.to,
            },
        })
    }

    /// A device silent for longer than `idleExpiryDays` is treated as revoked.
    pub fn idle_expired(&self, last_seen: Option<&str>, now: DateTime<Utc>) -> bool {
        if self.idle_expiry_days == 0 {
            return false;
        }
        let Some(last_seen) = last_seen.and_then(|text| DateTime::parse_from_rfc3339(text).ok()) else {
            return false;
        };
        now.signed_duration_since(last_seen.with_timezone(&Utc)).num_days() >= i64::from(self.idle_expiry_days)
    }

    /// Whether quiet hours are on right now. Equal bounds mean all day.
    pub fn quiet_hours_active(&self, now: DateTime<Local>) -> bool {
        if !self.quiet_hours.enabled {
            return false;
        }
        let Some(from) = parse_clock(&self.quiet_hours.from) else { return false };
        let Some(to) = parse_clock(&self.quiet_hours.to) else { return false };
        let minutes = now.hour() * 60 + now.minute();
        if from == to {
            return true;
        }
        if from < to {
            (from..to).contains(&minutes)
        } else {
            minutes >= from || minutes < to
        }
    }
}

fn parse_clock(text: &str) -> Option<u32> {
    let (hours, minutes) = text.trim().split_once(':')?;
    let hours: u32 = hours.parse().ok()?;
    let minutes: u32 = minutes.parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(hours * 60 + minutes)
}

/// The event timestamp shape the daemon uses everywhere.
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// The gateway state

/// A running gateway listener.
pub struct RunningServer {
    pub addr: std::net::SocketAddr,
    notify: Arc<Notify>,
    handle: tokio::task::JoinHandle<()>,
}

struct SocketEntry {
    id: u64,
    /// Dropping the sender is what closes the socket's `select!` arm.
    _kick: tokio::sync::mpsc::Sender<()>,
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

struct Inner {
    enabled: bool,
    /// `off`, `starting`, `online` or `error`.
    link: &'static str,
    error: Option<String>,
    tailscale: tailscale::TailscaleState,
    serve_port: Option<u16>,
    serve_origin: Option<String>,
    running: Option<RunningServer>,
    sockets: HashMap<String, SocketEntry>,
    next_socket_id: u64,
}

/// Everything the gateway owns, held in `AppState`.
pub struct RemoteState {
    /// The Tailscale CLI seam. Tests replace it with a fake.
    cli: RwLock<Arc<dyn tailscale::TailscaleCli>>,
    pub pairing: StdMutex<pairing::PairingState>,
    /// The static-file manifest built once at startup.
    pub web: web::StaticFiles,
    /// The name devices see for this computer.
    pub host_name: String,
    inner: StdMutex<Inner>,
    rate: StdMutex<HashMap<String, Bucket>>,
    security_cache: StdMutex<Option<Security>>,
}

impl RemoteState {
    pub fn new() -> Self {
        Self::with_cli(
            tailscale::RealTailscale::discover()
                .map(|real| Arc::new(real) as Arc<dyn tailscale::TailscaleCli>)
                .unwrap_or_else(|| Arc::new(tailscale::MissingCli) as Arc<dyn tailscale::TailscaleCli>),
        )
    }

    pub fn with_cli(cli: Arc<dyn tailscale::TailscaleCli>) -> Self {
        Self {
            cli: RwLock::new(cli),
            pairing: StdMutex::new(pairing::PairingState::default()),
            web: web::StaticFiles::from_env(),
            host_name: host_name(),
            inner: StdMutex::new(Inner {
                enabled: false,
                link: "off",
                error: None,
                tailscale: tailscale::TailscaleState::NotInstalled,
                serve_port: None,
                serve_origin: None,
                running: None,
                sockets: HashMap::new(),
                next_socket_id: 1,
            }),
            rate: StdMutex::new(HashMap::new()),
            security_cache: StdMutex::new(None),
        }
    }

    /// Tests swap in a fake so no real `tailscale` process is ever started.
    #[cfg(test)]
    pub fn set_cli(&self, cli: Arc<dyn tailscale::TailscaleCli>) {
        *self.cli.try_write().expect("the CLI lock is only taken for a moment") = cli;
    }

    async fn cli(&self) -> Arc<dyn tailscale::TailscaleCli> {
        self.cli.read().await.clone()
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.lock().unwrap().enabled
    }

    pub fn serve_origin(&self) -> Option<String> {
        self.inner.lock().unwrap().serve_origin.clone()
    }

    fn set_link(&self, link: &'static str, error: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.link = link;
        inner.error = error;
    }

    /// The cached `remote.security` options, loaded from the settings store
    /// once and refreshed on every write.
    pub fn security(&self, st: &AppState) -> Security {
        if let Some(cached) = self.security_cache.lock().unwrap().clone() {
            return cached;
        }
        let value = st.db.settings().unwrap_or(Value::Null);
        let security = Security::from_value(value.get("remote.security").unwrap_or(&Value::Null));
        *self.security_cache.lock().unwrap() = Some(security.clone());
        security
    }

    pub fn set_security(&self, security: Security) {
        *self.security_cache.lock().unwrap() = Some(security);
    }

    /// Per-device token bucket: 20 requests a second with a burst of 40.
    pub fn rate_allow(&self, device_id: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self.rate.lock().unwrap();
        let bucket = buckets.entry(device_id.to_string()).or_insert(Bucket { tokens: RATE_LIMIT_BURST, at: now });
        let elapsed = now.saturating_duration_since(bucket.at).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * RATE_LIMIT_PER_SECOND).min(RATE_LIMIT_BURST);
        bucket.at = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Registers the device's live socket, replacing any older one. Returns the
    /// new socket's id and whether an older socket was closed.
    pub fn register_socket(&self, device_id: &str, kick: tokio::sync::mpsc::Sender<()>) -> (bool, u64) {
        let mut inner = self.inner.lock().unwrap();
        let id = inner.next_socket_id;
        inner.next_socket_id += 1;
        let replaced = inner.sockets.insert(device_id.to_string(), SocketEntry { id, _kick: kick }).is_some();
        (replaced, id)
    }

    /// Closes a device's socket at once (revoke, sign-out).
    pub fn close_socket(&self, device_id: &str) {
        self.inner.lock().unwrap().sockets.remove(device_id);
    }

    pub fn close_all_sockets(&self) {
        self.inner.lock().unwrap().sockets.clear();
    }

    /// Removes this socket's own entry, never a newer one's.
    pub fn forget_socket(&self, device_id: &str, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.sockets.get(device_id).map(|entry| entry.id) == Some(id) {
            inner.sockets.remove(device_id);
        }
    }

    /// The devices with a live event socket.
    pub fn online_devices(&self) -> std::collections::HashSet<String> {
        self.inner.lock().unwrap().sockets.keys().cloned().collect()
    }

    #[cfg(test)]
    pub fn connected_count(&self) -> usize {
        self.inner.lock().unwrap().sockets.len()
    }

    #[cfg(test)]
    pub fn bound_address(&self) -> Option<std::net::SocketAddr> {
        self.inner.lock().unwrap().running.as_ref().map(|running| running.addr)
    }

    #[cfg(test)]
    pub fn link(&self) -> &'static str {
        self.inner.lock().unwrap().link
    }

    #[cfg(test)]
    pub fn tailscale_state(&self) -> tailscale::TailscaleState {
        self.inner.lock().unwrap().tailscale
    }

    #[cfg(test)]
    pub fn serve_port(&self) -> Option<u16> {
        self.inner.lock().unwrap().serve_port
    }

    /// The status object of `remote.status`, and of the `remote.changed` event.
    /// Never includes the tailnet login or raw status JSON.
    pub fn status_value(&self, st: &AppState) -> Value {
        let inner = self.inner.lock().unwrap();
        let devices = st.db.remote_devices().unwrap_or_default();
        let live = devices.iter().filter(|device| device["revokedAt"].is_null() && device["signedOutAt"].is_null()).count();
        json!({
            "enabled": inner.enabled,
            "link": inner.link,
            "url": inner.serve_origin,
            "port": inner.running.as_ref().map(|running| running.addr.port()).unwrap_or_else(|| remote_port(st)),
            "servePort": inner.serve_port,
            "tailscale": inner.tailscale.as_str(),
            "hostName": self.host_name,
            "deviceCount": live,
            "connectedCount": inner.sockets.len(),
            "keepAwake": false,
            "error": inner.error,
        })
    }}

impl Default for RemoteState {
    fn default() -> Self {
        Self::new()
    }
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|name| !name.trim().is_empty()))
        .unwrap_or_else(|| "This computer".to_string())
}

/// `remote.port`, defaulting to 48620. Zero means "any free port", which tests
/// use so they never collide.
pub fn remote_port(st: &AppState) -> u16 {
    let settings = st.db.settings().unwrap_or(Value::Null);
    settings
        .get("remote.port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(DEFAULT_REMOTE_PORT)
}

// ---------------------------------------------------------------------------
// Audit

/// One short, content-free activity line. No message text, no paths, no
/// command lines, ever.
pub async fn audit(st: &AppState, device_id: Option<&str>, kind: &str, summary: &str) -> Value {
    let entry = st
        .db
        .remote_activity_push(&now_rfc3339(), device_id, kind, summary)
        .unwrap_or(Value::Null);
    if !entry.is_null() {
        st.emit("remote.activity", json!({ "entry": entry })).await;
    }
    entry
}

/// Emits `remote.changed` with the fresh status.
async fn emit_status(st: &AppState) {
    let status = st.remote.status_value(st);
    st.emit("remote.changed", json!({ "status": status })).await;
}

/// The newest persisted event of one type. Tests read the effect of an action
/// from the same table the desktop replays from.
#[cfg(test)]
pub async fn events_last(st: &AppState, event_type: &str) -> Value {
    st.db
        .replay_events(0, 5_000)
        .unwrap_or_default()
        .into_iter()
        .rev()
        .find(|event| event["type"] == event_type)
        .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Lifecycle

/// Starts the gateway after boot when `remote.enabled` is true. A Tailscale
/// problem becomes a status the page explains, never a crash.
pub async fn start_at_boot(st: &AppState) {
    let settings = st.db.settings().unwrap_or(Value::Null);
    if settings.get("remote.enabled") != Some(&Value::Bool(true)) {
        // Still record what Tailscale looks like, so the page can explain the
        // fix before the owner presses the switch.
        refresh_tailscale(st).await;
        emit_status(st).await;
        return;
    }
    if let Err(error) = enable(st).await {
        st.remote.set_link("error", Some(error.1.message.clone()));
        emit_status(st).await;
    }
}

/// Re-reads Tailscale and updates the status fields. If Funnel has appeared on
/// a port Bitbots uses, the gateway stops serving (THREAT_MODEL T30).
async fn refresh_tailscale(st: &AppState) {
    let remote = st.remote.clone();
    let cli = remote.cli().await;
    let target = tailscale::target_for(remote_port(st));
    let probe = tailscale::probe(cli.as_ref(), &target);
    match probe {
        tailscale::Probe::Ready { status, serve_port, .. } => {
            let mut inner = remote.inner.lock().unwrap();
            inner.tailscale = tailscale::TailscaleState::Ready;
            inner.serve_port = Some(serve_port);
            inner.serve_origin = status.origin(serve_port);
            if inner.link == "error" {
                inner.error = None;
            }
        }
        tailscale::Probe::Unavailable { state, message } => {
            let funnel = state == tailscale::TailscaleState::FunnelOn;
            let was_enabled = {
                let mut inner = remote.inner.lock().unwrap();
                inner.tailscale = state;
                inner.error = Some(message.clone());
                inner.enabled
            };
            if was_enabled && funnel {
                stop_serving(&remote).await;
                remote.set_link("error", Some(message));
            }
        }
    }
}

/// Turns Remote on: probe Tailscale, bind loopback, publish with `serve`.
pub async fn enable(st: &AppState) -> Result<Value, DispatchError> {
    if st.remote.is_enabled() {
        return Ok(st.remote.status_value(st));
    }
    st.remote.set_link("starting", None);
    emit_status(st).await;

    let remote = st.remote.clone();
    let cli = remote.cli().await;
    let remote_port = remote_port(st);
    let probe = tailscale::probe(cli.as_ref(), &tailscale::target_for(remote_port));
    let (status, serve_port) = match probe {
        tailscale::Probe::Ready { status, serve_port, .. } => (status, serve_port),
        tailscale::Probe::Unavailable { state, message } => {
            {
                let mut inner = remote.inner.lock().unwrap();
                inner.tailscale = state;
                inner.enabled = false;
            }
            remote.set_link("error", Some(message.clone()));
            emit_status(st).await;
            return Err(derr("unsupported", &message, StatusCode::NOT_IMPLEMENTED));
        }
    };

    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", remote_port)).await {
        Ok(listener) => listener,
        Err(_) => {
            let message = format!("Port {remote_port} is already in use on this computer.");
            remote.set_link("error", Some(message.clone()));
            emit_status(st).await;
            return Err(derr("conflict", &message, StatusCode::CONFLICT));
        }
    };
    let addr = listener.local_addr().map_err(|_| derr("internal", "The remote listener could not start.", StatusCode::INTERNAL_SERVER_ERROR))?;
    // Belt and braces: the bind is loopback by construction.
    if !addr.ip().is_loopback() {
        return Err(derr("internal", "The remote listener refused a non-loopback address.", StatusCode::INTERNAL_SERVER_ERROR));
    }
    let running = spawn_server(listener, web::WebState { daemon: st.clone(), remote: remote.clone() });

    let on_args = tailscale::serve_on_args(serve_port, addr.port());
    match tailscale::run_checked(cli.as_ref(), &on_args) {
        Ok(output) if output.success => {}
        Ok(_) => {
            stop_server(running).await;
            let message = "Tailscale refused to publish the Bitbots address.".to_string();
            remote.set_link("error", Some(message.clone()));
            emit_status(st).await;
            return Err(derr("unsupported", &message, StatusCode::NOT_IMPLEMENTED));
        }
        Err(message) => {
            stop_server(running).await;
            remote.set_link("error", Some(message.clone()));
            emit_status(st).await;
            return Err(derr("unsupported", &message, StatusCode::NOT_IMPLEMENTED));
        }
    }

    {
        let mut inner = remote.inner.lock().unwrap();
        inner.enabled = true;
        inner.link = "online";
        inner.error = None;
        inner.tailscale = tailscale::TailscaleState::Ready;
        inner.serve_port = Some(serve_port);
        inner.serve_origin = status.origin(serve_port);
        inner.running = Some(running);
    }
    let _ = st.db.set_setting("remote.enabled", &json!(true));
    let _ = st.db.set_setting("remote.servePort", &json!(serve_port));
    emit_status(st).await;
    Ok(st.remote.status_value(st))
}

/// Turns Remote off: close every device socket, stop the listener and remove
/// only the handler Bitbots added. Paired devices are kept.
pub async fn disable(st: &AppState) -> Result<Value, DispatchError> {
    let remote = st.remote.clone();
    let was_enabled = {
        let inner = remote.inner.lock().unwrap();
        inner.enabled
    };
    let cli = remote.cli().await;
    let serve_port = remote.inner.lock().unwrap().serve_port;
    let mut warning = None;
    if was_enabled {
        if let Some(serve_port) = serve_port {
            match tailscale::help_documents_off(cli.as_ref()) {
                Ok(true) => {
                    let off_args = tailscale::serve_off_args(serve_port);
                    match tailscale::run_checked(cli.as_ref(), &off_args) {
                        Ok(output) if !output.success => {
                            warning = Some("Tailscale did not remove the Bitbots address. Remove it in the Tailscale admin console if it stays listed.".to_string());
                        }
                        Ok(_) => {}
                        Err(message) => warning = Some(message),
                    }
                }
                Ok(false) => {
                    warning = Some("The installed Tailscale CLI does not document turning one serve handler off, so Bitbots left it alone. Remove the Bitbots address with `tailscale serve` if it stays listed.".to_string());
                }
                Err(message) => warning = Some(message),
            }
        }
    }
    stop_serving(&remote).await;
    {
        let mut inner = remote.inner.lock().unwrap();
        inner.enabled = false;
        inner.link = "off";
        inner.error = warning.clone();
        inner.serve_port = None;
        inner.serve_origin = None;
    }
    let _ = st.db.set_setting("remote.enabled", &json!(false));
    emit_status(st).await;
    Ok(st.remote.status_value(st))
}

fn spawn_server(listener: tokio::net::TcpListener, state: web::WebState) -> RunningServer {
    let addr = listener.local_addr().expect("a bound listener has a local address");
    let notify = Arc::new(Notify::new());
    let shutdown = notify.clone();
    let app = web::router(state);
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move { shutdown.notified().await })
            .await;
    });
    RunningServer { addr, notify, handle }
}

async fn stop_server(running: RunningServer) {
    running.notify.notify_one();
    let _ = running.handle.await;
}

/// Stops the listener and closes every device socket.
async fn stop_serving(remote: &Arc<RemoteState>) {
    let running = remote.inner.lock().unwrap().running.take();
    if let Some(running) = running {
        stop_server(running).await;
    }
    remote.close_all_sockets();
}

// ---------------------------------------------------------------------------
// remote.*

/// The `remote.*` family. Only the desktop's loopback API reaches it: every
/// `remote.*` method is `never` remote in `tiers.json`.
pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "remote.status" => {
            refresh_tailscale(st).await;
            Ok(st.remote.status_value(st))
        }
        "remote.enable" => enable(st).await,
        "remote.disable" => disable(st).await,
        "remote.pair.begin" => pair_begin(st).await,
        "remote.pair.cancel" => pair_cancel(st).await,
        "remote.pair.confirm" => pair_confirm(st, p).await,
        "remote.devices.list" => devices_list(st),
        "remote.devices.update" => devices_update(st, p).await,
        "remote.devices.revoke" => devices_revoke(st, p).await,
        "remote.security.get" => Ok(st.remote.security(st).to_value()),
        "remote.security.set" => security_set(st, p),
        "remote.activity.list" => activity_list(st, p),
        _ => Err(derr("unsupported", "method is not supported", StatusCode::NOT_FOUND)),
    }
}

async fn pair_begin(st: &AppState) -> Result<Value, DispatchError> {
    if !st.remote.is_enabled() {
        return Err(derr("conflict", "Turn Remote on before pairing a device.", StatusCode::CONFLICT));
    }
    let offer = st.remote.pairing.lock().unwrap().begin(Utc::now());
    let origin = st.remote.serve_origin().unwrap_or_default();
    let url = format!("{origin}/");
    Ok(json!({
        "code": offer.code,
        "url": url,
        "qrPayload": format!("{url}#pair={}", offer.code),
        "expiresAt": offer.expires_at.to_rfc3339(),
        "attemptsLeft": offer.attempts_left(),
    }))
}

async fn pair_cancel(st: &AppState) -> Result<Value, DispatchError> {
    let outcome = st.remote.pairing.lock().unwrap().cancel(Utc::now());
    if let Some(outcome) = outcome {
        st.emit("remote.pairing.completed", json!({"outcome": outcome.as_str()})).await;
    }
    Ok(json!({"cancelled": outcome.is_some()}))
}

async fn pair_confirm(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let pairing_id = p["pairingId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "pairingId is required", StatusCode::BAD_REQUEST))?;
    let approve = p["approve"].as_bool().ok_or_else(|| derr("invalid_argument", "approve must be a boolean", StatusCode::BAD_REQUEST))?;
    let tier = match p.get("tier") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .and_then(|name| match name {
                    "viewer" => Some(policy::Tier::Viewer),
                    "chat" => Some(policy::Tier::Chat),
                    "operator" => Some(policy::Tier::Operator),
                    _ => None,
                })
                .ok_or_else(|| derr("invalid_argument", "tier must be viewer, chat or operator", StatusCode::BAD_REQUEST))?,
        ),
    };
    let result = { st.remote.pairing.lock().unwrap().confirm(pairing_id, approve, tier, Utc::now()) };
    let approved = match result {
        Ok(approved) => approved,
        Err(message) => {
            let code = if approve && tier.is_none() { "invalid_argument" } else { "conflict" };
            return Err(derr(code, &message, if code == "invalid_argument" { StatusCode::BAD_REQUEST } else { StatusCode::CONFLICT }));
        }
    };
    match approved {
        Some(approved) => {
            let device = approved["device"].clone();
            let token = approved["token"].as_str().unwrap_or_default().to_string();
            let hash = pairing::hash_token(&token);
            let device_id = device["id"].as_str().unwrap_or_default().to_string();
            st.db.remote_device_create(&device, &hash).map_err(|_| derr("internal", "The device could not be saved.", StatusCode::INTERNAL_SERVER_ERROR))?;
            audit(st, Some(&device_id), "paired", &format!("{} was paired.", device["name"].as_str().unwrap_or("A device"))).await;
            st.emit("remote.pairing.completed", json!({"pairingId": pairing_id, "outcome": "approved", "deviceId": device_id})).await;
            st.emit("remote.device.changed", json!({"action": "paired", "device": device})).await;
            Ok(json!({"approved": true, "device": st.db.remote_device_get(&device_id).ok().flatten().unwrap_or(Value::Null)}))
        }
        None => {
            st.emit("remote.pairing.completed", json!({"pairingId": pairing_id, "outcome": "rejected"})).await;
            Ok(json!({"approved": false}))
        }
    }
}

fn devices_list(st: &AppState) -> Result<Value, DispatchError> {
    let devices = st
        .db
        .remote_devices()
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    let security = st.remote.security(st);
    let online = st.remote.online_devices();
    let now = Utc::now();
    let live: Vec<Value> = devices
        .into_iter()
        .filter(|device| {
            device["revokedAt"].is_null()
                && device["signedOutAt"].is_null()
                && !security.idle_expired(device["lastSeenAt"].as_str(), now)
        })
        .map(|mut device| {
            let is_online = device["id"].as_str().is_some_and(|id| online.contains(id));
            device["online"] = json!(is_online);
            device
        })
        .collect();
    Ok(json!({"devices": live}))
}

async fn devices_update(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let device_id = p["deviceId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "deviceId is required", StatusCode::BAD_REQUEST))?;
    if p.get("tier").is_some_and(|tier| !tier.is_null() && !tier.as_str().is_some_and(|name| matches!(name, "viewer" | "chat" | "operator"))) {
        return Err(derr("invalid_argument", "tier must be viewer, chat or operator", StatusCode::BAD_REQUEST));
    }
    let name = p.get("name").and_then(Value::as_str);
    let tier = p.get("tier").and_then(Value::as_str);
    let updated = st
        .db
        .remote_device_update(device_id, name, tier)
        .map_err(|error| derr("invalid_argument", &error.to_string(), StatusCode::BAD_REQUEST))?
        .ok_or_else(|| derr("not_found", "Device not found.", StatusCode::NOT_FOUND))?;
    st.emit("remote.device.changed", json!({"action": "updated", "device": updated.clone()})).await;
    Ok(json!({"device": updated}))
}

async fn devices_revoke(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let device_id = p["deviceId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| derr("invalid_argument", "deviceId is required", StatusCode::BAD_REQUEST))?;
    let existing = st
        .db
        .remote_device_get(device_id)
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?
        .ok_or_else(|| derr("not_found", "Device not found.", StatusCode::NOT_FOUND))?;
    st.db
        .remote_device_revoke(device_id, &now_rfc3339())
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    st.remote.close_socket(device_id);
    audit(st, Some(device_id), "revoked", &format!("{} was removed.", existing["name"].as_str().unwrap_or("A device"))).await;
    st.emit("remote.device.changed", json!({"action": "revoked", "device": existing})).await;
    Ok(json!({"revoked": true}))
}

fn security_set(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let mut security = Security::from_value(p);
    // Only the fields the contract names are honoured; everything else falls
    // back to the current value or the default.
    if p.get("approvalsFromRemote").is_some_and(|value| !value.is_boolean()) {
        return Err(derr("invalid_argument", "approvalsFromRemote must be a boolean", StatusCode::BAD_REQUEST));
    }
    if let Some(days) = p.get("idleExpiryDays") {
        if !days.as_u64().is_some_and(|days| days <= 3_650) {
            return Err(derr("invalid_argument", "idleExpiryDays must be a number of days from 0 to 3650", StatusCode::BAD_REQUEST));
        }
    }
    if let Some(quiet) = p.get("quietHours") {
        if !quiet.is_object() {
            return Err(derr("invalid_argument", "quietHours must be an object", StatusCode::BAD_REQUEST));
        }
        for key in ["from", "to"] {
            if let Some(value) = quiet.get(key) {
                if !value.as_str().and_then(parse_clock).is_some() {
                    return Err(derr("invalid_argument", "quiet hours must be times like 22:00", StatusCode::BAD_REQUEST));
                }
            }
        }
    }
    if p.get("quietHours").is_none() {
        security.quiet_hours = st.remote.security(st).quiet_hours;
    }
    st.db
        .set_setting("remote.security", &security.to_value())
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    st.remote.set_security(security.clone());
    Ok(security.to_value())
}

fn activity_list(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let limit = match p.get("limit") {
        None | Some(Value::Null) => ACTIVITY_DEFAULT_LIMIT,
        Some(value) => value.as_u64().ok_or_else(|| derr("invalid_argument", "limit must be a positive integer", StatusCode::BAD_REQUEST))? as usize,
    };
    let entries = st
        .db
        .remote_activity_list(limit)
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    Ok(json!({"entries": entries}))
}
