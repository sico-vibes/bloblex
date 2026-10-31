//! The gateway's HTTP surface (FIX29 WP6b).
//!
//! `docs/remote/PROTOCOL.md` §4.4 defines the routes; §4.1 defines the order of
//! the checks on every `/api/*` request; §4.5 defines the `POST /api/rpc`
//! pipeline; §6 defines the event socket. The gateway binds `127.0.0.1` only,
//! calls `dispatch()` in process, and never sees the daemon capability.

use super::native;
use super::pairing::{DEVICE_COOKIE, PAIR_COOKIE};
use super::policy::{self, RedactOptions, RemoteCall, Tier};
use super::{audit, now_rfc3339, RemoteState, MAX_REQUEST_BYTES};
use crate::{dispatch, AppState};
use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Extension, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// The request body cap. Rejected bodies get `payload_too_large`.
pub const MAX_BODY_BYTES: usize = MAX_REQUEST_BYTES;
/// A backstop so a body cannot be streamed into memory without bound.
const HARD_BODY_LIMIT: usize = 1024 * 1024;
/// How long a socket may wait for its first cursor message.
const FIRST_MESSAGE_TIMEOUT: Duration = Duration::from_secs(30);
/// Replay batch size, matching `events.replay` and the daemon's own socket.
const REPLAY_BATCH: usize = 1000;
/// At most this many files are listed from the PWA folder.
const MAX_MANIFEST_ENTRIES: usize = 4096;

/// The router state: the daemon's state plus the gateway's.
#[derive(Clone)]
pub struct WebState {
    pub daemon: AppState,
    pub remote: Arc<RemoteState>,
}

/// A gateway error on the remote path: the envelope plus the HTTP status.
struct RemoteFailure {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RemoteFailure {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

/// The device behind an authenticated request.
#[derive(Clone, Debug)]
pub struct DeviceAuth {
    pub id: String,
    pub name: String,
    pub tier: Tier,
    /// What kind of device paired: `phone`, `tablet`, `browser`, `computer` or
    /// `machine` (another Bitbots daemon, Phase 4). `handoff.*` reads it.
    pub kind: String,
}

// ---------------------------------------------------------------------------
// The router

pub fn router(state: WebState) -> Router {
    // The self-test (`GET /api/ping`) is merged *after* the origin layer, so it
    // is deliberately open: the owner opens it from a phone's address bar, which
    // carries no `Origin`. It answers `{"ok":true}` and nothing else.
    let open = Router::new().route("/ping", get(ping_get));
    let guarded = Router::new()
        .route("/pair", post(pair_post).get(pair_get))
        .route("/login", post(login_post))
        .route("/me", get(me_get))
        .route("/rpc", post(rpc_post))
        .route("/events", get(events_get))
        .route("/logout", post(logout_post))
        .layer(middleware::from_fn_with_state(state.clone(), require_origin));
    let api = guarded.merge(open);
    Router::new()
        .nest("/api", api)
        .fallback(static_file)
        .layer(axum::extract::DefaultBodyLimit::max(HARD_BODY_LIMIT))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn_with_state(state.clone(), abuse_limit))
        .with_state(state)
}

/// Every `/api/*` request is checked against the active method's origin set
/// (PROTOCOL §4.1 step 1). On Native the `Host` must also name one of the
/// certificate's authorities.
///
/// **Browsers do not send `Origin` on a same-origin `GET`/`HEAD`** (Fetch
/// standard: only CORS requests and non-GET/HEAD same-origin requests carry it).
/// So a safe method may omit `Origin`; when it is present it must match, and a
/// `Sec-Fetch-Site` that names another site is refused. The WebSocket handshake
/// and every state-changing method still require a matching `Origin`, because a
/// browser always sends it there.
async fn require_origin(State(state): State<WebState>, request: Request, next: Next) -> Response {
    let websocket = is_websocket_upgrade(request.headers());
    let safe = matches!(*request.method(), Method::GET | Method::HEAD);
    let origin = request.headers().get(header::ORIGIN).and_then(|value| value.to_str().ok()).map(str::to_owned);
    let fetch_site = request
        .headers()
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase);
    let accepted = state.remote.accepted_origins(&state.daemon);
    // A host name is case-insensitive: `COMPUTERNAME` is upper case and a client
    // (a browser, or another Bitbots daemon) always sends it lower case.
    let origin_ok = origin.as_deref().is_some_and(|origin| accepted.iter().any(|candidate| candidate.eq_ignore_ascii_case(origin)));
    let cross_site = matches!(fetch_site.as_deref(), Some("cross-site") | Some("same-site"));
    let refused = if safe && !websocket {
        // A missing `Origin` is normal here; a present one must still match.
        (origin.is_some() && !origin_ok) || cross_site
    } else {
        // State-changing methods and the WebSocket handshake always carry it.
        !origin_ok || cross_site
    };
    if refused {
        return forbidden_origin();
    }
    if state.remote.active_method(&state.daemon) == super::METHOD_NATIVE {
        let host = request.headers().get(header::HOST).and_then(|value| value.to_str().ok()).map(str::to_owned);
        let authorities = state.remote.accepted_authorities(&state.daemon);
        let host_ok = host.as_deref().is_some_and(|host| authorities.iter().any(|candidate| candidate.eq_ignore_ascii_case(host)));
        if !host_ok {
            return forbidden_origin();
        }
    }
    next.run(request).await
}

