//! Native Remote (FIX35 C1): the second Remote method.
//!
//! Native needs only Bitbots on the host and a browser on the device. The
//! gateway binds the host's own interfaces on `remote.nativePort` (default
//! 48621) with TLS from a self-signed certificate Bitbots generates, and a
//! device signs in with a username and password plus the owner's approval of
//! each new device on the desktop.
//!
//! This module owns the certificate, the TLS listener, the account and the
//! status block. The routes and the middleware live in [`super::web`]; the
//! lifecycle (enable/disable) is reached through [`super`].
//!
//! Rules that shape every line (see `AGENTS.md`, the Native Remote amendment):
//!
//! * the listener binds `0.0.0.0` and `[::]` **only while Native is on**; it is
//!   closed the moment Native is turned off;
//! * TLS only: a plain-HTTP connection is dropped, never answered;
//! * the certificate key is never logged, and on Windows it is restricted to
//!   the current user with `icacls`;
//! * no third-party service is contacted.

use super::web;
use crate::{derr, AppState, DispatchError};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::http::StatusCode;
use axum::serve::{Listener, ListenerExt};
use chrono::Datelike;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_rustls::TlsAcceptor;

/// `remote.nativePort` default. Native binds this on the host's interfaces.
pub const DEFAULT_NATIVE_PORT: u16 = 48621;
/// The certificate lives this long (owner decision: 825 days, the CA/Browser
/// Forum maximum for a leaf certificate).
pub const CERT_VALID_DAYS: i64 = 825;
/// File names in the daemon's data folder.
pub const CERT_FILE: &str = "remote-native-cert.pem";
pub const KEY_FILE: &str = "remote-native-key.pem";
pub const CERT_META_FILE: &str = "remote-native-cert.json";
/// Settings keys.
pub const ACCOUNT_SETTING: &str = "remote.native.account";
pub const PORT_SETTING: &str = "remote.native.port";
/// The external IP C2 learns; it joins the certificate SANs when present.
pub const EXTERNAL_IP_SETTING: &str = "remote.native.externalIp";

/// The account written only by `remote.native.account.set`.
#[derive(Clone, Debug)]
pub struct Account {
    pub username: String,
    /// An Argon2id PHC string. Never logged, never returned.
    pub hash: String,
}

/// The certificate's identity: its fingerprint and the names it covers.
#[derive(Clone, Debug)]
pub struct CertInfo {
    /// SHA-256 of the certificate DER, uppercase hex in colon pairs.
    pub fingerprint: String,
    /// The SAN names/addresses (without a port).
    pub sans: Vec<String>,
}

/// Native-specific state, held inside `super::Inner`.
#[derive(Default)]
pub struct NativeState {
    pub cert: Option<CertInfo>,
    /// The bound listener addresses, for status and tests.
    pub bound: Vec<SocketAddr>,
    pub servers: Vec<super::RunningServer>,
    pub last_reached_at: Option<String>,
    pub last_reached_from: Option<String>,
}

// ---------------------------------------------------------------------------
// The account

/// The stored account, if any.
pub fn account_of(st: &AppState) -> Option<Account> {
    let settings = st.db.settings().ok()?;
    let value = settings.get(ACCOUNT_SETTING)?;
    let username = value.get("username")?.as_str()?.to_string();
    let hash = value.get("hash")?.as_str()?.to_string();
    Some(Account { username, hash })
}

pub fn account_set(st: &AppState) -> bool {
    account_of(st).is_some()
}

/// A fixed dummy hash so a wrong username costs the same as a wrong password.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        let salt = random_salt();
        Argon2::default()
            .hash_password(b"bitbots-dummy-password", &salt)
            .expect("hashing a fixed password cannot fail")
            .to_string()
    })
}

/// A 16-byte random salt, base64-encoded for the PHC string.
fn random_salt() -> SaltString {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    SaltString::encode_b64(&bytes).expect("a 16-byte salt is always valid")
}

