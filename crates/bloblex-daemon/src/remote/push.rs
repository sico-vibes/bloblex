//! Phase 5, section 7: Web Push encryption and signing.
//!
//! This module holds the cryptography and the VAPID identity only. Sending a
//! push, the settings gate, the device RPCs and the subscription lifecycle
//! arrive in a later chunk; nothing here opens a socket or reads a clock.
//!
//! * **RFC 8291** (`aes128gcm`): one record, AES-128-GCM, keys derived from an
//!   ECDH P-256 agreement and the subscription's own `auth` secret. RFC 8188
//!   section 2.1 fixes the additional data at zero length (the header carries
//!   the salt, not an authenticated tag), so the whole example body, tag
//!   included, is reproduced byte for byte by
//!   `the_payload_is_encrypted_per_rfc8291`.
//! * **RFC 8292** (VAPID): an ES256 JWT over the push service's origin, so the
//!   service can attribute the request to this install. The test
//!   `vapid_signs_per_rfc8292` signs the RFC's example body exactly and checks
//!   the RFC's published signature.
//!
//! Crates, all pure Rust, no OpenSSL or C bindings: `p256` for the P-256 key
//! pair, the ECDH agreement and deterministic ES256 signatures; `aes-gcm` for
//! the cipher; `hkdf` with the workspace's `sha2` for the derivation. rustls
//! already uses *ring*, but ring has no ECDH or ECDSA key-agreement API we can
//! drive with an RFC vector, and it cannot import an existing private key, so
//! `p256` is the smaller and more testable choice here.
//!
//! The VAPID private key is generated once, written to
//! `<data>/remote-push-key.pem` with the same user-only permissions the Native
//! Remote certificate key uses, and never leaves the daemon: the only public
//! accessor returns the 65-byte uncompressed public point, and `Debug` prints
//! that instead of the struct.

use crate::remote::native::apply_key_permissions;
use crate::AppState;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use p256::SecretKey;
use p256::elliptic_curve::rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Arc;

/// File name in the daemon's data folder.
pub const KEY_FILE: &str = "remote-push-key.pem";
/// RFC 8188 record size. One record holds every payload we send.
pub const RECORD_SIZE: u32 = 4096;
/// The plaintext is padded only by the last-record delimiter.
const DELIMITER_LAST: u8 = 0x02;

/// A P-256 key pair, used both to sign VAPID tokens and to agree the record key
/// with each device.
#[derive(Clone)]
pub struct PushKey {
    secret: SecretKey,
}

impl std::fmt::Debug for PushKey {
    /// Never prints the private scalar: the public point identifies the pair.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PushKey").field("publicKey", &self.public_key_base64()).finish()
    }
}

impl PushKey {
    pub fn generate() -> PushKey {
        PushKey { secret: SecretKey::random(&mut OsRng) }
    }

    /// A key from its 32-byte scalar. Used by the RFC 8291 test vector.
    pub(crate) fn from_scalar_bytes(bytes: &[u8]) -> Result<PushKey, String> {
        SecretKey::from_slice(bytes)
            .map(|secret| PushKey { secret })
            .map_err(|_| "The push key is not a valid P-256 scalar.".to_string())
    }

    pub(crate) fn from_pem(pem: &str) -> Result<PushKey, String> {
        SecretKey::from_pkcs8_pem(pem)
            .map(|secret| PushKey { secret })
            .map_err(|_| "The push key file could not be read.".to_string())
    }

    /// The private half, as a PKCS#8 PEM. Crate-private on purpose: it is only
    /// ever written to the key file.
    fn to_pem(&self) -> Result<String, String> {
        self.secret
            .to_pkcs8_pem(LineEnding::LF)
            .map(|pem| pem.to_string())
            .map_err(|_| "The push key could not be written.".to_string())
    }

    /// The 65-byte uncompressed point (`0x04 || x || y`), the form RFC 8291
    /// puts in the record header and the form a browser's `p256dh` takes.
    pub fn public_key(&self) -> Vec<u8> {
        self.secret.public_key().to_encoded_point(false).as_bytes().to_vec()
    }

    /// The public key in base64url without padding, as the PWA receives it.
    pub fn public_key_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public_key())
    }

    /// RFC 8292: `Authorization: vapid t=<jwt>, k=<public key>`.
    ///
    /// `audience` is the push service origin, `subject` a `mailto:` or `https:`
    /// contact, and `expires` the token's expiry in seconds since the epoch (the
    /// RFC allows at most 24 hours ahead; callers keep it well inside that).
    pub fn vapid_authorization(&self, audience: &str, subject: &str, expires: i64) -> Result<String, String> {
        let token = self.vapid_token(audience, subject, expires)?;
        Ok(format!("vapid t={token}, k={}", self.public_key_base64()))
    }

    /// The JWT itself. The header and body are serialised in the RFC's key
    /// order, so the segments match the RFC 8292 example exactly.
    pub fn vapid_token(&self, audience: &str, subject: &str, expires: i64) -> Result<String, String> {
        // The segments are built in the RFC's own key order, so they match the
        // RFC 8292 example byte for byte (`json!` sorts keys, so it is not used
        // here).
        let header = "{\"typ\":\"JWT\",\"alg\":\"ES256\"}";
        let quote = |value: &str| serde_json::to_string(value).map_err(|_| "The VAPID claim could not be encoded.".to_string());
        let body = format!(
            "{{\"aud\":{},\"exp\":{},\"sub\":{}}}",
            quote(audience)?,
            expires,
            quote(subject)?
        );
        let signing_input = format!("{}.{}", URL_SAFE_NO_PAD.encode(header), URL_SAFE_NO_PAD.encode(body));
        let signing = SigningKey::from(&self.secret);
        let signature: Signature = signing.sign(signing_input.as_bytes());
        Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes())))
    }
}