/// The events socket is a WebSocket upgrade; browsers always send `Origin` on
/// the handshake, so it keeps the stricter rule.
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn forbidden_origin() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(remote_error("", "forbidden_origin", "This request did not come from this computer's Bitbots Remote address.")),
    )
        .into_response()
}

/// The abuse limits (FIX35 C1 §4): a per-source token bucket on every
/// unauthenticated route (`/api/login`, `/api/pair` and the static files).
async fn abuse_limit(
    State(state): State<WebState>,
    connect: Option<Extension<ConnectInfo<SocketAddr>>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let unauthenticated = path == "/api/login"
        || path == "/api/pair"
        || path == "/api/ping"
        || !path.starts_with("/api/");
    if unauthenticated {
        let key = source_key(request.headers(), connect.as_ref());
        if !state.remote.unauth_allow(&key) {
            return rate_limited(None);
        }
    }
    // Native records where the last device reached it from. A private or
    // loopback peer is only ever reported as "this network".
    if state.remote.active_method(&state.daemon) == super::METHOD_NATIVE {
        native::note_reached(&state.daemon, &reached_from(peer_addr(connect.as_ref())));
    }
    next.run(request).await
}

/// The peer address, when the listener reported one. The Tailscale listener
/// serves over loopback and adds no connect info.
fn peer_addr(connect: Option<&Extension<ConnectInfo<SocketAddr>>>) -> Option<SocketAddr> {
    connect.map(|Extension(info)| info.0)
}

/// The source IP of the connection, or `loopback` when none was reported.
fn source_ip(connect: Option<&Extension<ConnectInfo<SocketAddr>>>) -> String {
    peer_addr(connect).map(|addr| addr.ip().to_string()).unwrap_or_else(|| "loopback".to_string())
}

/// What `native.lastReachedFrom` records: the peer's address only when it is a
/// public address, else the phrase the owner reads ("this network"). The raw
/// address never appears anywhere else.
pub(crate) fn reached_from(peer: Option<SocketAddr>) -> String {
    match peer {
        Some(addr) if super::connectivity::is_public(addr.ip()) => addr.ip().to_string(),
        _ => "this network".to_string(),
    }
}

/// The bucket key for a request: the Tailscale login when present, else the
/// source IP.
fn source_key(headers: &HeaderMap, connect: Option<&Extension<ConnectInfo<SocketAddr>>>) -> String {
    if let Some(login) = headers.get("tailscale-user-login").and_then(|value| value.to_str().ok()) {
        return format!("ts:{login}");
    }
    source_ip(connect)
}

fn rate_limited(until: Option<Instant>) -> Response {
    let message = if until.is_some() {
        "Too many sign-in attempts; try again later."
    } else {
        "Too many requests; try again in a moment."
    };
    json_response(StatusCode::TOO_MANY_REQUESTS, remote_error("", "rate_limited", message))
}

fn login_invalid() -> Response {
    json_response(
        StatusCode::UNAUTHORIZED,
        remote_error("", "login_invalid", "That username or password is not right."),
    )
}

/// Security headers on every response (PROTOCOL §4.4).
async fn security_headers(request: Request, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"),
    );
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    if is_api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

// ---------------------------------------------------------------------------
// Helpers

fn remote_error(id: &str, code: &str, message: &str) -> Value {
    json!({"v": 1, "id": id, "ok": false, "error": {"code": code, "message": message}})
}