/// Constant-time-ish verification: a wrong username still runs one Argon2id
/// verify, against the dummy hash, so timing does not name the username.
pub fn verify_login(account: &Account, username: &str, password: &str) -> bool {
    if username == account.username {
        if let Ok(parsed) = PasswordHash::new(&account.hash) {
            return Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok();
        }
        return false;
    }
    if let Ok(dummy) = PasswordHash::new(dummy_hash()) {
        let _ = Argon2::default().verify_password(password.as_bytes(), &dummy);
    }
    false
}

/// `remote.native.account.set`. Validates, hashes with Argon2id and stores.
pub fn set_account(st: &AppState, username: &str, password: &str) -> Result<Value, DispatchError> {
    let username = username.trim();
    if username.is_empty() || username.chars().count() > 64 {
        return Err(derr("invalid_argument", "The username must be 1 to 64 characters.", StatusCode::BAD_REQUEST));
    }
    if password.chars().count() < 12 {
        return Err(derr("invalid_argument", "The password must be at least 12 characters.", StatusCode::BAD_REQUEST));
    }
    if password == username {
        return Err(derr("invalid_argument", "The password must not be the username.", StatusCode::BAD_REQUEST));
    }
    let salt = random_salt();
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?
        .to_string();
    st.db
        .set_setting(ACCOUNT_SETTING, &json!({"username": username, "hash": hash}))
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    Ok(json!({"accountSet": true, "username": username}))
}

pub fn account_set_rpc(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    set_account(st, p["username"].as_str().unwrap_or(""), p["password"].as_str().unwrap_or(""))
}

// ---------------------------------------------------------------------------
// Ports and origins

/// `remote.native.port`, defaulting to 48621. Zero means "any free port",
/// which tests use so they never collide.
pub fn configured_port(st: &AppState) -> u16 {
    st.db
        .settings()
        .ok()
        .and_then(|settings| settings.get(PORT_SETTING).and_then(Value::as_u64))
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port == 0 || *port >= 1024)
        .unwrap_or(DEFAULT_NATIVE_PORT)
}

/// The port a browser would reach right now: the bound port while listening,
/// else the configured one.
fn current_port(st: &AppState) -> u16 {
    let bound = st.remote.inner.lock().unwrap().native.bound.first().copied();
    bound.map(|addr| addr.port()).unwrap_or_else(|| configured_port(st))
}

/// `host:port`, with an IPv6 literal in brackets.
fn authority(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn cert_sans(st: &AppState) -> Vec<String> {
    st.remote
        .inner
        .lock()
        .unwrap()
        .native
        .cert
        .as_ref()
        .map(|cert| cert.sans.clone())
        .unwrap_or_default()
}

/// The `Host` authorities the certificate covers, at the current port.
pub fn authorities(st: &AppState) -> Vec<String> {
    let port = current_port(st);
    cert_sans(st).iter().map(|host| authority(host, port)).collect()
}

/// The `https://` origins the certificate covers, at the current port.
pub fn origins(st: &AppState) -> Vec<String> {
    authorities(st).into_iter().map(|authority| format!("https://{authority}")).collect()
}

// ---------------------------------------------------------------------------
// The certificate

fn cert_dir(st: &AppState) -> PathBuf {
    st.team.data_dir.lock().unwrap().clone().unwrap_or_else(std::env::temp_dir)
}

fn is_dns_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// The SAN candidates: every interface address, the external IP when known, the
/// machine's hostname and `localhost`. Loopback is included too, because the
/// listener binds `0.0.0.0` and a browser may reach it as `localhost`.
pub fn sans_candidates(st: &AppState) -> Vec<String> {
    let mut ipv4 = Vec::new();
    let mut ipv6 = Vec::new();
    let mut loopback = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            let ip = interface.addr.ip();
            if ip.is_loopback() {
                loopback.push(ip.to_string());
            } else if matches!(ip, IpAddr::V4(_)) {
                ipv4.push(ip.to_string());
            } else {
                ipv6.push(ip.to_string());
            }
        }
    }
    let external = st
        .db
        .settings()
        .ok()
        .and_then(|settings| settings.get(EXTERNAL_IP_SETTING).and_then(Value::as_str).map(str::to_string));
    let mut hosts = ipv4;
    hosts.extend(ipv6);
    hosts.extend(loopback);
    hosts.push(super::host_name());
    hosts.push("localhost".to_string());
    if let Some(external) = external {
        hosts.push(external);
    }
    let mut seen = std::collections::HashSet::new();
    hosts.retain(|host| seen.insert(host.clone()));
    hosts.retain(|host| host.parse::<IpAddr>().is_ok() || is_dns_name(host));
    hosts
}