/// Where the key file lives, or `None` before the daemon knows its data folder.
pub fn key_path(st: &AppState) -> Option<PathBuf> {
    st.team.data_dir.lock().ok()?.clone().map(|dir| dir.join(KEY_FILE))
}

/// Reads the install's VAPID key pair, creating it on first use. Returns the key
/// and whether it was just created. The file is restricted to the current user
/// with `apply_key_permissions` the moment it is written.
pub fn load_or_create(st: &AppState) -> Result<(PushKey, bool), String> {
    let path = key_path(st).ok_or_else(|| "The daemon has no data folder yet.".to_string())?;
    if let Ok(pem) = std::fs::read_to_string(&path) {
        return Ok((PushKey::from_pem(&pem)?, false));
    }
    let key = PushKey::generate();
    let pem = key.to_pem()?;
    std::fs::write(&path, pem).map_err(|error| format!("The push key could not be saved: {error}"))?;
    let _ = apply_key_permissions(&path);
    Ok((key, true))
}

/// The derived record keys and the header that carries them.
pub(crate) struct Record {
    pub key: [u8; 16],
    pub nonce: [u8; 12],
    pub header: Vec<u8>,
}

/// RFC 8291 section 3.4: derive the record key, nonce and header from the
/// agreement between `sender` and the device's public key.
pub(crate) fn build_record(
    ua_public: &[u8],
    auth_secret: &[u8],
    salt: &[u8; 16],
    sender: &PushKey,
) -> Result<Record, String> {
    if ua_public.len() != 65 || ua_public[0] != 0x04 {
        return Err("The device's push key is not an uncompressed P-256 point.".to_string());
    }
    if auth_secret.len() != 16 {
        return Err("The device's push secret is not 16 bytes.".to_string());
    }
    let ua = p256::PublicKey::from_sec1_bytes(ua_public)
        .map_err(|_| "The device's push key is not a point on the curve.".to_string())?;
    let shared = p256::ecdh::diffie_hellman(sender.secret.to_nonzero_scalar(), ua.as_affine());
    let ecdh_secret = shared.raw_secret_bytes();

    let as_public = sender.public_key();
    let mut auth_info = Vec::with_capacity(16 + 65 + 65);
    auth_info.extend_from_slice(b"WebPush: info\0");
    auth_info.extend_from_slice(ua_public);
    auth_info.extend_from_slice(&as_public);
    // HKDF-Expand appends the 0x01 block counter itself, which is the byte the
    // RFC shows after `key_info`; adding it here as well would double it.
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), ecdh_secret.as_slice())
        .expand(&auth_info, &mut ikm)
        .map_err(|_| "The push key material could not be derived.".to_string())?;

    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut key = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut key)
        .map_err(|_| "The push content key could not be derived.".to_string())?;
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| "The push nonce could not be derived.".to_string())?;

    let mut header = Vec::with_capacity(16 + 4 + 1 + 65);
    header.extend_from_slice(salt);
    header.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    header.push(as_public.len() as u8);
    header.extend_from_slice(&as_public);
    Ok(Record { key, nonce, header })
}

/// Encrypts one payload for one device, with a fresh salt and sender key. This
/// is what a send will call; the RFC 8291 test vector uses [`encrypt_with`] so
/// the salt and sender key are the RFC's own.
pub fn encrypt_aes128gcm(ua_public: &[u8], auth_secret: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_with(ua_public, auth_secret, plaintext, &salt, &PushKey::generate())
}

/// RFC 8291 and RFC 8188 with a caller-supplied salt and sender key.
pub(crate) fn encrypt_with(
    ua_public: &[u8],
    auth_secret: &[u8],
    plaintext: &[u8],
    salt: &[u8; 16],
    sender: &PushKey,
) -> Result<Vec<u8>, String> {
    let record = build_record(ua_public, auth_secret, salt, sender)?;
    let mut padded = plaintext.to_vec();
    padded.push(DELIMITER_LAST);
    let cipher = Aes128Gcm::new_from_slice(&record.key)
        .map_err(|_| "The push content key could not be used.".to_string())?;
    // RFC 8188 section 2.1: the additional data for each record is a zero-length
    // octet sequence. The header is not authenticated, it is only carried.
    let body = cipher
        .encrypt(Nonce::from_slice(&record.nonce), Payload { msg: &padded, aad: &[] })
        .map_err(|_| "The push payload could not be encrypted.".to_string())?;
    let mut out = record.header;
    out.extend_from_slice(&body);
    Ok(out)
}

