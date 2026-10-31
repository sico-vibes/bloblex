//! Phase 4: the one place a daemon talks to another machine's Remote gateway.
//!
//! A machine link is this daemon acting as a paired device of the other
//! machine. Every call goes through here, so every rule is in one file:
//!
//! * `https://` only, no user, password, query or fragment; the URL is reduced
//!   to its origin;
//! * a preconfigured `rustls` client, never `danger_accept_invalid_certs`:
//!   without a pin, normal web PKI validation (Tailscale); with a pin, a
//!   verifier that compares the SHA-256 of the end-entity certificate with the
//!   pin in constant time and still verifies the handshake signatures, with no
//!   host name check (Native);
//! * no redirects, no proxy, a 32 MiB response cap and a 10-second default
//!   limit;
//! * `Origin` is the link's own origin and the device cookie is the stored
//!   token. The token is read from its user-only file for one request, never
//!   returned, logged or kept.

use crate::remote::pairing::DEVICE_COOKIE;
use crate::AppState;
use reqwest::{redirect::Policy, Method, StatusCode, Url};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use subtle::ConstantTimeEq;

/// The most a response may hold.
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
/// How long one request may take unless the caller says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
/// The folder under the data folder that holds the token files.
pub const TOKEN_FOLDER: &str = "machines";

/// Why a call to another machine did not give an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// The request itself was refused before anything was sent.
    Invalid(String),
    /// The other machine could not be reached, or answered too slowly.
    Unreachable,
    /// Its answer was larger than the cap.
    TooLarge,
    /// The other machine no longer accepts this device.
    Revoked,
    /// It answered with an error envelope.
    Remote { code: String, message: String },
}

impl ClientError {
    pub fn message(&self) -> String {
        match self {
            ClientError::Invalid(message) => message.clone(),
            ClientError::Unreachable => "The other machine can't be reached right now.".to_string(),
            ClientError::TooLarge => "The other machine's answer was too large.".to_string(),
            ClientError::Revoked => "The other machine no longer accepts this one. Pair again to continue.".to_string(),
            ClientError::Remote { message, .. } => message.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// The address

/// The origin of a machine's address, or why it can't be used. Anything but
/// plain `https://host[:port]` (a path is dropped) is refused.
pub fn clean_origin(url: &str) -> Result<String, ClientError> {
    let parsed = Url::parse(url.trim()).map_err(|_| ClientError::Invalid("That address isn't a web address.".to_string()))?;
    if parsed.scheme() != "https" {
        return Err(ClientError::Invalid("Only https:// addresses can be linked.".to_string()));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(ClientError::Invalid("That address has no host name.".to_string()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ClientError::Invalid("The address can't hold a user name or password.".to_string()));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(ClientError::Invalid("The address can't hold a query or a fragment.".to_string()));
    }
    Ok(parsed.origin().ascii_serialization())
}

// ---------------------------------------------------------------------------
// The certificate rules

/// A SHA-256 certificate fingerprint as 32 bytes. Accepts the colon-pair form
/// the gateway shows (`AB:CD:…`) in either case, and plain hex.
pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
    let hex: String = text.chars().filter(|c| *c != ':' && !c.is_whitespace()).collect();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The gateway's own spelling: uppercase hex in colon pairs.
pub fn format_fingerprint(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02X}")).collect::<Vec<_>>().join(":")
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts one certificate, named by its SHA-256, and nothing else. The host
/// name is not checked (a Native certificate is self-signed and covers
/// addresses, not a registered name); the handshake signatures still are.
#[derive(Debug)]
struct PinVerifier {
    pin: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let digest = Sha256::digest(end_entity.as_ref());
        if bool::from(digest.as_slice().ct_eq(&self.pin)) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// Accepts any certificate for one probe call and records its SHA-256, so the
/// owner can compare it with the other machine's screen. It sends nothing
/// secret: the probe carries no credential.
#[derive(Debug)]
struct RecordingVerifier {
    seen: Arc<Mutex<Option<[u8; 32]>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for RecordingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let digest = Sha256::digest(end_entity.as_ref());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&digest);
        *self.seen.lock().unwrap() = Some(bytes);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn web_pki_roots() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    #[cfg(test)]
    {
        // Test seam: a test adds its own certificate as a root, so the web PKI
        // path can run against a loopback server without a real authority.
        let extra = TEST_ROOTS.lock().unwrap().clone();
        let mut store = RootCertStore::empty();
        store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        for der in extra {
            let _ = store.add(CertificateDer::from(der));
        }
        let _ = &ROOTS;
        Arc::new(store)
    }
    #[cfg(not(test))]
    ROOTS
        .get_or_init(|| {
            let mut store = RootCertStore::empty();
            store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            Arc::new(store)
        })
        .clone()
}

/// Certificates a test trusts as roots. Never read outside `cfg(test)`.
#[cfg(test)]
pub static TEST_ROOTS: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());

/// How a call trusts the other machine's certificate.
pub enum Trust {
    /// Normal web PKI (Tailscale's certificates).
    WebPki,
    /// This one certificate (Native), by SHA-256.
    Pin([u8; 32]),
    /// Anyone, once, recording what it saw. Probe only.
    Record(Arc<Mutex<Option<[u8; 32]>>>),
}

fn tls_config(trust: &Trust) -> ClientConfig {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports the default protocol versions");
    match trust {
        Trust::WebPki => builder.with_root_certificates(web_pki_roots()).with_no_client_auth(),
        Trust::Pin(pin) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinVerifier { pin: *pin, provider }))
            .with_no_client_auth(),
        Trust::Record(seen) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(RecordingVerifier { seen: seen.clone(), provider }))
            .with_no_client_auth(),
    }
}