/// SHA-256 of the certificate DER, uppercase hex in colon pairs.
pub fn fingerprint_of_der(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest.iter().map(|byte| format!("{byte:02X}")).collect::<Vec<_>>().join(":")
}

fn fingerprint_of_pem(pem: &str) -> Result<String, String> {
    let der = rustls_pemfile::certs(&mut pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("The certificate could not be read: {error}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "The certificate file held no certificate.".to_string())?;
    Ok(fingerprint_of_der(der.as_ref()))
}

/// Generate (or reuse) the certificate. Regenerates when forced, when the files
/// are missing, or when the SANs no longer cover the current candidates (a new
/// address or a new external IP from C2).
pub fn ensure_cert(st: &AppState, force: bool) -> Result<CertInfo, String> {
    let dir = cert_dir(st);
    std::fs::create_dir_all(&dir).map_err(|error| format!("The certificate folder could not be created: {error}"))?;
    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);
    let meta_path = dir.join(CERT_META_FILE);
    let candidates = sans_candidates(st);
    if !force {
        if let (Ok(cert_pem), Ok(_key), Ok(meta_raw)) = (
            std::fs::read_to_string(&cert_path),
            std::fs::read_to_string(&key_path),
            std::fs::read_to_string(&meta_path),
        ) {
            if let Ok(meta) = serde_json::from_str::<Value>(&meta_raw) {
                let stored: Vec<String> = meta["sans"]
                    .as_array()
                    .map(|list| list.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                if candidates.iter().all(|candidate| stored.contains(candidate)) {
                    if let Ok(fingerprint) = fingerprint_of_pem(&cert_pem) {
                        return Ok(CertInfo { fingerprint, sans: stored });
                    }
                }
            }
        }
    }
    let key_pair = rcgen::KeyPair::generate().map_err(|error| format!("The certificate key could not be generated: {error}"))?;
    let mut params = rcgen::CertificateParams::new(candidates.clone())
        .map_err(|error| format!("The certificate names could not be built: {error}"))?;
    let now = chrono::Utc::now();
    let expires = now + chrono::Duration::days(CERT_VALID_DAYS);
    params.not_before = rcgen::date_time_ymd(now.year(), now.month() as u8, now.day() as u8);
    params.not_after = rcgen::date_time_ymd(expires.year(), expires.month() as u8, expires.day() as u8);
    params.distinguished_name.push(rcgen::DnType::CommonName, super::host_name());
    let cert = params
        .self_signed(&key_pair)
        .map_err(|error| format!("The certificate could not be signed: {error}"))?;
    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    let fingerprint = fingerprint_of_der(cert.der().as_ref());
    std::fs::write(&cert_path, &cert_pem).map_err(|error| format!("The certificate could not be saved: {error}"))?;
    std::fs::write(&key_path, &key_pem).map_err(|error| format!("The certificate key could not be saved: {error}"))?;
    let command = apply_key_permissions(&key_path);
    #[cfg(test)]
    st.remote.key_commands.lock().unwrap().push(command.clone());
    #[cfg(not(test))]
    let _ = command;
    let meta = json!({"sans": candidates, "fingerprint": fingerprint});
    std::fs::write(&meta_path, meta.to_string()).map_err(|error| format!("The certificate details could not be saved: {error}"))?;
    Ok(CertInfo { fingerprint, sans: candidates })
}

/// Restrict the key file to the current user. Returns the command that was run
/// (or would be), so a test can record it. No shell is used.
fn apply_key_permissions(path: &Path) -> Vec<String> {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "current user".to_string());
        let args = vec![
            "icacls".to_string(),
            path.display().to_string(),
            "/inheritance:r".to_string(),
            "/grant:r".to_string(),
            format!("{user}:F"),
        ];
        let _ = std::process::Command::new(&args[0]).args(&args[1..]).output();
        args
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        vec!["chmod".to_string(), "0600".to_string(), path.display().to_string()]
    }
}

