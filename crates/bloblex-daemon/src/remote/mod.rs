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

pub mod connectivity;
pub mod native;
pub mod pairing;
pub mod policy;
/// Phase 5, section 7: Web Push encryption and signing.
/// Nothing calls it yet: sending is the next chunk, so the dead-code lint is
/// held off here until then.
#[allow(dead_code)]
pub mod push;
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
use std::time::{Duration, Instant};
use tokio::sync::{Notify, RwLock};

/// `remote.port` default. The gateway binds this on loopback.
pub const DEFAULT_REMOTE_PORT: u16 = 48620;
/// A request body larger than this is `payload_too_large`.
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// Per-device token bucket: sustained rate and burst.
pub const RATE_LIMIT_PER_SECOND: f64 = 20.0;
pub const RATE_LIMIT_BURST: f64 = 40.0;
/// Per-source bucket for the unauthenticated routes: 30 requests in 10 s, burst
/// 60 (FIX35 C1 §4). Applied to `/api/login`, `/api/pair` and the static files.
pub const UNAUTH_RATE_PER_SECOND: f64 = 3.0;
pub const UNAUTH_RATE_BURST: f64 = 60.0;
/// Login lockout: five failed sign-ins per source in fifteen minutes locks that
/// source out for fifteen minutes.
pub const LOGIN_FAILURES_PER_SOURCE: usize = 5;
pub const LOGIN_FAILURE_WINDOW_SECS: u64 = 15 * 60;
pub const LOGIN_LOCKOUT_SECS: u64 = 15 * 60;
/// A burst across every source pauses all sign-ins for half an hour.
pub const LOGIN_GLOBAL_FAILURES: usize = 30;
pub const LOGIN_GLOBAL_WINDOW_SECS: u64 = 60 * 60;
pub const LOGIN_GLOBAL_PAUSE_SECS: u64 = 30 * 60;
/// `remote.activity.list` default page size.
pub const ACTIVITY_DEFAULT_LIMIT: usize = 100;
/// The two Remote methods. `remote.method` holds one of these.
pub const METHOD_TAILSCALE: &str = "tailscale";
pub const METHOD_NATIVE: &str = "native";

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