fn remote_ok(id: &str, result: Value) -> Value {
    json!({"v": 1, "id": id, "ok": true, "result": result})
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn with_cookie(mut response: Response, cookie: String) -> Response {
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((key, value)) = part.split_once('=') {
            if key.trim() == name {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// `HttpOnly; Secure; SameSite=Strict; Path=/`; `Max-Age` only when the device
/// expires (`0` days means never).
fn device_cookie(token: &str, idle_expiry_days: u32) -> String {
    let mut cookie = format!("{DEVICE_COOKIE}={token}; HttpOnly; Secure; SameSite=Strict; Path=/");
    if idle_expiry_days > 0 {
        cookie.push_str(&format!("; Max-Age={}", u64::from(idle_expiry_days) * 86_400));
    }
    cookie
}

fn cleared_device_cookie() -> String {
    format!("{DEVICE_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0")
}

fn cleared_pair_cookie() -> String {
    format!("{PAIR_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0")
}

fn pair_cookie(pairing_id: &str) -> String {
    format!("{PAIR_COOKIE}={pairing_id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300")
}

fn tier_of(name: &str) -> Option<Tier> {
    match name {
        "viewer" => Some(Tier::Viewer),
        "chat" => Some(Tier::Chat),
        "operator" => Some(Tier::Operator),
        _ => None,
    }
}

/// Box the refusal so `authenticate`'s `Err` variant stays small (clippy
/// `result_large_err`); a `Response` is well over 100 bytes.
fn deny(status: StatusCode, body: Value) -> Box<Response> {
    Box::new(json_response(status, body))
}

/// A refusal from `authenticate`. On `/api/me` (`include_method`) the body also
/// names the active method, so a signed-out device can show the sign-in screen
/// that matches the host (`native` or `tailscale`) without any other host or
/// device data (FIX35 C6).
fn refuse(state: &WebState, include_method: bool, code: &'static str, message: &str) -> Box<Response> {
    let mut body = remote_error("", code, message);
    if include_method {
        body["method"] = json!(state.remote.active_method(&state.daemon));
    }
    deny(StatusCode::UNAUTHORIZED, body)
}

/// The authenticated device, or the reply to send instead. `include_method` adds
/// the active method to a refusal, which only `/api/me` does.
async fn authenticate(state: &WebState, headers: &HeaderMap, include_method: bool) -> Result<DeviceAuth, Box<Response>> {
    let Some(token) = cookie_value(headers, DEVICE_COOKIE) else {
        return Err(refuse(state, include_method, "unauthorized", "Pair this device with the computer first."));
    };
    let hash = super::pairing::hash_token(&token);
    let device = state
        .daemon
        .db
        .remote_device_by_token_hash(&hash)
        .ok()
        .flatten();
    // The lookup finds the row by digest; the digest itself is then confirmed
    // in constant time, so a timing difference cannot narrow a guess.
    let Some((device, stored)) = device else {
        return Err(refuse(state, include_method, "unauthorized", "Pair this device with the computer first."));
    };
    if !super::pairing::token_matches(&stored, &token) {
        return Err(refuse(state, include_method, "unauthorized", "Pair this device with the computer first."));
    }
    let revoked = device["revokedAt"].is_string() || device["signedOutAt"].is_string();
    let security = state.remote.security(&state.daemon);
    let expired = security.idle_expired(device["lastSeenAt"].as_str(), Utc::now());
    if revoked || expired {
        return Err(refuse(state, include_method, "device_revoked", "This device's pairing was removed or expired. Pair again to continue."));
    }
    let id = device["id"].as_str().unwrap_or_default().to_string();
    let name = device["name"].as_str().unwrap_or("A device").to_string();
    let kind = device["kind"].as_str().unwrap_or("browser").to_string();
    // The Tailscale login header is a second check, never a way in on its own.
    if let Some(login) = headers.get("tailscale-user-login").and_then(|value| value.to_str().ok()) {
        let recorded = device["login"].as_str();
        if recorded != Some(login) {
            audit(&state.daemon, Some(&id), "denied", &format!("{name}'s Tailscale account no longer matches its pairing.")).await;
            return Err(refuse(state, include_method, "device_revoked", "This device's pairing was removed or expired. Pair again to continue."));
        }
    }
    let Some(tier) = device["tier"].as_str().and_then(tier_of) else {
        return Err(refuse(state, include_method, "device_revoked", "This device's pairing was removed or expired. Pair again to continue."));
    };
    let _ = state.daemon.db.remote_device_touch(&id, &now_rfc3339());
    Ok(DeviceAuth { id, name, tier, kind })
}

/// A gateway denial carried as a daemon envelope.
fn denial(id: &str, failure: RemoteFailure) -> Response {
    json_response(failure.status, remote_error(id, failure.code, &failure.message))
}

/// §9: attachments are refused in v1, whatever shape they arrive in.
pub(super) fn attachment_rule(method: &str, params: &Value) -> Option<String> {
    if !matches!(method, "session.prompt" | "session.queue.add") {
        return None;
    }
    let attachments = params.get("attachments").and_then(Value::as_array)?;
    if attachments.is_empty() {
        None
    } else {
        Some("attachments are not supported from remote devices yet".to_string())
    }
}

// ---------------------------------------------------------------------------
// Pairing

async fn pair_post(State(state): State<WebState>, headers: HeaderMap, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            remote_error("", "payload_too_large", "That request was too large."),
        );
    }
    let Ok(input) = serde_json::from_slice::<Value>(&body) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            remote_error("", "invalid_argument", "The pairing request could not be read."),
        );
    };
    let Some(code) = input["code"].as_str() else {
        return json_response(
            StatusCode::BAD_REQUEST,
            remote_error("", "pairing_invalid", super::pairing::PAIRING_INVALID_MESSAGE),
        );
    };
    let login = headers.get("tailscale-user-login").and_then(|value| value.to_str().ok()).map(str::to_owned);
    let result = {
        let mut pairing = state.remote.pairing.lock().unwrap();
        pairing.submit(
            code,
            input["name"].as_str().unwrap_or(""),
            input["kind"].as_str().unwrap_or(""),
            input["platform"].as_str().unwrap_or(""),
            login,
            Utc::now(),
        )
    };
    let pairing_id = match result {
        Ok(pairing_id) => pairing_id,
        Err(code) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                remote_error("", &code, super::pairing::PAIRING_INVALID_MESSAGE),
            )
        }
    };
    // The desktop raises the approval dialog from this event.
    announce_pairing_request(&state, &pairing_id).await;
    with_cookie(
        json_response(StatusCode::ACCEPTED, json!({"state": "pending"})),
        pair_cookie(&pairing_id),
    )
}