/// Build the rustls server config from the stored certificate.
fn tls_config(st: &AppState) -> Result<Arc<rustls::ServerConfig>, String> {
    let dir = cert_dir(st);
    let cert_pem = std::fs::read_to_string(dir.join(CERT_FILE)).map_err(|error| format!("The certificate could not be read: {error}"))?;
    let key_pem = std::fs::read_to_string(dir.join(KEY_FILE)).map_err(|error| format!("The certificate key could not be read: {error}"))?;
    let certs = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("The certificate could not be parsed: {error}"))?;
    let key = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|error| format!("The certificate key could not be parsed: {error}"))?
        .ok_or_else(|| "The certificate key file held no key.".to_string())?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("The TLS versions could not be set: {error}"))?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|error| format!("The TLS certificate was refused: {error}"))?;
    Ok(Arc::new(config))
}

// ---------------------------------------------------------------------------
// The TLS listener

/// A `Listener` that completes the TLS handshake before yielding the stream. A
/// plain-HTTP connection fails the handshake and is dropped: HTTP is refused.
struct TlsListener {
    inner: TcpListener,
    acceptor: TlsAcceptor,
}

impl Listener for TlsListener {
    type Io = tokio_rustls::server::TlsStream<tokio::net::TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.inner.accept().await {
                Ok((stream, peer)) => match self.acceptor.accept(stream).await {
                    Ok(tls) => return (tls, peer),
                    // A failed handshake (a plain-HTTP client, a probe) is
                    // refused by closing the socket.
                    Err(_) => continue,
                },
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

fn spawn_tls(listener: TcpListener, config: Arc<rustls::ServerConfig>, state: web::WebState) -> super::RunningServer {
    let addr = listener.local_addr().expect("a bound listener has a local address");
    let notify = Arc::new(Notify::new());
    let shutdown = notify.clone();
    let app = web::router(state);
    let listener = TlsListener {
        inner: listener,
        acceptor: TlsAcceptor::from(config),
    };
    // `tap_io` is what lets `into_make_service_with_connect_info` read the peer
    // address from a custom listener (axum 0.8 `Connected` for `TapIo`).
    let listener = listener.tap_io(|_stream| {});
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move { shutdown.notified().await })
            .await;
    });
    super::RunningServer { addr, notify, handle }
}

// ---------------------------------------------------------------------------
// Lifecycle

/// Turns Native on: ensure the certificate, bind `0.0.0.0` (and `[::]` when the
/// OS allows) and serve the gateway over TLS. The caller has already set the
/// link to `starting`.
pub async fn enable(st: &AppState) -> Result<Value, DispatchError> {
    let remote = st.remote.clone();
    if !account_set(st) {
        return Err(derr("conflict", "Set a username and password first.", StatusCode::CONFLICT));
    }
    let port = configured_port(st);
    let cert = ensure_cert(st, false).map_err(|message| derr("internal", &message, StatusCode::INTERNAL_SERVER_ERROR))?;
    let config = tls_config(st).map_err(|message| derr("internal", &message, StatusCode::INTERNAL_SERVER_ERROR))?;

    let v4 = TcpListener::bind(("0.0.0.0", port)).await.map_err(|_| {
        derr("conflict", &format!("Port {port} is already in use on this computer."), StatusCode::CONFLICT)
    })?;
    let addr = v4
        .local_addr()
        .map_err(|_| derr("internal", "The remote listener could not start.", StatusCode::INTERNAL_SERVER_ERROR))?;
    let state = web::WebState { daemon: st.clone(), remote: remote.clone() };
    let mut servers = vec![spawn_tls(v4, config.clone(), state.clone())];
    let mut bound = vec![addr];
    // IPv6 is best effort: a dual-stack `[::]` may already be taken by the IPv4
    // bind on some systems, in which case only the IPv4 listener runs.
    if let Ok(v6) = TcpListener::bind(("::", port)).await {
        if let Ok(v6_addr) = v6.local_addr() {
            bound.push(v6_addr);
            servers.push(spawn_tls(v6, config.clone(), state));
        }
    }

    {
        let mut inner = remote.inner.lock().unwrap();
        inner.enabled = true;
        inner.link = "online";
        inner.error = None;
        inner.native.cert = Some(cert);
        inner.native.servers = servers;
        inner.native.bound = bound;
    }
    let _ = st.db.set_setting("remote.enabled", &json!(true));
    super::emit_status(st).await;
    Ok(st.remote.status_value(st))
}