/// Turns a future `Instant` (a lockout or pause) into a wall-clock timestamp.
/// `Instant` has no date, so the delta from now is added to `Utc::now()`.
fn instant_to_rfc3339(instant: Instant) -> String {
    let delta = instant.saturating_duration_since(Instant::now());
    (Utc::now() + chrono::Duration::from_std(delta).unwrap_or_default())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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

/// The unauthenticated-route limiter and the sign-in lockout (FIX35 C1 §4).
#[derive(Default)]
struct AbuseState {
    /// Per-source token bucket for `/api/login`, `/api/pair` and static files.
    buckets: HashMap<String, Bucket>,
    /// Failed sign-ins per source within the window.
    per_source: HashMap<String, Vec<Instant>>,
    /// Failed sign-ins across every source within the window.
    global: Vec<Instant>,
    /// Sources locked out until this instant.
    locked: HashMap<String, Instant>,
    /// When set, every sign-in is refused until this instant.
    paused_until: Option<Instant>,
}

/// What one failed sign-in did to the limits.
pub struct LoginLockout {
    /// The source is now locked out (or was already).
    pub locked: bool,
    /// This failure started the source's lockout, not an earlier one. Only a
    /// start writes an activity line, so a flood cannot bury the log.
    pub started: bool,
    /// The global pause started with this failure.
    pub global_paused: bool,
    pub until: Option<Instant>,
}

struct Inner {
    enabled: bool,
    /// `off`, `starting`, `online` or `error`.
    link: &'static str,
    error: Option<String>,
    tailscale: tailscale::TailscaleState,
    gateway_conflict_port: Option<u16>,
    serve_port: Option<u16>,
    serve_origin: Option<String>,
    running: Option<RunningServer>,
    sockets: HashMap<String, SocketEntry>,
    next_socket_id: u64,
    /// Native Remote's listener, certificate and reach info (FIX35 C1).
    native: native::NativeState,
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
    abuse: StdMutex<AbuseState>,
    security_cache: StdMutex<Option<Security>>,
    /// The active method, read from `remote.method` once and refreshed on a write.
    method_cache: StdMutex<Option<String>>,
    /// Phase 5, section 7: Web Push, its transport seam and its rate limit.
    pub push: push::PushState,
    /// Test seam: the permission commands run for the native key file.
    #[cfg(test)]
    pub key_commands: StdMutex<Vec<Vec<String>>>,
    /// Test seam: a fake UPnP gateway and a fixed firewall reading, so no test
    /// touches a router, the network or `netsh`.
    #[cfg(test)]
    pub seams: StdMutex<connectivity::TestSeams>,
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
                gateway_conflict_port: None,
                serve_port: None,
                serve_origin: None,
                running: None,
                sockets: HashMap::new(),
                next_socket_id: 1,
                native: native::NativeState::default(),
            }),
            rate: StdMutex::new(HashMap::new()),
            abuse: StdMutex::new(AbuseState::default()),
            security_cache: StdMutex::new(None),
            method_cache: StdMutex::new(None),
            push: push::PushState::default(),
            #[cfg(test)]
            key_commands: StdMutex::new(Vec::new()),
            #[cfg(test)]
            seams: StdMutex::new(connectivity::TestSeams::default()),
        }
    }

    /// Discovers the UPnP gateway. Tests seed a fake `seams` entry; production
    /// searches the local network, bounded by `connectivity::SEARCH_TIMEOUT`.
    pub async fn discover_gateway(&self) -> Option<Arc<dyn connectivity::UpnpGateway>> {
        #[cfg(test)]
        {
            let seams = self.seams.lock().unwrap();
            if seams.upnp_active {
                return seams.gateway.clone();
            }
        }
        connectivity::real_discover().await
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

    /// Test seam: the origin the Tailscale method accepts, for a gateway a test
    /// serves over its own certificate.
    #[cfg(test)]
    pub fn set_serve_origin_for_test(&self, origin: &str) {
        self.inner.lock().unwrap().serve_origin = Some(origin.to_string());
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

    // -----------------------------------------------------------------------
    // The active method (FIX35 C1)

    /// The active Remote method, `tailscale` (default) or `native`.
    pub fn active_method(&self, st: &AppState) -> String {
        if let Some(cached) = self.method_cache.lock().unwrap().clone() {
            return cached;
        }
        let settings = st.db.settings().unwrap_or(Value::Null);
        let method = settings
            .get("remote.method")
            .and_then(Value::as_str)
            .filter(|name| matches!(*name, METHOD_TAILSCALE | METHOD_NATIVE))
            .unwrap_or(METHOD_TAILSCALE)
            .to_string();
        *self.method_cache.lock().unwrap() = Some(method.clone());
        method
    }

    /// Records the chosen method so the next read does not touch the database.
    pub fn set_method_cache(&self, method: &str) {
        *self.method_cache.lock().unwrap() = Some(method.to_string());
    }

    /// The accepted origins for the active method. Tailscale is the one serve
    /// origin; Native is `https://<authority>` for every certificate SAN.
    pub fn accepted_origins(&self, st: &AppState) -> Vec<String> {
        if self.active_method(st) == METHOD_NATIVE {
            native::origins(st)
        } else {
            self.serve_origin().into_iter().collect()
        }
    }

    /// The accepted `Host` authorities for the active method (Native only).
    pub fn accepted_authorities(&self, st: &AppState) -> Vec<String> {
        if self.active_method(st) == METHOD_NATIVE {
            native::authorities(st)
        } else {
            Vec::new()
        }
    }

    // -----------------------------------------------------------------------
    // Abuse limits (FIX35 C1 §4)

    /// A token bucket for the unauthenticated routes: 3/s with a burst of 60.
    pub fn unauth_allow(&self, source: &str) -> bool {
        let now = Instant::now();
        let mut abuse = self.abuse.lock().unwrap();
        let bucket = abuse.buckets.entry(source.to_string()).or_insert(Bucket {
            tokens: UNAUTH_RATE_BURST,
            at: now,
        });
        let elapsed = now.saturating_duration_since(bucket.at).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * UNAUTH_RATE_PER_SECOND).min(UNAUTH_RATE_BURST);
        bucket.at = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// When a source is locked out, or every sign-in is paused, this is the
    /// instant it lifts. `None` when sign-in is allowed.
    pub fn login_locked_until(&self, source: &str) -> Option<Instant> {
        let now = Instant::now();
        let abuse = self.abuse.lock().unwrap();
        let paused = abuse.paused_until.filter(|until| *until > now);
        let locked = abuse.locked.get(source).copied().filter(|until| *until > now);
        paused.max(locked)
    }

    /// The status-facing view of the pause: `(paused, until_rfc3339)`.
    pub fn login_pause_state(&self) -> (bool, Option<String>) {
        let now = Instant::now();
        let until = self.abuse.lock().unwrap().paused_until.filter(|until| *until > now);
        match until {
            Some(until) => (true, Some(instant_to_rfc3339(until))),
            None => (false, None),
        }
    }

    /// Records one failed sign-in and returns what it triggered.
    pub fn record_login_failure(&self, source: &str) -> LoginLockout {
        let now = Instant::now();
        let mut abuse = self.abuse.lock().unwrap();
        let window = Duration::from_secs(LOGIN_FAILURE_WINDOW_SECS);
        let per_source = {
            let entry = abuse.per_source.entry(source.to_string()).or_default();
            entry.retain(|at| now.saturating_duration_since(*at) < window);
            entry.push(now);
            entry.len()
        };
        let global_window = Duration::from_secs(LOGIN_GLOBAL_WINDOW_SECS);
        abuse.global.retain(|at| now.saturating_duration_since(*at) < global_window);
        abuse.global.push(now);
        let global_count = abuse.global.len();
        let mut locked = false;
        let mut started = false;
        if per_source >= LOGIN_FAILURES_PER_SOURCE {
            let until = now + Duration::from_secs(LOGIN_LOCKOUT_SECS);
            let already = abuse.locked.get(source).is_some_and(|current| *current > now);
            abuse.locked.insert(source.to_string(), until);
            locked = true;
            started = !already;
        }
        let mut global_paused = false;
        if global_count >= LOGIN_GLOBAL_FAILURES {
            let until = now + Duration::from_secs(LOGIN_GLOBAL_PAUSE_SECS);
            if abuse.paused_until.map(|current| current <= now).unwrap_or(true) {
                global_paused = true;
            }
            abuse.paused_until = Some(until);
        }
        let until = abuse.paused_until.max(abuse.locked.get(source).copied());
        LoginLockout { locked, started, global_paused, until }
    }

    /// Clears a source's failure count after a correct sign-in.
    pub fn clear_login_failures(&self, source: &str) {
        self.abuse.lock().unwrap().per_source.remove(source);
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

    /// The Native listener's IPv4 address, while Native is on.
    #[cfg(test)]
    pub fn native_bound(&self) -> Option<std::net::SocketAddr> {
        self.inner.lock().unwrap().native.bound.first().copied()
    }

    /// Whether any Native listener socket is live.
    pub fn native_listening(&self) -> bool {
        !self.inner.lock().unwrap().native.servers.is_empty()
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
        let (enabled, link, url, port, serve_port, tailscale, connected, error) = {
            let inner = self.inner.lock().unwrap();
            (
                inner.enabled,
                inner.link,
                inner.serve_origin.clone(),
                inner.running.as_ref().map(|running| running.addr.port()).unwrap_or_else(|| remote_port(st)),
                inner.serve_port,
                inner.tailscale.as_str(),
                inner.sockets.len(),
                inner.error.clone(),
            )
        };
        let devices = st.db.remote_devices().unwrap_or_default();
        let live = devices.iter().filter(|device| device["revokedAt"].is_null() && device["signedOutAt"].is_null()).count();
        let method = self.active_method(st);
        json!({
            "enabled": enabled,
            "link": link,
            "url": url,
            "port": port,
            "servePort": serve_port,
            "tailscale": tailscale,
            "hostName": self.host_name,
            "deviceCount": live,
            "connectedCount": connected,
            "keepAwake": false,
            "error": error,
            "method": method,
            "native": native::status_block(st),
        })
    }}

impl Default for RemoteState {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn host_name() -> String {
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

/// Daemon shutdown: remove the port mapping Bitbots added, if any. Nothing else
/// is touched; the certificate, the account and the paired devices stay.
pub async fn shutdown(st: &AppState) {
    connectivity::disable(st).await;
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
        // fix before the owner presses the switch. Native never touches it.
        if st.remote.active_method(st) == METHOD_TAILSCALE {
            refresh_tailscale(st).await;
        }
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
    // A reload must not erase a local gateway conflict just because Tailscale
    // itself is healthy. Re-check the marker so Check again can also recover.
    let conflict_port = remote.inner.lock().unwrap().gateway_conflict_port;
    if let Some(port) = conflict_port {
        if is_bitbots_gateway(port).await { return; }
        remote.inner.lock().unwrap().gateway_conflict_port = None;
    }
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
                // A recovered conflict must not leave the switch stuck on
                // "error" until the next enable: with Remote off it is off
                // again. While Remote is on, the link keeps its own state.
                if !inner.enabled {
                    inner.link = "off";
                }
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

/// A foreign listener may use any protocol; a slow or oversized reply is not
/// allowed to block startup. The fixed marker carries no host or user data.
async fn is_bitbots_gateway(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(500))
        .build() else { return false };
    let Ok(mut response) = client.get(format!("http://127.0.0.1:{port}/api/ping")).send().await else { return false };
    if !response.status().is_success() { return false; }
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if body.len() + chunk.len() > 1024 { return false; }
        body.extend_from_slice(&chunk);
    }
    let Ok(marker) = serde_json::from_slice::<Value>(&body) else { return false };
    marker["ok"] == true && marker["app"] == "bitbots" && marker["role"] == "remote-gateway"
}

/// A failed bind that only rules out this candidate, so the loop should try the
/// next one. `PermissionDenied` matters on Windows, where a port inside a
/// Hyper-V, WSL or Docker excluded range fails with WSAEACCES (10013) rather
/// than `AddrInUse`, and the default port can sit in such a range.
fn bind_error_allows_fallback(kind: std::io::ErrorKind) -> bool {
    matches!(kind, std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied)
}

/// Only an occupied endpoint can belong to another copy of Bitbots, so only an
/// `AddrInUse` failure is worth probing for the marker; a permission failure
/// means nothing is listening there.
fn bind_error_is_occupied(kind: std::io::ErrorKind) -> bool {
    kind == std::io::ErrorKind::AddrInUse
}

async fn bind_gateway(requested: u16, native_port: u16) -> Result<tokio::net::TcpListener, (u16, String)> {
    let mut candidates = vec![requested];
    if requested != 0 {
        candidates.extend((1..=9).filter_map(|offset| requested.checked_add(offset)).filter(|port| *port != native_port));
        candidates.push(0);
    }
    for port in candidates {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) => {
                // Ownership matters at the configured endpoint. Once a foreign
                // listener forced fallback, skip busy candidates to find a free
                // one; a neighbour is not evidence that our endpoint is owned.
                if bind_error_is_occupied(error.kind()) && port == requested && is_bitbots_gateway(port).await {
                    return Err((port, "Another copy of Bitbots is already serving Remote on this computer. Quit the other copy (or restart Bitbots), then try again.".to_string()));
                }
                // A busy or reserved port only rules out this candidate; any
                // other failure is fatal for the whole attempt.
                if !bind_error_allows_fallback(error.kind()) {
                    return Err((port, format!("Bitbots could not listen on Remote port {port}. Check this computer's network permissions, then try again.")));
                }
            }
        }
    }
    Err((requested, "Bitbots could not find a free loopback port for Remote.".to_string()))
}

/// Turns Remote on: probe Tailscale, bind loopback, publish with `serve`.
pub async fn enable(st: &AppState) -> Result<Value, DispatchError> {
    if st.remote.is_enabled() {
        return Ok(st.remote.status_value(st));
    }
    st.remote.set_link("starting", None);
    emit_status(st).await;

    if st.remote.active_method(st) == METHOD_NATIVE {
        let result = native::enable(st).await;
        if let Err(error) = &result {
            st.remote.set_link("error", Some(error.1.message.clone()));
            emit_status(st).await;
        }
        return result;
    }

    let remote = st.remote.clone();
    let cli = remote.cli().await;
    // Bind first: probing before the bind would race another launcher. Only an
    // occupied port is probed, and the probe never follows redirects or proxies.
    let requested_port = remote_port(st);
    let native_port = native::configured_port(st);
    let listener = match bind_gateway(requested_port, native_port).await {
        Ok(listener) => listener,
        Err((port, message)) => {
            {
                let mut inner = remote.inner.lock().unwrap();
                inner.tailscale = tailscale::TailscaleState::PortInUse;
                inner.gateway_conflict_port = Some(port);
            }
            remote.set_link("error", Some(message.clone()));
            emit_status(st).await;
            return Err(derr("conflict", &message, StatusCode::CONFLICT));
        }
    };
    let bound_port = listener.local_addr().map_err(|_| derr("internal", "The remote listener could not start.", StatusCode::INTERNAL_SERVER_ERROR))?.port();
    let probe = tailscale::probe(cli.as_ref(), &tailscale::target_for(bound_port));
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
        inner.gateway_conflict_port = None;
        inner.serve_port = Some(serve_port);
        inner.serve_origin = status.origin(serve_port);
        inner.running = Some(running);
    }
    let _ = st.db.set_setting("remote.port", &json!(addr.port()));
    let _ = st.db.set_setting("remote.enabled", &json!(true));
    let _ = st.db.set_setting("remote.servePort", &json!(serve_port));
    emit_status(st).await;
    Ok(st.remote.status_value(st))
}