/// Emits `remote.pairing.requested` for a pending request, from either method.
async fn announce_pairing_request(state: &WebState, pairing_id: &str) {
    let pending = {
        let pairing = state.remote.pairing.lock().unwrap();
        pairing.pending(pairing_id, Utc::now()).unwrap_or(Value::Null)
    };
    let expires_at = pending["expiresAt"].as_str().unwrap_or_default().to_string();
    state
        .daemon
        .emit(
            "remote.pairing.requested",
            json!({
                "pairingId": pairing_id,
                "name": pending["name"],
                "kind": pending["kind"],
                "platform": pending["platform"],
                "login": pending["login"],
                "method": pending["method"],
                "expiresAt": expires_at,
            }),
        )
        .await;
}

/// `POST /api/login` (Native only). A correct username and password either
/// approves a device that already holds a cookie, or starts a pending request
/// the owner approves on the desktop, exactly as a pairing request.
async fn login_post(
    State(state): State<WebState>,
    connect: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if state.remote.active_method(&state.daemon) != super::METHOD_NATIVE {
        return not_found();
    }
    if body.len() > MAX_BODY_BYTES {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            remote_error("", "payload_too_large", "That request was too large."),
        );
    }
    let source = source_ip(connect.as_ref());
    if let Some(until) = state.remote.login_locked_until(&source) {
        return rate_limited(Some(until));
    }
    let Ok(input) = serde_json::from_slice::<Value>(&body) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            remote_error("", "invalid_argument", "The sign-in request could not be read."),
        );
    };
    let Some(account) = native::account_of(&state.daemon) else {
        return login_invalid();
    };
    let username = input["username"].as_str().unwrap_or("");
    let password = input["password"].as_str().unwrap_or("");
    if !native::verify_login(&account, username, password) {
        let lockout = state.remote.record_login_failure(&source);
        // Content-free, and only when a limit starts: on a public port an
        // attacker must not be able to flood the 500-row activity log with a
        // line per guessed password.
        if lockout.started {
            audit(&state.daemon, None, "denied", "Sign-in from this address is paused after repeated failures.").await;
        }
        if lockout.global_paused {
            audit(&state.daemon, None, "denied", "Sign-in is paused after repeated failures.").await;
            state
                .daemon
                .emit("remote.changed", json!({"status": state.remote.status_value(&state.daemon)}))
                .await;
        }
        if lockout.locked {
            return rate_limited(lockout.until);
        }
        return login_invalid();
    }
    state.remote.clear_login_failures(&source);
    native::note_reached(&state.daemon, &reached_from(peer_addr(connect.as_ref())));
    // A device that already holds a valid cookie is approved again.
    if authenticate(&state, &headers, false).await.is_ok() {
        return json_response(StatusCode::OK, json!({"state": "approved"}));
    }
    // A pending request this browser already started is reused.
    if let Some(pairing_id) = cookie_value(&headers, PAIR_COOKIE) {
        let pending = matches!(
            state.remote.pairing.lock().unwrap().poll(&pairing_id, Utc::now()),
            super::pairing::Poll::Pending
        );
        if pending {
            return with_cookie(
                json_response(StatusCode::ACCEPTED, json!({"state": "pending"})),
                pair_cookie(&pairing_id),
            );
        }
    }
    let pairing_id = state.remote.pairing.lock().unwrap().begin_native(
        input["name"].as_str().unwrap_or(""),
        input["kind"].as_str().unwrap_or(""),
        input["platform"].as_str().unwrap_or(""),
        Utc::now(),
    );
    announce_pairing_request(&state, &pairing_id).await;
    with_cookie(
        json_response(StatusCode::ACCEPTED, json!({"state": "pending"})),
        pair_cookie(&pairing_id),
    )
}