/// Turns Native off: close every listener and every device socket. The
/// certificate and the account stay.
pub async fn disable(st: &AppState) -> Result<Value, DispatchError> {
    let remote = st.remote.clone();
    let servers = std::mem::take(&mut remote.inner.lock().unwrap().native.servers);
    for server in servers {
        super::stop_server(server).await;
    }
    remote.close_all_sockets();
    {
        let mut inner = remote.inner.lock().unwrap();
        inner.enabled = false;
        inner.link = "off";
        inner.error = None;
        inner.native.bound.clear();
    }
    let _ = st.db.set_setting("remote.enabled", &json!(false));
    super::emit_status(st).await;
    Ok(st.remote.status_value(st))
}

// ---------------------------------------------------------------------------
// RPCs

/// `remote.native.cert.regenerate`. If Native is serving, it restarts so the
/// new certificate takes effect at once.
pub async fn cert_regenerate(st: &AppState) -> Result<Value, DispatchError> {
    let was_listening = st.remote.native_listening();
    if was_listening {
        disable(st).await?;
    }
    ensure_cert(st, true).map_err(|message| derr("internal", &message, StatusCode::INTERNAL_SERVER_ERROR))?;
    if was_listening {
        enable(st).await?;
    }
    super::emit_status(st).await;
    Ok(status_block(st))
}

/// `remote.native.port.set`, 1024-65535 and only while Remote is off.
pub async fn port_set(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    if st.remote.is_enabled() {
        return Err(derr("conflict", "Turn Remote off before changing the port.", StatusCode::CONFLICT));
    }
    let port = p["port"].as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port >= 1024);
    let Some(port) = port else {
        return Err(derr("invalid_argument", "port must be a number from 1024 to 65535", StatusCode::BAD_REQUEST));
    };
    st.db
        .set_setting(PORT_SETTING, &json!(port))
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    super::emit_status(st).await;
    Ok(status_block(st))
}

// ---------------------------------------------------------------------------
// Status

/// Records that a device reached the host.
pub fn note_reached(st: &AppState, from: &str) {
    let mut inner = st.remote.inner.lock().unwrap();
    inner.native.last_reached_at = Some(super::now_rfc3339());
    inner.native.last_reached_from = Some(from.to_string());
}

/// The `native` block of `remote.status`. C2 adds `upnp`, `firewall`,
/// `externalIp` and `cgnat`; C1 reports only what it owns.
pub fn status_block(st: &AppState) -> Value {
    let (fingerprint, sans, listening, last_reached_at, last_reached_from) = {
        let inner = st.remote.inner.lock().unwrap();
        (
            inner.native.cert.as_ref().map(|cert| cert.fingerprint.clone()),
            inner.native.cert.as_ref().map(|cert| cert.sans.clone()).unwrap_or_default(),
            !inner.native.servers.is_empty(),
            inner.native.last_reached_at.clone(),
            inner.native.last_reached_from.clone(),
        )
    };
    let port = current_port(st);
    let urls: Vec<String> = sans.iter().map(|host| format!("https://{}", authority(host, port))).collect();
    let account = account_of(st);
    let (login_paused, paused_until) = st.remote.login_pause_state();
    json!({
        "port": port,
        "urls": urls,
        "fingerprint": fingerprint,
        "accountSet": account.is_some(),
        "username": account.map(|account| account.username),
        "listening": listening,
        "loginPaused": login_paused,
        "pausedUntil": paused_until,
        "lastReachedAt": last_reached_at,
        "lastReachedFrom": last_reached_from,
    })
}