fn build_client(trust: &Trust) -> Result<reqwest::Client, ClientError> {
    reqwest::Client::builder()
        .use_preconfigured_tls(tls_config(trust))
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| ClientError::Unreachable)
}

// ---------------------------------------------------------------------------
// One request

/// What came back: the status, the (capped) body and the cookies it set.
pub struct Reply {
    pub status: StatusCode,
    pub body: Vec<u8>,
    pub set_cookies: Vec<String>,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    /// The value of a cookie this response set, if it set one.
    pub fn cookie(&self, name: &str) -> Option<String> {
        self.set_cookies.iter().find_map(|line| {
            let first = line.split(';').next()?;
            let (key, value) = first.split_once('=')?;
            (key.trim() == name && !value.trim().is_empty()).then(|| value.trim().to_string())
        })
    }
}

/// One request to `origin` + `path`. `cookie` is the full `Cookie` header value.
/// Pass `with_origin: false` for a probe, which sends no `Origin` either.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    trust: &Trust,
    method: Method,
    origin: &str,
    path: &str,
    with_origin: bool,
    cookie: Option<&str>,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<Reply, ClientError> {
    let origin = clean_origin(origin)?;
    let client = build_client(trust)?;
    let mut request = client.request(method, format!("{origin}{path}")).timeout(timeout);
    if with_origin {
        request = request.header("Origin", &origin);
    }
    if let Some(cookie) = cookie {
        request = request.header("Cookie", cookie);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let mut response = request.send().await.map_err(|_| ClientError::Unreachable)?;
    let status = response.status();
    let set_cookies = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
        return Err(ClientError::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ClientError::Unreachable)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ClientError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Reply { status, body: bytes, set_cookies })
}

// ---------------------------------------------------------------------------
// Tokens

/// Whether an id from another machine is safe to use in a file name.
pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn data_dir(st: &AppState) -> PathBuf {
    st.team.data_dir.lock().unwrap().clone().unwrap_or_else(std::env::temp_dir)
}

pub fn token_path(st: &AppState, id: &str) -> Option<PathBuf> {
    safe_id(id).then(|| data_dir(st).join(TOKEN_FOLDER).join(format!("{id}.token")))
}

/// Writes the token file, readable only by the current user. The text never
/// goes anywhere else. The write runs off the runtime's threads.
pub async fn write_token(st: &AppState, id: &str, token: &str) -> Result<(), ClientError> {
    let path = token_path(st, id).ok_or_else(|| ClientError::Invalid("That machine's identity can't be used.".to_string()))?;
    let text = token.to_string();
    tokio::task::spawn_blocking(move || write_token_file(&path, &text))
        .await
        .map_err(|_| ClientError::Invalid("The sign-in for that machine could not be saved.".to_string()))?
        .map_err(|_| ClientError::Invalid("The sign-in for that machine could not be saved.".to_string()))
}

fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, token)?;
    crate::remote::native::apply_key_permissions(path);
    Ok(())
}

/// The stored token, if there is one. It is held only for the one request.
pub async fn read_token(st: &AppState, id: &str) -> Option<String> {
    let path = token_path(st, id)?;
    let text = tokio::task::spawn_blocking(move || std::fs::read_to_string(path).ok()).await.ok()??;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub async fn delete_token(st: &AppState, id: &str) {
    if let Some(path) = token_path(st, id) {
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(path)).await;
    }
}

pub fn device_cookie(token: &str) -> String {
    format!("{DEVICE_COOKIE}={token}")
}

/// How a stored link is trusted: its pin when it has one, else web PKI.
pub fn trust_of(link: &Value) -> Result<Trust, ClientError> {
    match link["fingerprint"].as_str().filter(|text| !text.is_empty()) {
        Some(text) => parse_fingerprint(text)
            .map(Trust::Pin)
            .ok_or_else(|| ClientError::Invalid("That machine's stored certificate fingerprint can't be read.".to_string())),
        None => Ok(Trust::WebPki),
    }
}

// ---------------------------------------------------------------------------
// RPC

/// `client.rpc`: the normal envelope to `POST /api/rpc` on a linked machine.
/// `device_revoked` (and `unauthorized`, which is what a machine that deleted
/// our device answers) sets the link's state to `revoked`.
pub async fn rpc(st: &AppState, machine_id: &str, method: &str, params: Value) -> Result<Value, ClientError> {
    rpc_with_timeout(st, machine_id, method, params, DEFAULT_TIMEOUT).await
}

/// One envelope to `POST /api/rpc`, with the token given directly. Pairing uses
/// it before a link exists.
pub async fn rpc_direct(trust: &Trust, origin: &str, token: &str, method: &str, params: Value, timeout: Duration) -> Result<Value, ClientError> {
    let envelope = json!({"v": 1, "id": uuid::Uuid::new_v4().to_string(), "method": method, "params": params});
    let reply = send(trust, Method::POST, origin, "/api/rpc", true, Some(&device_cookie(token)), Some(&envelope), timeout).await?;
    let body = reply.json();
    if body["ok"] == true {
        return Ok(body["result"].clone());
    }
    let code = body["error"]["code"].as_str().unwrap_or("");
    if matches!(code, "device_revoked" | "unauthorized") {
        return Err(ClientError::Revoked);
    }
    Err(ClientError::Remote {
        code: if code.is_empty() { "provider_unavailable".to_string() } else { code.to_string() },
        message: body["error"]["message"].as_str().unwrap_or("The other machine refused that.").to_string(),
    })
}

pub async fn rpc_with_timeout(st: &AppState, machine_id: &str, method: &str, params: Value, timeout: Duration) -> Result<Value, ClientError> {
    let link = st
        .db
        .machine_link_get(machine_id)
        .ok()
        .flatten()
        .ok_or_else(|| ClientError::Invalid("That machine isn't linked.".to_string()))?;
    let trust = trust_of(&link)?;
    let token = read_token(st, machine_id).await.ok_or(ClientError::Revoked)?;
    let result = rpc_direct(&trust, link["url"].as_str().unwrap_or(""), &token, method, params, timeout).await;
    if matches!(result, Err(ClientError::Revoked)) {
        let _ = st.db.machine_link_set_state(machine_id, "revoked", false);
    }
    result
}

/// This device's own tier on the other machine, from `GET /api/me`. The owner
/// may change it there at any time.
pub async fn device_tier(st: &AppState, machine_id: &str, timeout: Duration) -> Result<String, ClientError> {
    let link = st.db.machine_link_get(machine_id).ok().flatten().ok_or(ClientError::Unreachable)?;
    let trust = trust_of(&link)?;
    let token = read_token(st, machine_id).await.ok_or(ClientError::Revoked)?;
    let reply = send(&trust, Method::GET, link["url"].as_str().unwrap_or(""), "/api/me", true, Some(&device_cookie(&token)), None, timeout).await?;
    reply.json()["device"]["tier"]
        .as_str()
        .filter(|tier| matches!(*tier, "viewer" | "chat" | "operator"))
        .map(str::to_string)
        .ok_or(ClientError::Unreachable)
}