/// `GET /api/ping` (FIX35 C2 §4): the self-test. It is unauthenticated and
/// answers only a fixed gateway marker, so the owner can open it from a phone to
/// confirm the address is reachable. It records where the reach came from (a
/// public address, or "this network") and emits `remote.changed`, which is what
/// the desktop shows as "Reached from …".
async fn ping_get(
    State(state): State<WebState>,
    connect: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> Response {
    if state.remote.active_method(&state.daemon) == super::METHOD_NATIVE {
        let from = reached_from(peer_addr(connect.as_ref()));
        native::note_reached(&state.daemon, &from);
        state
            .daemon
            .emit("remote.changed", json!({"status": state.remote.status_value(&state.daemon)}))
            .await;
    }
    json_response(StatusCode::OK, json!({"ok": true, "app": "bitbots", "role": "remote-gateway"}))
}

async fn pair_get(State(state): State<WebState>, headers: HeaderMap) -> Response {
    let Some(pairing_id) = cookie_value(&headers, PAIR_COOKIE) else {
        return json_response(StatusCode::OK, json!({"state": "expired"}));
    };
    let poll = {
        let mut pairing = state.remote.pairing.lock().unwrap();
        pairing.poll(&pairing_id, Utc::now())
    };
    match poll {
        super::pairing::Poll::Pending => json_response(StatusCode::OK, json!({"state": "pending"})),
        super::pairing::Poll::Rejected => with_cookie(
            json_response(StatusCode::OK, json!({"state": "rejected"})),
            cleared_pair_cookie(),
        ),
        super::pairing::Poll::Expired => {
            let outcome = state.remote.pairing.lock().unwrap().take_outcome(&pairing_id);
            if let Some(outcome) = outcome {
                if matches!(outcome, super::pairing::Outcome::Expired | super::pairing::Outcome::Burned) {
                    state
                        .daemon
                        .emit("remote.pairing.completed", json!({"pairingId": pairing_id, "outcome": outcome.as_str()}))
                        .await;
                }
            }
            with_cookie(
                json_response(StatusCode::OK, json!({"state": "expired"})),
                cleared_pair_cookie(),
            )
        }
        super::pairing::Poll::Approved { device, token } => {
            let hash = super::pairing::hash_token(&token);
            if state.daemon.db.remote_device_by_token_hash(&hash).ok().flatten().is_none() {                let device_id = device["id"].as_str().unwrap_or_default().to_string();
                if state.daemon.db.remote_device_create(&device, &hash).is_ok() {
                    audit(&state.daemon, Some(&device_id), "paired", &format!("{} was paired.", device["name"].as_str().unwrap_or("A device"))).await;
                    state
                        .daemon
                        .emit(
                            "remote.pairing.completed",
                            json!({"pairingId": pairing_id, "outcome": "approved", "deviceId": device_id}),
                        )
                        .await;
                }
            }
            let security = state.remote.security(&state.daemon);
            let response = json_response(
                StatusCode::OK,
                json!({"state": "approved", "device": {"id": device["id"], "name": device["name"], "tier": device["tier"]}}),
            );
            let response = with_cookie(response, device_cookie(&token, security.idle_expiry_days));
            with_cookie(response, cleared_pair_cookie())
        }
    }
}

// ---------------------------------------------------------------------------
// /api/me, /api/logout

async fn me_get(State(state): State<WebState>, headers: HeaderMap) -> Response {
    let device = match authenticate(&state, &headers, true).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let security = state.remote.security(&state.daemon);
    json_response(
        StatusCode::OK,
        json!({
            "protocolVersion": 1,
            "device": {"id": device.id, "name": device.name, "tier": device.tier.as_str()},
            "host": {"name": state.remote.host_name},
            "approvalsFromRemote": security.approvals_from_remote,
            "quietHoursActive": security.quiet_hours_active(chrono::Local::now()),
            "method": state.remote.active_method(&state.daemon),
        }),
    )
}

async fn logout_post(State(state): State<WebState>, headers: HeaderMap) -> Response {
    let device = match authenticate(&state, &headers, false).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    let _ = state.daemon.db.remote_device_sign_out(&device.id, &now_rfc3339());
    state.remote.close_socket(&device.id);
    audit(
        &state.daemon,
        Some(&device.id),
        "disconnected",
        &format!("{} signed out.", device.name),
    )
    .await;
    state
        .daemon
        .emit("remote.device.changed", json!({"action": "signed_out", "device": {"id": device.id}}))
        .await;
    with_cookie(
        json_response(StatusCode::OK, json!({"signedOut": true})),
        cleared_device_cookie(),
    )
}

// ---------------------------------------------------------------------------
// /api/rpc

async fn rpc_post(State(state): State<WebState>, headers: HeaderMap, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            remote_error("", "payload_too_large", "That request was too large."),
        );
    }
    let device = match authenticate(&state, &headers, false).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    if !state.remote.rate_allow(&device.id) {
        return denial(
            "",
            RemoteFailure::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many requests from this device; try again in a moment."),
        );
    }
    let Ok(request) = serde_json::from_slice::<bloblex_protocol::RpcRequest>(&body) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            remote_error("", "invalid_argument", "The request could not be read."),
        );
    };
    let id = request.id.clone();
    let method = request.method.clone();
    let params = request.params.clone();
    let security = state.remote.security(&state.daemon);
    let quiet_hours = security.quiet_hours_active(chrono::Local::now());
    let decision = policy::authorize(&RemoteCall {
        tier: device.tier,
        approvals_from_remote: security.approvals_from_remote,
        method: method.clone(),
        params: params.clone(),
        quiet_hours,
    });
    if let policy::Decision::Denied { code, reason } = decision {
        audit(
            &state.daemon,
            Some(&device.id),
            "denied",
            &format!("{} was refused {method}.", device.name),
        )
        .await;
        let status = match code {
            policy::DenialCode::InvalidParams => StatusCode::BAD_REQUEST,
            _ => StatusCode::FORBIDDEN,
        };
        return denial(&id, RemoteFailure::new(status, code.as_str(), reason));
    }
    // Moving a conversation is for another Bitbots machine only; a phone or browser at
    // `operator` is refused whatever the policy table says.
    if method.starts_with("handoff.") && device.kind != "machine" {
        audit(&state.daemon, Some(&device.id), "denied", &format!("{} was refused {method}.", device.name)).await;
        return denial(&id, RemoteFailure::new(StatusCode::FORBIDDEN, "forbidden_remote", "Only a linked Bitbots machine can move a conversation."));
    }
    if let Some(reason) = attachment_rule(&method, &params) {
        audit(
            &state.daemon,
            Some(&device.id),
            "denied",
            &format!("{} was refused {method}.", device.name),
        )
        .await;
        return denial(
            &id,
            RemoteFailure::new(StatusCode::BAD_REQUEST, "invalid_params", reason),
        );
    }
    match dispatch(&state.daemon, &method, params).await {
        Ok(result) => {
            if let Some(kind) = audit_kind(&method) {
                audit(
                    &state.daemon,
                    Some(&device.id),
                    kind,
                    &format!("{} sent {method} from the remote app.", device.name),
                )
                .await;
            }
            let redacted = policy::redact_result(&method, &result, &RedactOptions::default());
            json_response(StatusCode::OK, remote_ok(&id, redacted))
        }
        Err((status, error)) => json_response(status, remote_error(&id, &error.code, &error.message)),
    }
}