// -- The owner's gate, the device calls and the send. -------------------------

/// Settings key. In `remote.*`, so a backup never carries it.
pub const SETTING_ENABLED: &str = "remote.push.enabled";
/// One push per conversation per minute, at most.
pub const MIN_INTERVAL_SECS: u64 = 60;
/// How long a push service should keep a message we could not deliver.
pub const TTL_SECS: u32 = 60;
/// The VAPID contact. A push service uses it only to reach the sender about
/// abuse; there is no Bitbots mailbox, so this is the project page.
pub const VAPID_SUBJECT: &str = "https://github.com/sico-vibes/bloblex";
/// At most this much of a push service's answer is read.
pub const RESPONSE_CAP: usize = 512;
/// How long the send waits on a push service.
pub const SEND_TIMEOUT_SECS: u64 = 10;

/// A push service answer, or the reason there was none.
#[async_trait::async_trait]
pub trait PushTransport: Send + Sync {
    async fn post(&self, endpoint: &str, authorization: &str, ttl: u32, body: Vec<u8>) -> Result<u16, String>;
}

/// The real transport: no proxy, no redirects, a ten-second limit and a small
/// response cap, as the brief requires.
pub struct HttpTransport {
    client: reqwest::Client,
}

impl HttpTransport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(SEND_TIMEOUT_SECS))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { client })
    }
}

#[async_trait::async_trait]
impl PushTransport for HttpTransport {
    async fn post(&self, endpoint: &str, authorization: &str, ttl: u32, body: Vec<u8>) -> Result<u16, String> {
        let mut response = self
            .client
            .post(endpoint)
            .header("Authorization", authorization)
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("TTL", ttl.to_string())
            .body(body)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let mut read = 0usize;
        while let Ok(Some(chunk)) = response.chunk().await {
            read += chunk.len();
            if read > RESPONSE_CAP {
                break;
            }
        }
        Ok(status)
    }
}

/// The send side's memory: the seam, the last push per conversation and the
/// failures per device. Nothing here is durable.
pub struct PushState {
    transport: std::sync::Mutex<Option<Arc<dyn PushTransport>>>,
    last_sent: std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
    failures: std::sync::Mutex<std::collections::HashMap<String, u32>>,
}