/// Turns Remote off: close every device socket, stop the listener and remove
/// only the handler Bitbots added. Paired devices are kept.
pub async fn disable(st: &AppState) -> Result<Value, DispatchError> {
    if st.remote.active_method(st) == METHOD_NATIVE {
        return native::disable(st).await;
    }
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
            // `tailscale serve --https=<port> off` is the one-handler removal.
            // The installed CLI accepts it even when `serve --help` does not
            // list the `off` token, so it is run directly and its answer read;
            // "handler does not exist" means there was nothing to remove.
            let off_args = tailscale::serve_off_args(serve_port);
            match tailscale::run_checked(cli.as_ref(), &off_args) {
                Ok(output) if !output.success && !tailscale::serve_already_absent(&output) => {
                    warning = Some("Tailscale did not remove the Bitbots address. Remove it in the Tailscale admin console if it stays listed.".to_string());
                }
                Ok(_) => {}
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

/// Stops every listener (Tailscale and Native) and closes every device socket.
async fn stop_serving(remote: &Arc<RemoteState>) {
    let (running, native_servers) = {
        let mut inner = remote.inner.lock().unwrap();
        (inner.running.take(), std::mem::take(&mut inner.native.servers))
    };
    if let Some(running) = running {
        stop_server(running).await;
    }
    for server in native_servers {
        stop_server(server).await;
    }
    remote.inner.lock().unwrap().native.bound.clear();
    remote.close_all_sockets();
}

// ---------------------------------------------------------------------------
// remote.*

/// The `remote.*` family. Only the desktop's loopback API reaches it: every
/// `remote.*` method is `never` remote in `tiers.json`.
pub async fn rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, DispatchError> {
    match method {
        "remote.status" => {
            if st.remote.active_method(st) == METHOD_TAILSCALE {
                refresh_tailscale(st).await;
            }
            Ok(st.remote.status_value(st))
        }
        "remote.enable" => enable(st).await,
        "remote.disable" => disable(st).await,
        "remote.method.set" => method_set(st, p).await,
        "remote.native.account.set" => native::account_set_rpc(st, p),
        "remote.native.cert.regenerate" => native::cert_regenerate(st).await,
        "remote.native.port.set" => native::port_set(st, p).await,
        "remote.native.upnp.set" => {
            let enabled = p["enabled"].as_bool().ok_or_else(|| {
                derr("invalid_argument", "enabled must be true or false", StatusCode::BAD_REQUEST)
            })?;
            connectivity::set_consent(st, enabled).await?;
            Ok(native::status_block(st))
        }
        "remote.native.externalIp.set" => connectivity::set_external_ip(st, p).await,
        "remote.native.firewall.add" => Ok(json!({"result": connectivity::add_rule(st).await})),
        "remote.native.firewall.remove" => Ok(json!({"result": connectivity::remove_rule(st).await})),
        "remote.pair.begin" => pair_begin(st).await,
        "remote.pair.cancel" => pair_cancel(st).await,
        "remote.pair.confirm" => pair_confirm(st, p).await,
        "remote.devices.list" => devices_list(st),
        "remote.devices.update" => devices_update(st, p).await,
        "remote.devices.revoke" => devices_revoke(st, p).await,
        "remote.security.get" => Ok(st.remote.security(st).to_value()),
        "remote.security.set" => security_set(st, p),
        "remote.activity.list" => activity_list(st, p),
        "remote.push.get" => push::get_block(st),
        "remote.push.set" => push::set(st, p),
        _ => Err(derr("unsupported", "method is not supported", StatusCode::NOT_FOUND)),
    }
}

/// `remote.method.set`: choose Tailscale or Native. Refused while the other
/// method is on, so the owner turns Remote off first.
async fn method_set(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let method = p["method"].as_str().filter(|name| matches!(*name, METHOD_TAILSCALE | METHOD_NATIVE));
    let Some(method) = method else {
        return Err(derr("invalid_argument", "method must be tailscale or native", StatusCode::BAD_REQUEST));
    };
    let current = st.remote.active_method(st);
    if st.remote.is_enabled() && current != method {
        return Err(derr("conflict", "Turn Remote off before switching method.", StatusCode::CONFLICT));
    }
    st.db
        .set_setting("remote.method", &json!(method))
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    st.remote.set_method_cache(method);
    emit_status(st).await;
    Ok(st.remote.status_value(st))
}

async fn pair_begin(st: &AppState) -> Result<Value, DispatchError> {
    if !st.remote.is_enabled() {
        return Err(derr("conflict", "Turn Remote on before pairing a device.", StatusCode::CONFLICT));
    }
    if st.remote.active_method(st) == METHOD_NATIVE {
        return Err(derr("conflict", "Native Remote signs in with a password.", StatusCode::CONFLICT));
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
    // A revoked device keeps no way to be reached.
    let _ = st.db.remote_push_delete(device_id);
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
        if days.as_u64().is_none_or(|days| days > 3_650) {
            return Err(derr("invalid_argument", "idleExpiryDays must be a number of days from 0 to 3650", StatusCode::BAD_REQUEST));
        }
    }
    if let Some(quiet) = p.get("quietHours") {
        if !quiet.is_object() {
            return Err(derr("invalid_argument", "quietHours must be an object", StatusCode::BAD_REQUEST));
        }
        for key in ["from", "to"] {
            if let Some(value) = quiet.get(key) {
                if value.as_str().and_then(parse_clock).is_none() {
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