/// The audit kind for a method that changes something, if any.
fn audit_kind(method: &str) -> Option<&'static str> {
    match policy::rule_for(method).map(|rule| rule.class) {
        Some(policy::MethodClass::Chat) => Some("prompt"),
        Some(policy::MethodClass::Approve) => Some("approval"),
        Some(policy::MethodClass::Handoff) => Some("handoff"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// /api/events

async fn events_get(State(state): State<WebState>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let device = match authenticate(&state, &headers, false).await {
        Ok(device) => device,
        Err(response) => return *response,
    };
    // One live socket per device: registering replaces (and drops) the old
    // sender, which is how the previous socket is closed.
    let (kick, kick_rx) = mpsc::channel::<()>(1);
    let (replaced, socket_id) = state.remote.register_socket(&device.id, kick);
    let state_for_socket = state.clone();
    if replaced {
        audit(
            &state.daemon,
            Some(&device.id),
            "connected",
            &format!("{} opened a new connection; the older one was closed.", device.name),
        )
        .await;
    } else {
        audit(
            &state.daemon,
            Some(&device.id),
            "connected",
            &format!("{} connected.", device.name),
        )
        .await;
    }
    upgrade.on_upgrade(move |socket| events_loop(socket, state_for_socket, device, kick_rx, socket_id))
}

async fn events_loop(mut socket: WebSocket, state: WebState, device: DeviceAuth, mut kick: mpsc::Receiver<()>, socket_id: u64) {
    // The live subscription is registered before replay, so a client may see a
    // duplicate sequence and must discard it (PROTOCOL §6).
    let mut live = state.daemon.events.subscribe();
    let Ok(Some(Ok(Message::Text(first)))) = tokio::time::timeout(FIRST_MESSAGE_TIMEOUT, socket.next()).await else {
        return;
    };
    let Ok(cursor) = serde_json::from_str::<Value>(&first) else {
        return;
    };
    let mut after = cursor["afterSequence"].as_u64().unwrap_or(0);

    loop {
        let batch = state.daemon.db.replay_events(after, REPLAY_BATCH).unwrap_or_default();
        let count = batch.len();
        for event in batch {
            if event["replayAvailable"] == false {
                let _ = send_json(&mut socket, replay_gap(&event)).await;
                return;
            }
            let sequence = event["sequence"].as_u64().unwrap_or(0);
            if sequence <= after {
                continue;
            }
            if let Some(redacted) = policy::redact_event(&event) {
                if !send_json(&mut socket, redacted).await {
                    return;
                }
            }
            after = sequence;
        }
        if count < REPLAY_BATCH {
            break;
        }
    }
    let complete = json!({
        "v": 1,
        "eventId": format!("replay-complete-{after}"),
        "sequence": after,
        "timestamp": now_rfc3339(),
        "type": "events.replay.complete",
        "payload": {"throughSequence": after},
    });
    if !send_json(&mut socket, complete).await {
        return;
    }
    loop {
        tokio::select! {
            item = live.recv() => match item {
                Ok(event) if event.sequence > after => {
                    let value = serde_json::to_value(&event).unwrap_or(Value::Null);
                    if let Some(redacted) = policy::redact_event(&value) {
                        if !send_json(&mut socket, redacted).await {
                            break;
                        }
                    }
                    after = event.sequence;
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = send_json(&mut socket, replay_gap(&json!({"replayAvailable": false}))).await;
                    break;
                }
                Err(_) => break,
            },
            // A second socket for the same device, or a revoke, closes this one.
            _ = kick.recv() => break,
            message = socket.next() => match message {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                // Anything else from the device is ignored (§6).
                _ => {}
            },
        }
    }
    state.remote.forget_socket(&device.id, socket_id);
}

fn replay_gap(payload: &Value) -> Value {
    json!({
        "v": 1,
        "eventId": "gap",
        "sequence": 0,
        "timestamp": now_rfc3339(),
        "type": "replay.gap",
        "payload": payload,
    })
}

async fn send_json(socket: &mut WebSocket, value: Value) -> bool {
    socket.send(Message::Text(value.to_string().into())).await.is_ok()
}

// ---------------------------------------------------------------------------
// Static files

/// The PWA files, listed once at startup. Anything not in the manifest is 404,
/// which is also what rules out path traversal: a decoded `..` is simply not a
/// key.
pub struct StaticFiles {
    manifest: HashMap<String, PathBuf>,
}

impl Default for StaticFiles {
    fn default() -> Self {
        Self::empty()
    }
}

impl StaticFiles {
    pub fn empty() -> Self {
        Self {
            manifest: HashMap::new(),
        }
    }

    /// Build the manifest from `BITBOTS_REMOTE_WEB_DIR`. An absent or empty
    /// value leaves the gateway with the built-in "not installed" page.
    pub fn from_env() -> Self {
        match std::env::var_os("BITBOTS_REMOTE_WEB_DIR") {
            Some(dir) if !dir.is_empty() => Self::load(PathBuf::from(dir)),
            _ => Self::empty(),
        }
    }

    pub fn load(root: PathBuf) -> Self {
        let mut manifest = HashMap::new();
        collect_files(&root, &root, &mut manifest, 0);
        if manifest.is_empty() {
            // An absent or empty folder. The router serves the built-in page.
            return Self { manifest };
        }
        // The packaged remote build's entry page is `remote.html`; `index.html`
        // keeps an older layout working. Either way `/` maps to the entry file
        // while every listed file stays servable at its own path.
        let entry = if manifest.contains_key("/remote.html") {
            Some("/remote.html")
        } else if manifest.contains_key("/index.html") {
            Some("/index.html")
        } else {
            None
        };
        match entry {
            Some(key) => {
                let path = manifest[key].clone();
                manifest.insert("/".to_string(), path);
            }
            None => {
                // Files but no entry page: a broken install. Warn once at load
                // (the folder path only) and fall back to the built-in page.
                tracing::warn!(
                    "remote web folder has no remote.html or index.html; serving the built-in page: {}",
                    root.display()
                );
            }
        }
        Self { manifest }
    }

    /// True only when no file was found beside the daemon. A folder that has
    /// files but no entry page is not empty; the router handles it at `/`.
    pub fn is_empty(&self) -> bool {
        self.manifest.is_empty()
    }

    pub fn get(&self, path: &str) -> Option<&PathBuf> {
        // A decoded traversal is never a key, but refuse the obvious shapes
        // before the lookup so the intent is explicit.
        if path.contains("..") || path.contains('\\') || path.contains('%') {
            return None;
        }
        self.manifest.get(path)
    }
}

fn collect_files(root: &Path, dir: &Path, manifest: &mut HashMap<String, PathBuf>, depth: usize) {
    if depth > 8 || manifest.len() >= MAX_MANIFEST_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, manifest, depth + 1);
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else { continue };
        let key = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
        manifest.insert(key, path);
        if manifest.len() >= MAX_MANIFEST_ENTRIES {
            return;
        }
    }
}