impl Default for PushState {
    fn default() -> Self {
        Self {
            transport: std::sync::Mutex::new(HttpTransport::new().ok().map(|real| Arc::new(real) as Arc<dyn PushTransport>)),
            last_sent: std::sync::Mutex::new(std::collections::HashMap::new()),
            failures: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl PushState {
    /// Test seam: install a transport that records instead of sending.
    pub fn set_transport(&self, transport: Arc<dyn PushTransport>) {
        *self.transport.lock().unwrap() = Some(transport);
    }

    fn transport(&self) -> Option<Arc<dyn PushTransport>> {
        self.transport.lock().ok().and_then(|slot| slot.clone())
    }

    fn failures_of(&self, device_id: &str) -> u32 {
        self.failures.lock().ok().and_then(|map| map.get(device_id).copied()).unwrap_or(0)
    }
}

/// The known push services, and only those. The endpoint arrives from an
/// untrusted device, so it is checked before it is ever used.
pub fn endpoint_allowed(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host_str() {
        Some("fcm.googleapis.com") | Some("web.push.apple.com") => true,
        Some(host) => host.ends_with(".push.services.mozilla.com") || host.ends_with(".notify.windows.com"),
        None => false,
    }
}

/// The origin a VAPID token is scoped to, which is the push service's own.
fn audience_of(endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    Some(format!("{}://{}", url.scheme(), url.host_str()?))
}

pub fn is_enabled(st: &AppState) -> bool {
    st.db
        .settings()
        .ok()
        .and_then(|settings| settings.get(SETTING_ENABLED).and_then(Value::as_bool))
        .unwrap_or(false)
}

fn internal(message: &str) -> crate::DispatchError {
    crate::derr("internal", message, axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

/// `remote.push.get`: what the owner's page shows. The private half is never
/// part of it.
pub fn get_block(st: &AppState) -> Result<Value, crate::DispatchError> {
    let (key, _) = load_or_create(st).map_err(|message| internal(&message))?;
    let devices: Vec<Value> = st
        .db
        .remote_push_list()
        .unwrap_or_default()
        .into_iter()
        .map(|row| {
            json!({
                "deviceId": row["deviceId"],
                "endpoint": row["endpoint"],
                "createdAt": row["createdAt"],
                "failedAt": row["failedAt"],
            })
        })
        .collect();
    Ok(json!({
        "enabled": is_enabled(st),
        "publicKey": key.public_key_base64(),
        "devices": devices,
    }))
}

/// `remote.push.set`. Turning push on is a deliberate choice, because it means
/// the phone maker's push service carries the notifications.
pub fn set(st: &AppState, p: &Value) -> Result<Value, crate::DispatchError> {
    let enabled = p["enabled"].as_bool().ok_or_else(|| {
        crate::derr("invalid_argument", "enabled must be true or false", axum::http::StatusCode::BAD_REQUEST)
    })?;
    if enabled && p["confirm"].as_bool() != Some(true) {
        return Err(crate::derr(
            "invalid_argument",
            "Turning push on sends notifications through your phone maker's push service, so it needs confirm: true.",
            axum::http::StatusCode::BAD_REQUEST,
        ));
    }
    st.db.set_setting(SETTING_ENABLED, &json!(enabled)).map_err(|error| internal(&error.to_string()))?;
    get_block(st)
}

/// `push.key`, `push.subscribe` and `push.unsubscribe`: the calls a paired
/// device makes. The gateway puts the calling device's own id in `deviceId`,
/// so a device can only ever change its own row.
pub async fn device_rpc(st: &AppState, method: &str, p: &Value) -> Result<Value, crate::DispatchError> {
    let device_id = p["deviceId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| crate::derr("invalid_argument", "This method is only for a paired device.", axum::http::StatusCode::BAD_REQUEST))?;
    match method {
        "push.key" => {
            let (key, _) = load_or_create(st).map_err(|message| internal(&message))?;
            Ok(json!({"publicKey": key.public_key_base64(), "enabled": is_enabled(st)}))
        }
        "push.subscribe" => {
            let text = |name: &str| p[name].as_str().filter(|value| !value.is_empty()).map(str::to_string);
            let (Some(endpoint), Some(p256dh), Some(auth)) = (text("endpoint"), text("p256dh"), text("auth")) else {
                return Err(crate::derr("invalid_argument", "endpoint, p256dh and auth are required", axum::http::StatusCode::BAD_REQUEST));
            };
            if !endpoint_allowed(&endpoint) {
                return Err(crate::derr(
                    "invalid_argument",
                    "That is not a known push service. Bitbots sends only to FCM, Mozilla, WNS or Apple.",
                    axum::http::StatusCode::BAD_REQUEST,
                ));
            }
            let key = URL_SAFE_NO_PAD.decode(p256dh.as_bytes()).unwrap_or_default();
            if key.len() != 65 || key[0] != 0x04 {
                return Err(crate::derr("invalid_argument", "p256dh must be the device's uncompressed P-256 public key", axum::http::StatusCode::BAD_REQUEST));
            }
            let secret = URL_SAFE_NO_PAD.decode(auth.as_bytes()).unwrap_or_default();
            if secret.len() != 16 {
                return Err(crate::derr("invalid_argument", "auth must be the device's 16-byte push secret", axum::http::StatusCode::BAD_REQUEST));
            }
            st.db
                .remote_push_upsert(device_id, &endpoint, &p256dh, &auth)
                .map_err(|error| internal(&error.to_string()))?;
            Ok(json!({"subscribed": true}))
        }
        "push.unsubscribe" => {
            st.db.remote_push_delete(device_id).map_err(|error| internal(&error.to_string()))?;
            Ok(json!({"subscribed": false}))
        }
        _ => Err(crate::derr("unsupported", "method is not supported", axum::http::StatusCode::NOT_FOUND)),
    }
}

/// What one notification carries. Exactly these two fields: never message text,
/// a tool name, a path or a project name.
fn notification(kind: &str, bot: &str, session_id: &str) -> Option<Value> {
    let title = match kind {
        "permission.requested" => format!("{bot} needs you"),
        "turn.error" => format!("{bot}'s turn failed"),
        _ => return None,
    };
    Some(json!({"title": title, "sessionId": session_id}))
}

struct Job {
    payload: Value,
    key: PushKey,
}

/// Called from `emit`. Returns at once unless push is on and the event is one
/// the owner should hear about.
pub async fn on_event(st: &AppState, kind: &str, payload: &Value) {
    if !matches!(kind, "permission.requested" | "turn.error") || !is_enabled(st) {
        return;
    }
    let Some(session_id) = payload["sessionId"].as_str().filter(|id| !id.is_empty()) else {
        return;
    };
    if st.remote.security(st).quiet_hours_active(chrono::Local::now()) {
        return;
    }
    if st.db.remote_push_list().map(|rows| rows.is_empty()).unwrap_or(true) {
        return;
    }
    // One Push per conversation per minute: a burst of failures or a second
    // permission card changes nothing on the phone.
    {
        let Ok(mut last) = st.remote.push.last_sent.lock() else { return };
        let now = std::time::Instant::now();
        if let Some(previous) = last.get(session_id) {
            if now.duration_since(*previous).as_secs() < MIN_INTERVAL_SECS {
                return;
            }
        }
        last.insert(session_id.to_string(), now);
    }
    let bot = st.db.session_agent_name(session_id).unwrap_or_else(|| "Bitbots".to_string());
    let Some(payload) = notification(kind, &bot, session_id) else { return };
    let Ok((key, _)) = load_or_create(st) else { return };
    let job = Job { payload, key };
    #[cfg(not(test))]
    {
        let db = st.db.clone();
        let remote = st.remote.clone();
        tokio::spawn(async move { deliver(&db, &remote, job).await });
    }
    #[cfg(test)]
    {
        deliver(&st.db, &st.remote, job).await;
    }
}

/// Encrypts the notification for each subscription and posts it. A 404 or 410
/// means the subscription is gone, so its row goes too; anything else is
/// counted and the row keeps its first failure.
async fn deliver(db: &Arc<bloblex_storage::Storage>, remote: &Arc<super::RemoteState>, job: Job) {
    let Some(transport) = remote.push.transport() else { return };
    let body = job.payload.to_string();
    for row in db.remote_push_list().unwrap_or_default() {
        let (Some(device_id), Some(endpoint)) = (row["deviceId"].as_str(), row["endpoint"].as_str()) else {
            continue;
        };
        if !endpoint_allowed(endpoint) {
            let _ = db.remote_push_delete(device_id);
            continue;
        }
        let Some(audience) = audience_of(endpoint) else { continue };
        let Ok(authorization) = job.key.vapid_authorization(&audience, VAPID_SUBJECT, chrono::Utc::now().timestamp() + 12 * 3600) else {
            continue;
        };
        let key = URL_SAFE_NO_PAD.decode(row["p256dh"].as_str().unwrap_or_default()).unwrap_or_default();
        let secret = URL_SAFE_NO_PAD.decode(row["auth"].as_str().unwrap_or_default()).unwrap_or_default();
        let Ok(body) = encrypt_aes128gcm(&key, &secret, body.as_bytes()) else {
            continue;
        };
        match transport.post(endpoint, &authorization, TTL_SECS, body).await {
            Ok(404) | Ok(410) => {
                let _ = db.remote_push_delete(device_id);
            }
            Ok(status) if (200..300).contains(&status) => {}
            Ok(_) | Err(_) => {
                let _ = db.remote_push_mark_failed(device_id);
                if let Ok(mut failures) = remote.push.failures.lock() {
                    *failures.entry(device_id.to_string()).or_insert(0) += 1;
                }
                tracing::warn!("A push notification could not be delivered.");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    type Sent = StdMutex<Vec<(String, String, u32, Vec<u8>)>>;

    #[derive(Default)]
    struct StubTransport {
        sent: Sent,
        status: u16,
    }

    #[async_trait::async_trait]
    impl PushTransport for StubTransport {
        async fn post(&self, endpoint: &str, authorization: &str, ttl: u32, body: Vec<u8>) -> Result<u16, String> {
            self.sent.lock().unwrap().push((endpoint.to_string(), authorization.to_string(), ttl, body));
            Ok(self.status)
        }
    }

    /// A state with a data folder, a real subscription for one device, push on
    /// and a stub transport. No socket is opened by any test.
    fn push_state() -> (AppState, Arc<StubTransport>) {
        let (st, _events) = crate::phase2a_tests::state();
        let dir = std::env::temp_dir().join(format!("bitbots-push-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        *st.team.data_dir.lock().unwrap() = Some(dir);
        let stub = Arc::new(StubTransport::default());
        st.remote.push.set_transport(stub.clone());
        st.db.set_setting(SETTING_ENABLED, &json!(true)).unwrap();
        let rae = st.db.agent_create(&json!({"name": "Rae", "runtimeId": "rt-test"})).unwrap().0;
        st.db.create_session_for_agent("session-1", "rt-test", "codex", ".", "Chat", rae["id"].as_str()).unwrap();
        let ua = PushKey::generate();
        st.db
            .remote_push_upsert("phone-1", "https://fcm.googleapis.com/p/one", &ua.public_key_base64(), &URL_SAFE_NO_PAD.encode([7u8; 16]))
            .unwrap();
        (st, stub)
    }

    #[tokio::test]
    async fn push_is_off_until_the_owner_turns_it_on() {
        let (st, stub) = push_state();
        st.db.set_setting(SETTING_ENABLED, &json!(false)).unwrap();
        let block = crate::remote::rpc(&st, "remote.push.get", &json!({})).await.unwrap();
        assert_eq!(block["enabled"], json!(false));
        assert_eq!(block["devices"].as_array().unwrap().len(), 1);
        assert_eq!(URL_SAFE_NO_PAD.decode(block["publicKey"].as_str().unwrap()).unwrap().len(), 65);
        // Turning it on needs the owner's confirmation.
        assert_eq!(
            crate::remote::rpc(&st, "remote.push.set", &json!({"enabled": true})).await.unwrap_err().1.code,
            "invalid_argument"
        );
        assert_eq!(
            crate::remote::rpc(&st, "remote.push.set", &json!({"enabled": true, "confirm": true})).await.unwrap()["enabled"],
            json!(true)
        );
        // With push off, the event sends nothing.
        st.db.set_setting(SETTING_ENABLED, &json!(false)).unwrap();
        let event = json!({"sessionId": "session-1", "title": "a permission", "detail": "/secret/path"});
        on_event(&st, "permission.requested", &event).await;
        assert!(stub.sent.lock().unwrap().is_empty(), "no push while the owner has it off");
    }

    #[tokio::test]
    async fn the_settings_calls_reach_the_daemon() {
        let (st, _stub) = push_state();
        let got = crate::dispatch(&st, "remote.push.get", json!({})).await.unwrap();
        assert!(got["publicKey"].is_string() && got.get("enabled").is_some(), "{got}");
        assert_eq!(crate::dispatch(&st, "remote.push.set", json!({"enabled": true})).await.unwrap_err().1.code, "invalid_argument");
        crate::dispatch(&st, "remote.push.set", json!({"enabled": false})).await.unwrap();
    }

    #[tokio::test]
    async fn a_payload_holds_no_content() {
        let (st, stub) = push_state();
        // The event carries everything the phone must not see.
        let event = json!({
            "sessionId": "session-1",
            "title": "Write to src/secret.rs",
            "detail": "/home/basem/private/project",
            "projectName": "Private project",
            "toolName": "write_file",
            "message": "The turn failed because the file was locked",
        });
        on_event(&st, "permission.requested", &event).await;
        let sent = stub.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        let body = &sent[0].3;
        for leak in ["private", "secret.rs", "write_file", "locked", "project"] {
            assert!(!String::from_utf8_lossy(body).contains(leak), "{leak} must not travel");
        }
        assert_eq!(sent[0].2, TTL_SECS);
        assert!(sent[0].1.starts_with("vapid t="));
        assert!(sent[0].0.starts_with("https://fcm.googleapis.com/"));
        // The plaintext itself is exactly the two fields, with the bot's name.
        let job = notification("turn.error", "Rae", "session-1").unwrap();
        assert_eq!(job, json!({"title": "Rae's turn failed", "sessionId": "session-1"}));
        assert_eq!(job.as_object().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn one_push_per_conversation_per_minute() {
        let (st, stub) = push_state();
        let event = json!({"sessionId": "session-1"});
        on_event(&st, "permission.requested", &event).await;
        on_event(&st, "turn.error", &event).await;
        assert_eq!(stub.sent.lock().unwrap().len(), 1, "a burst is one push");
        // Another conversation is its own budget.
        st.db.create_session_for_agent("session-2", "rt-test", "codex", ".", "Other", None).unwrap();
        on_event(&st, "turn.error", &json!({"sessionId": "session-2"})).await;
        assert_eq!(stub.sent.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn quiet_hours_send_nothing() {
        let (st, stub) = push_state();
        // from == to reads as quiet all day, whatever the clock says.
        st.db
            .set_setting("remote.security", &json!({"quietHours": {"enabled": true, "from": "22:00", "to": "22:00"}}))
            .unwrap();
        on_event(&st, "permission.requested", &json!({"sessionId": "session-1"})).await;
        assert!(stub.sent.lock().unwrap().is_empty());
        assert_eq!(st.remote.push.failures_of("phone-1"), 0);
    }

    #[tokio::test]
    async fn a_gone_subscription_is_deleted() {
        for status in [404u16, 410] {
            let (st, _stub) = push_state();
            // The stub's status is set through its own field.
            let stub2 = StubTransport { sent: StdMutex::new(Vec::new()), status };
            st.remote.push.set_transport(Arc::new(stub2));
            assert!(st.db.remote_push_get("phone-1").unwrap().is_some());
            on_event(&st, "permission.requested", &json!({"sessionId": "session-1"})).await;
            assert_eq!(st.db.remote_push_get("phone-1").unwrap(), None, "{status} removes the row");
        }
    }

    #[tokio::test]
    async fn an_unknown_push_host_is_refused() {
        for good in [
            "https://fcm.googleapis.com/p/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://wns2-par02p.notify.windows.com/w/?token=abc",
            "https://web.push.apple.com/QGVsdmlz",
        ] {
            assert!(endpoint_allowed(good), "{good} is a known push service");
        }
        for bad in [
            "http://fcm.googleapis.com/p/abc",
            "https://user:pass@fcm.googleapis.com/p/abc",
            "https://fcm.googleapis.com.evil.test/p/abc",
            "https://evil.test/fcm.googleapis.com",
            "https://push.services.mozilla.com.evil.test/x",
            "https://example.com/push",
            "not a url",
        ] {
            assert!(!endpoint_allowed(bad), "{bad} must be refused");
        }
        let (st, _) = push_state();
        for endpoint in ["https://example.com/push", "http://fcm.googleapis.com/p/x"] {
            let err = device_rpc(&st, "push.subscribe", &json!({"deviceId": "phone-1", "endpoint": endpoint, "p256dh": PushKey::generate().public_key_base64(), "auth": URL_SAFE_NO_PAD.encode([3u8; 16])}))
                .await
                .unwrap_err();
            assert_eq!(err.1.code, "invalid_argument");
        }
    }

    #[tokio::test]
    async fn a_device_only_changes_its_own_subscription() {
        let (st, _) = push_state();
        let ua = PushKey::generate();
        let endpoint = "https://web.push.apple.com/QGVsdmlz";
        device_rpc(&st, "push.subscribe", &json!({"deviceId": "phone-2", "endpoint": endpoint, "p256dh": ua.public_key_base64(), "auth": URL_SAFE_NO_PAD.encode([9u8; 16])}))
            .await
            .unwrap();
        // A second device's unsubscribe cannot touch the first device's row.
        device_rpc(&st, "push.unsubscribe", &json!({"deviceId": "phone-2-other"})).await.unwrap();
        assert!(st.db.remote_push_get("phone-2").unwrap().is_some());
        assert!(st.db.remote_push_get("phone-1").unwrap().is_some(), "an earlier subscription is untouched");
        device_rpc(&st, "push.unsubscribe", &json!({"deviceId": "phone-2"})).await.unwrap();
        assert!(st.db.remote_push_get("phone-2").unwrap().is_none());
        // Without the gateway's own id there is no call at all.
        assert_eq!(device_rpc(&st, "push.unsubscribe", &json!({})).await.unwrap_err().1.code, "invalid_argument");
    }

    #[tokio::test]
    async fn revoking_a_device_drops_its_subscription() {
        let (st, _) = push_state();
        st.db
            .remote_device_create(&json!({"id": "phone-1", "name": "Phone", "kind": "phone", "platform": "android", "tier": "viewer", "pairedAt": "2026-10-31T00:00:00.000Z"}), "hash")
            .unwrap();
        assert!(st.db.remote_push_get("phone-1").unwrap().is_some());
        crate::remote::rpc(&st, "remote.devices.revoke", &json!({"deviceId": "phone-1"})).await.unwrap();
        assert_eq!(st.db.remote_push_get("phone-1").unwrap(), None, "a revoked device keeps no subscription");
    }

    fn bytes(value: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(value).expect("a base64url value")
    }

    /// The RFC 8291 example inputs (section 5 and appendix A).
    const RFC8291_PLAINTEXT: &str = "When I grow up, I want to be a watermelon";
    const RFC8291_UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const RFC8291_AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const RFC8291_AS_PUBLIC: &str = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const RFC8291_SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const RFC8291_AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const RFC8291_CEK: &str = "oIhVW04MRdy2XN9CiKLxTg";
    const RFC8291_NONCE: &str = "4h_95klXJ5E_qnoN";
    const RFC8291_BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    /// The RFC 8292 example values (section 2.4).
    const RFC8292_JWT: &str = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
    const RFC8292_PUBLIC: &str = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";

    /// The RFC 8291 appendix A intermediates, recomputed here so a wrong ECDH
    /// or HKDF input is named by its own line rather than the final body.
    fn assert_rfc_intermediates(sender: &PushKey) {
        let ua = p256::PublicKey::from_sec1_bytes(&bytes(RFC8291_UA_PUBLIC)).unwrap();
        let shared = p256::ecdh::diffie_hellman(sender.secret.to_nonzero_scalar(), ua.as_affine());
        assert_eq!(
            URL_SAFE_NO_PAD.encode(shared.raw_secret_bytes()),
            "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
            "the shared ECDH secret"
        );
        let mut key_info = Vec::new();
        key_info.extend_from_slice(b"WebPush: info\0");
        key_info.extend_from_slice(&bytes(RFC8291_UA_PUBLIC));
        key_info.extend_from_slice(&bytes(RFC8291_AS_PUBLIC));
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&key_info),
            "V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP",
            "the key-combining info"
        );
        // HKDF-Expand adds the 0x01 block counter itself, which is the byte the
        // RFC shows after key_info.
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&bytes(RFC8291_AUTH)), shared.raw_secret_bytes().as_slice()).expand(&key_info, &mut ikm).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(ikm), "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg", "the input keying material");
        let prk = Hkdf::<Sha256>::new(Some(&bytes(RFC8291_SALT)), &ikm);
        let mut cek = [0u8; 16];
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(cek), RFC8291_CEK, "the content encryption key from the appendix");
    }

    #[test]
    fn the_payload_is_encrypted_per_rfc8291() {
        let salt_vec = bytes(RFC8291_SALT);
        let salt: [u8; 16] = salt_vec.as_slice().try_into().expect("a 16-byte salt");
        let sender = PushKey::from_scalar_bytes(&bytes(RFC8291_AS_PRIVATE)).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(sender.public_key()), RFC8291_AS_PUBLIC, "the RFC's own sender key");
        assert_rfc_intermediates(&sender);

        let record = build_record(&bytes(RFC8291_UA_PUBLIC), &bytes(RFC8291_AUTH), &salt, &sender).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(record.key), RFC8291_CEK, "the derived content key");
        assert_eq!(URL_SAFE_NO_PAD.encode(record.nonce), RFC8291_NONCE, "the derived nonce");

        let body = encrypt_with(&bytes(RFC8291_UA_PUBLIC), &bytes(RFC8291_AUTH), RFC8291_PLAINTEXT.as_bytes(), &salt, &sender).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(&body), RFC8291_BODY, "the RFC 8291 example body, byte for byte");        // The same inputs give the same body: no hidden state in the derivation.
        let again = encrypt_with(&bytes(RFC8291_UA_PUBLIC), &bytes(RFC8291_AUTH), RFC8291_PLAINTEXT.as_bytes(), &salt, &sender).unwrap();
        assert_eq!(body, again);
        // A fresh salt and sender key still produce a record the device can read
        // shape-wise: 86-byte header plus an authenticated body.
        let random = encrypt_aes128gcm(&bytes(RFC8291_UA_PUBLIC), &bytes(RFC8291_AUTH), b"{}").unwrap();
        assert!(random.len() > 86 + 16);
        assert_ne!(&random[..16], &body[..16], "the salt is fresh each time");
    }

    #[test]
    fn vapid_signs_per_rfc8292() {
        let rfc = bytes(RFC8292_PUBLIC);
        // The RFC's own token, verified against the RFC's own key. This pins our
        // verifier to a signature we did not produce.
        let segments: Vec<&str> = RFC8292_JWT.split('.').collect();
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0], URL_SAFE_NO_PAD.encode("{\"typ\":\"JWT\",\"alg\":\"ES256\"}"));
        assert_eq!(segments[1], URL_SAFE_NO_PAD.encode("{\"aud\":\"https://push.example.net\",\"exp\":1453523768,\"sub\":\"mailto:push@example.com\"}"));
        let verifying = VerifyingKey::from_sec1_bytes(&rfc).unwrap();
        let signature = Signature::from_slice(&bytes(segments[2])).unwrap();
        verifying.verify(format!("{}.{}", segments[0], segments[1]).as_bytes(), &signature).expect("the RFC 8292 example signature");

        // Our own token: the RFC's example body, signed by a key of ours.
        let key = PushKey::generate();
        let token = key.vapid_token("https://push.example.net", "mailto:push@example.com", 1453523768).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts[0], segments[0], "the header segment matches the RFC");
        assert_eq!(parts[1], segments[1], "the body segment matches the RFC");
        let ours = VerifyingKey::from_sec1_bytes(&key.public_key()).unwrap();
        ours.verify(&token.as_bytes()[..token.rfind('.').unwrap()], &Signature::from_slice(&bytes(parts[2])).unwrap()).expect("our signature verifies");
        assert_eq!(bytes(parts[2]).len(), 64, "ES256 signatures are r || s, not DER");
        assert_eq!(
            key.vapid_authorization("https://push.example.net", "mailto:push@example.com", 1453523768).unwrap(),
            format!("vapid t={token}, k={}", key.public_key_base64())
        );
        // A different audience is a different signature.
        let other = key.vapid_token("https://fcm.googleapis.com", "mailto:push@example.com", 1453523768).unwrap();
        assert_ne!(other.split('.').nth(2), token.split('.').nth(2));
    }

    #[test]
    fn the_private_key_is_never_returned() {
        let (st, _) = crate::phase2a_tests::state();
        let dir = std::env::temp_dir().join(format!("bitbots-push-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        *st.team.data_dir.lock().unwrap() = Some(dir.clone());

        let (key, created) = load_or_create(&st).unwrap();
        assert!(created, "the first call makes the pair");
        let file = dir.join(KEY_FILE);
        let pem = std::fs::read_to_string(&file).unwrap();
        assert!(pem.contains("PRIVATE KEY"), "the file holds the private half");

        // Public surface: the point only, and the same one across restarts.
        let (again, created_again) = load_or_create(&st).unwrap();
        assert!(!created_again, "a second call reuses the file");
        assert_eq!(key.public_key_base64(), again.public_key_base64());
        assert_eq!(key.public_key().len(), 65);
        assert_eq!(key.public_key()[0], 0x04);

        // Neither the formatted key nor the public value carries the scalar.
        let debug = format!("{key:?}");
        let secret = key.secret.to_bytes();
        let mut secret_b64 = URL_SAFE_NO_PAD.encode(secret);
        assert!(!debug.contains(&secret_b64), "Debug shows the public key only");
        secret_b64.clear();
        assert!(debug.contains(&key.public_key_base64()));
        let public_json = json!({"publicKey": key.public_key_base64()});
        assert_eq!(public_json.as_object().unwrap().len(), 1, "nothing else travels to the window");

        // The PEM is written once and not rewritten by a later load.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), pem);
        std::fs::remove_dir_all(&dir).ok();
    }
}