/// The page served when no PWA is installed beside the daemon.
const NOT_INSTALLED_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Bitbots Remote</title></head><body style=\"font-family:system-ui,sans-serif;margin:2rem;line-height:1.5\"><h1>Bitbots Remote is not installed</h1><p>This computer is serving Remote, but its web app files are not on disk yet. Install the packaged build, then reload this page.</p></body></html>";

fn not_installed_response() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        NOT_INSTALLED_PAGE,
    )
        .into_response()
}

async fn static_file(State(state): State<WebState>, uri: Uri) -> Response {
    let path = uri.path();
    if state.remote.web.is_empty() {
        if path == "/" || path == "/index.html" {
            return not_installed_response();
        }
        return not_found();
    }
    let Some(file) = state.remote.web.get(path) else {
        // A folder with files but no entry page has no `/` key; the built-in
        // page stands in at `/`, anything else is a genuine 404.
        if path == "/" {
            return not_installed_response();
        }
        return not_found();
    };
    match std::fs::read(file) {
        Ok(bytes) => {
            // The type follows the file that was resolved, not the request path:
            // `/` maps to `remote.html`, whose URL has no extension, and serving
            // that as `application/octet-stream` with `nosniff` makes the
            // browser download the page instead of opening it.
            let content_type = content_type_of(&file.to_string_lossy());
            (StatusCode::OK, [(header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(_) => not_found(),
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

fn content_type_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
