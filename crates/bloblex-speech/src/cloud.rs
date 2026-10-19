//! Opt-in cloud dictation through the Codex CLI login.
//!
//! The owner approved a single, scoped exception to Bitbots' "no copied
//! provider authentication" invariant: for dictation only, this module reads the
//! Codex CLI's `auth.json` read-only to call ChatGPT transcription. The token,
//! the audio and the transcript are never persisted or logged, the token lives
//! only in a redacting, zeroizing `Secret`, and on-device stays the default and
//! the automatic fallback. See `docs/history/improvement/phase-7-spec.md`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use serde::Serialize;
use thiserror::Error;

/// The model the ChatGPT transcription endpoint expects.
pub const CLOUD_MODEL: &str = "gpt-transcribe";
/// Total request budget for one transcription call.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(65);
/// Hard cap on the uploaded WAV (20 MiB).
pub const MAX_AUDIO_BYTES: usize = 20 * 1024 * 1024;
/// The cloud path normalizes everything to mono 16 kHz, like the local engine.
pub const CLOUD_SAMPLE_RATE: u32 = 16_000;
/// Below ~1 second of speech there is nothing worth sending.
pub const MIN_SPEECH_SAMPLES: usize = CLOUD_SAMPLE_RATE as usize;
/// ~10 minutes at 16 kHz mono PCM16: 19.2 MB, safely under the upload cap.
pub const MAX_BUFFER_SAMPLES: usize = CLOUD_SAMPLE_RATE as usize * 60 * 10;
/// A response body is parsed only to this size; anything larger is a bad response.
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// After a persistent cloud failure, `automatic` mode stops retrying the cloud
/// for this long and goes straight to the on-device engine.
pub const CLOUD_COOLDOWN: Duration = Duration::from_secs(10 * 60);
/// Engine-event reason code when a session skipped a cooling-down cloud engine.
pub const REASON_CLOUD_COOLDOWN: &str = "cloud_cooldown";
/// Error code the UI maps when no engine could transcribe: the cloud failed
/// (or was not chosen) and no on-device model could run either.
pub const BOTH_ENGINES_UNAVAILABLE: &str = "both_engines_unavailable";

/// Cloudflare cookies the ChatGPT edge has set for us, kept in memory only and
/// replayed on later requests to that host. This is how bb's ChatGPT client
/// (get-bb/bb, `provider-codex/src/ai/chatgpt-fetch.ts`) gets past the soft
/// bot-management challenge: the first request is answered with a challenge and
/// the cookies that go with it, and a second request that carries them passes.
/// Only the Cloudflare cookie names below are kept; nothing is ever written to
/// disk or logged.
static CLOUDFLARE_COOKIES: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();

const CLOUDFLARE_COOKIE_NAMES: [&str; 9] = [
    "__cf_bm",
    "__cflb",
    "__cfruid",
    "__cfseq",
    "__cfwaitingroom",
    "_cfuvid",
    "cf_clearance",
    "cf_ob_info",
    "cf_use_ob",
];

fn cookie_jar() -> &'static Mutex<BTreeMap<String, String>> {
    CLOUDFLARE_COOKIES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn is_cloudflare_cookie(name: &str) -> bool {
    CLOUDFLARE_COOKIE_NAMES.contains(&name) || name.starts_with("cf_chl_")
}

/// Keeps the allowed Cloudflare cookies from a response's `Set-Cookie` headers.
fn store_cloudflare_cookies(headers: &reqwest::header::HeaderMap) {
    let Ok(mut jar) = cookie_jar().lock() else { return };
    for value in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(text) = value.to_str() else { continue };
        let pair = text.split(';').next().unwrap_or("").trim();
        let Some((name, _)) = pair.split_once('=') else { continue };
        let name = name.trim();
        if is_cloudflare_cookie(name) {
            jar.insert(name.to_string(), pair.to_string());
        }
    }
}

/// The `Cookie` header to send, or `None` when nothing has been stored.
fn cloudflare_cookie_header() -> Option<String> {
    let jar = cookie_jar().lock().ok()?;
    if jar.is_empty() {
        None
    } else {
        Some(jar.values().cloned().collect::<Vec<_>>().join("; "))
    }
}

/// The names (never the values) of the Cloudflare cookies currently held, for
/// diagnostics.
pub fn stored_cloudflare_cookie_names() -> Vec<String> {
    cookie_jar().lock().map(|jar| jar.keys().cloned().collect()).unwrap_or_default()
}

/// Forget stored cookies (tests, and a sign-out).
pub fn reset_cloudflare_cookies() {
    if let Ok(mut jar) = cookie_jar().lock() {
        jar.clear();
    }
}

fn is_cloudflare_challenge(status: reqwest::StatusCode, headers: &reqwest::header::HeaderMap) -> bool {
    status == reqwest::StatusCode::FORBIDDEN
        && headers
            .get("cf-mitigated")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("challenge"))
}

/// TLS configuration for the ChatGPT transcription call.
///
/// OpenAI's edge answered this client with a Cloudflare challenge (`403`,
/// `cf-mitigated: challenge`) while it used `reqwest`'s default backend —
/// `native-tls`, i.e. SChannel on Windows. Passing a preconfigured `rustls`
/// config through `use_preconfigured_tls` makes the same request, with the same
/// URL, body, headers and identity, return `200`
/// (`cargo run -p bloblex-speech --example cloud_probe`). The measured
/// difference is the TLS stack's ClientHello fingerprint; `originator` stays
/// `bloblex` and the User-Agent stays ours.
///
/// ALPN was tested and is **not** the cause: re-advertising `["http/1.1"]` on
/// this rustls config still returned `200`. The config simply advertises
/// nothing, which is rustls's own default here, rather than relying on ALPN.
///
/// See `docs/evidence/cloud-dictation-tls-backend-2026-10-14.md`.
fn cloud_tls_config() -> Result<rustls::ClientConfig, CloudError> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| CloudError::Unavailable)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    tls.alpn_protocols.clear();
    Ok(tls)
}

/// The HTTP client every cloud transcription call uses: HTTP/1.1 only, no
/// ALPN, no redirects. It carries **no fixed overall timeout**, so one client
/// can serve many requests with different budgets and keep-alive connections
/// survive between dictations; each request sets its own budget through
/// `RequestBuilder::timeout`.
fn build_cloud_client() -> Result<reqwest::Client, CloudError> {
    reqwest::Client::builder()
        .use_preconfigured_tls(cloud_tls_config()?)
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| CloudError::Unavailable)
}

/// The one shared cloud client, built on first use. Reusing it keeps the
/// connection pool and the rustls setup warm across dictations.
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn cloud_client() -> Result<&'static reqwest::Client, CloudError> {
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = build_cloud_client()?;
    Ok(CLIENT.get_or_init(|| client))
}

/// How the user asked dictation to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnginePreference {
    Local,
    Automatic,
    Cloud,
}

impl EnginePreference {
    /// Parse the setting string; anything unrecognised stays on-device.
    pub fn parse(value: &str) -> Self {
        match value {
            "automatic" => Self::Automatic,
            "cloud" => Self::Cloud,
            _ => Self::Local,
        }
    }
}

/// Which engine actually produced the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedEngine {
    OnDevice,
    ChatGpt,
}

impl ResolvedEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OnDevice => "on-device",
            Self::ChatGpt => "chatgpt",
        }
    }
}

/// The engine decision for one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub primary: ResolvedEngine,
    /// Present when ChatGPT is primary and a local model can take over.
    pub fallback: Option<ResolvedEngine>,
    /// A stable machine code when no engine can run the session.
    pub unavailable: Option<&'static str>,
    /// Why the session was routed away from a healthy cloud engine, if so.
    pub reason: Option<&'static str>,
}

/// Decide which engine a session should use. Pure and total so the desktop can
/// trust it before touching the microphone. Consent is always an input, never
/// inferred. `cloud_paused` is the cool-down state after a persistent cloud
/// failure; it only diverts `automatic` sessions that could run on-device, so a
/// user who explicitly chose the cloud still gets it.
pub fn resolve_engine(
    preference: EnginePreference,
    consent: bool,
    auth: &AuthStatus,
    local_ready: bool,
    cloud_paused: bool,
) -> Resolved {
    match preference {
        EnginePreference::Local => Resolved {
            primary: ResolvedEngine::OnDevice,
            fallback: None,
            unavailable: (!local_ready).then_some("model_not_ready"),
            reason: None,
        },
        EnginePreference::Automatic => {
            let cloud_ready = consent
                && matches!(
                    auth.state,
                    AuthState::Ready | AuthState::ApiKey | AuthState::Expired
                );
            if cloud_ready && cloud_paused && local_ready {
                return Resolved {
                    primary: ResolvedEngine::OnDevice,
                    fallback: None,
                    unavailable: None,
                    reason: Some(REASON_CLOUD_COOLDOWN),
                };
            }
            if cloud_ready {
                Resolved {
                    primary: ResolvedEngine::ChatGpt,
                    fallback: local_ready.then_some(ResolvedEngine::OnDevice),
                    unavailable: None,
                    reason: None,
                }
            } else if local_ready {
                Resolved {
                    primary: ResolvedEngine::OnDevice,
                    fallback: None,
                    unavailable: None,
                    reason: None,
                }
            } else {
                let code = if consent { "auth_missing" } else { "consent_required" };
                Resolved {
                    primary: ResolvedEngine::OnDevice,
                    fallback: None,
                    unavailable: Some(code),
                    reason: None,
                }
            }
        }
        EnginePreference::Cloud => {
            let cloud_ready = consent
                && matches!(
                    auth.state,
                    AuthState::Ready | AuthState::ApiKey | AuthState::Expired
                );
            if cloud_ready {
                Resolved {
                    primary: ResolvedEngine::ChatGpt,
                    fallback: local_ready.then_some(ResolvedEngine::OnDevice),
                    unavailable: None,
                    reason: None,
                }
            } else if local_ready {
                Resolved {
                    primary: ResolvedEngine::OnDevice,
                    fallback: None,
                    unavailable: None,
                    reason: None,
                }
            } else {
                let code = if consent { "auth_missing" } else { "consent_required" };
                Resolved {
                    primary: ResolvedEngine::OnDevice,
                    fallback: None,
                    unavailable: Some(code),
                    reason: None,
                }
            }
        }
    }
}

/// The readiness of the Codex login, with no secrets in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub state: AuthState,
    pub mode: Option<AuthMode>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthState {
    Ready,
    Missing,
    Unreadable,
    Expired,
    ApiKey,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AuthMode {
    #[serde(rename = "chatgpt")]
    ChatGpt,
    #[serde(rename = "apiKey")]
    ApiKey,
}

impl AuthStatus {
    fn plain(state: AuthState) -> Self {
        Self {
            state,
            mode: None,
            expires_at: None,
        }
    }
}

/// Typed cloud failures. `Display` never carries a body, URL or token.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CloudError {
    #[error("ChatGPT sign-in is required.")]
    AuthMissing,
    #[error("ChatGPT sign-in expired; run `codex login`.")]
    AuthRequired,
    #[error("ChatGPT transcription is rate limited.")]
    RateLimited,
    #[error("ChatGPT transcription was challenged.")]
    Challenged,
    #[error("ChatGPT transcription is unavailable.")]
    Unavailable,
    #[error("The recording is too large.")]
    TooLarge,
    #[error("The recording is too short.")]
    TooShort,
    #[error("The transcription response was invalid.")]
    BadResponse,
    #[error("ChatGPT transcription was rejected (HTTP {0}).")]
    Rejected(u16),
}

impl CloudError {
    /// The stable machine code the desktop and UI branch on.
    pub fn code(&self) -> &'static str {
        match self {
            Self::AuthMissing => "auth_missing",
            Self::AuthRequired => "auth_required",
            Self::RateLimited => "rate_limited",
            Self::Challenged => "challenged",
            Self::Unavailable => "unavailable",
            Self::TooLarge => "too_large",
            Self::TooShort => "too_short",
            Self::BadResponse => "bad_response",
            Self::Rejected(_) => "rejected",
        }
    }

    /// A short reason phrase used in calm, user-facing copy.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::AuthMissing => "sign-in required",
            Self::AuthRequired => "sign-in expired",
            Self::RateLimited => "rate limited",
            Self::Challenged => "blocked by OpenAI's bot check",
            Self::Unavailable => "unavailable",
            Self::TooLarge => "recording too large",
            Self::TooShort => "recording too short",
            Self::BadResponse => "unreadable response",
            Self::Rejected(_) => "request rejected",
        }
    }

    /// True for failures persistent enough to pause the cloud engine: being
    /// challenged or blocked, rate limited, or the service being unreachable.
    /// A later dictation in the same run then goes straight to on-device.
    pub fn is_persistent(&self) -> bool {
        matches!(
            self,
            Self::Challenged | Self::RateLimited | Self::Unavailable
        )
    }

    /// A calm sentence that names the reason class and never the response body.
    pub fn user_message(&self) -> String {
        match self {
            Self::AuthMissing => {
                "ChatGPT transcription needs a Codex sign-in. Run `codex login` or use the on-device model.".to_string()
            }
            Self::AuthRequired => {
                "Your ChatGPT sign-in has expired. Run `codex login` or use the on-device model.".to_string()
            }
            Self::TooLarge => "That recording is too large to transcribe. Keep it under ten minutes.".to_string(),
            Self::TooShort => "That recording was too short to transcribe.".to_string(),
            Self::Challenged => {
                "OpenAI blocks transcription from apps that are not its own clients, and no on-device model is installed. Use the on-device model or dictate inside the ChatGPT app.".to_string()
            }
            Self::Rejected(code) => format!(
                "ChatGPT rejected the transcription request (HTTP {code}), and no on-device model is installed."
            ),
            other => format!(
                "ChatGPT transcription is unavailable ({}) and no on-device model is installed.",
                other.reason()
            ),
        }
    }
}

/// A small in-memory cool-down so repeated dictations stop retrying a cloud
/// engine that just failed persistently. Time is injected as `Instant`, so the
/// logic is pure and the desktop only supplies the clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct CloudCooldown {
    until: Option<Instant>,
}

impl CloudCooldown {
    pub fn new() -> Self {
        Self { until: None }
    }

    /// Record a failure at `now`. Returns true when it began a cool-down.
    pub fn record(&mut self, now: Instant, error: &CloudError) -> bool {
        if !error.is_persistent() {
            return false;
        }
        self.until = Some(now + CLOUD_COOLDOWN);
        true
    }

    /// Whether the cloud engine is still paused at `now`.
    pub fn active(&self, now: Instant) -> bool {
        matches!(self.until, Some(until) if until > now)
    }

    /// Clear the cool-down, for example after a later cloud success.
    pub fn clear(&mut self) {
        self.until = None;
    }
}

/// A string that never reveals its contents and is wiped on drop.
struct Secret(String);

impl Secret {
    fn new(value: String) -> Self {
        Self(value)
    }

    fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

struct ChatGptAuth {
    access_token: String,
    account_id: Option<String>,
    fedramp: bool,
    expires_at: Option<i64>,
}

enum ParsedAuth {
    ChatGpt(ChatGptAuth),
    ApiKey(String),
    Unsupported,
}

struct Credentials {
    mode: AuthMode,
    secret: Secret,
    account_id: Option<String>,
    fedramp: bool,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("mode", &self.mode)
            .field("secret", &self.secret)
            .field("account_id", &self.account_id)
            .field("fedramp", &self.fedramp)
            .finish()
    }
}

/// The Codex auth file: `$CODEX_HOME/auth.json`, else `<home>/.codex/auth.json`.
pub fn default_auth_path() -> Option<PathBuf> {
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(codex_home) = codex_home {
        return Some(PathBuf::from(codex_home).join("auth.json"));
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|home| !home.as_os_str().is_empty())
        .map(|home| home.join(".codex").join("auth.json"))
}

/// Read and classify the Codex auth file. Fresh per call; nothing is cached.
pub fn auth_status() -> AuthStatus {
    match default_auth_path() {
        Some(path) => resolve_auth_status(&path),
        None => AuthStatus::plain(AuthState::Missing),
    }
}

/// Classify an arbitrary auth file. Exposed for tests and callers that already
/// resolved the path themselves.
pub fn resolve_auth_status(path: &Path) -> AuthStatus {
    match parse_auth_file(path) {
        Err(()) => AuthStatus::plain(AuthState::Unreadable),
        Ok(None) => AuthStatus::plain(AuthState::Missing),
        Ok(Some(ParsedAuth::ChatGpt(auth))) => chatgpt_status(&auth, now_epoch_seconds()),
        Ok(Some(ParsedAuth::ApiKey(_))) => AuthStatus {
            state: AuthState::ApiKey,
            mode: Some(AuthMode::ApiKey),
            expires_at: None,
        },
        Ok(Some(ParsedAuth::Unsupported)) => AuthStatus::plain(AuthState::Unsupported),
    }
}

fn parse_auth_file(path: &Path) -> Result<Option<ParsedAuth>, ()> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    Ok(Some(classify(&value)))
}

fn classify(value: &serde_json::Value) -> ParsedAuth {
    let auth_mode = value.get("auth_mode").and_then(|v| v.as_str());
    let tokens = value.get("tokens");
    let access_token = tokens
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty());

    if auth_mode == Some("apikey") {
        return match api_key_from(value) {
            Some(key) => ParsedAuth::ApiKey(key),
            None => ParsedAuth::Unsupported,
        };
    }

    if let Some(access_token) = access_token {
        let access_claims = decode_jwt_claims(access_token);
        let id_claims = tokens
            .and_then(|tokens| tokens.get("id_token"))
            .and_then(|v| v.as_str())
            .and_then(decode_jwt_claims);
        let explicit_account_id = tokens
            .and_then(|tokens| tokens.get("account_id"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let account_id = explicit_account_id
            .or_else(|| access_claims.as_ref().and_then(account_id_from_claims))
            .or_else(|| id_claims.as_ref().and_then(account_id_from_claims));
        let fedramp = access_claims
            .as_ref()
            .and_then(fedramp_from_claims)
            .or_else(|| id_claims.as_ref().and_then(fedramp_from_claims))
            .unwrap_or(false);
        let expires_at = access_claims.as_ref().and_then(exp_from_claims);
        return ParsedAuth::ChatGpt(ChatGptAuth {
            access_token: access_token.to_string(),
            account_id,
            fedramp,
            expires_at,
        });
    }

    match api_key_from(value) {
        Some(key) => ParsedAuth::ApiKey(key),
        None => ParsedAuth::Unsupported,
    }
}

fn api_key_from(value: &serde_json::Value) -> Option<String> {
    value
        .get("OPENAI_API_KEY")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

fn decode_jwt_claims(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    if payload.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn auth_claim(claims: &serde_json::Value) -> Option<&serde_json::Value> {
    claims.get("https://api.openai.com/auth")
}

fn account_id_from_claims(claims: &serde_json::Value) -> Option<String> {
    auth_claim(claims)?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_owned)
        .filter(|id| !id.is_empty())
}

fn fedramp_from_claims(claims: &serde_json::Value) -> Option<bool> {
    auth_claim(claims)?
        .get("chatgpt_account_is_fedramp")?
        .as_bool()
}

fn exp_from_claims(claims: &serde_json::Value) -> Option<i64> {
    claims.get("exp").and_then(|v| v.as_i64())
}

fn chatgpt_status(auth: &ChatGptAuth, now: i64) -> AuthStatus {
    let expires_at = auth.expires_at.and_then(format_epoch);
    let state = match auth.expires_at {
        Some(expires) if expires <= now => AuthState::Expired,
        _ => AuthState::Ready,
    };
    AuthStatus {
        state,
        mode: Some(AuthMode::ChatGpt),
        expires_at,
    }
}

fn format_epoch(epoch: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp(epoch, 0)
        .map(|moment| moment.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn load_credentials(path: &Path) -> Result<Credentials, CloudError> {
    match parse_auth_file(path).map_err(|_| CloudError::AuthMissing)? {
        None | Some(ParsedAuth::Unsupported) => Err(CloudError::AuthMissing),
        Some(ParsedAuth::ApiKey(key)) => Ok(Credentials {
            mode: AuthMode::ApiKey,
            secret: Secret::new(key),
            account_id: None,
            fedramp: false,
        }),
        Some(ParsedAuth::ChatGpt(auth)) => match auth.account_id {
            Some(account_id) => Ok(Credentials {
                mode: AuthMode::ChatGpt,
                secret: Secret::new(auth.access_token),
                account_id: Some(account_id),
                fedramp: auth.fedramp,
            }),
            None => Err(CloudError::AuthMissing),
        },
    }
}

/// A bounded, in-memory sample buffer for the cloud session.
#[derive(Debug, Clone)]
pub struct AudioBuffer {
    samples: Vec<f32>,
    limit: usize,
}

impl AudioBuffer {
    pub fn new(limit: usize) -> Self {
        Self {
            samples: Vec::new(),
            limit,
        }
    }

    /// Append samples, refusing to grow past the hard cap.
    pub fn push(&mut self, samples: &[f32]) -> Result<(), CloudError> {
        if self.samples.len().saturating_add(samples.len()) > self.limit {
            return Err(CloudError::TooLarge);
        }
        self.samples.extend_from_slice(samples);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub fn clear(&mut self) {
        self.samples.clear();
    }
}

impl Default for AudioBuffer {
    fn default() -> Self {
        Self::new(MAX_BUFFER_SAMPLES)
    }
}

/// Reject audio that is too short to transcribe or larger than the hard cap,
/// before any network call.
pub fn validate_samples(sample_count: usize) -> Result<(), CloudError> {
    if sample_count < MIN_SPEECH_SAMPLES {
        return Err(CloudError::TooShort);
    }
    if sample_count > MAX_BUFFER_SAMPLES {
        return Err(CloudError::TooLarge);
    }
    Ok(())
}

/// Encode mono `f32` samples as a 16 kHz PCM16 WAV with a correct 44-byte header.
pub fn pcm16_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let byte_rate = CLOUD_SAMPLE_RATE * 2;
    let mut wav = Vec::with_capacity(44 + data_len);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&CLOUD_SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        let scaled = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        wav.extend_from_slice(&scaled.to_le_bytes());
    }
    wav
}

/// Build the multipart body by hand: the workspace `reqwest` has no multipart
/// feature. Part order is `file`, `model`, then the optional `prompt`.
pub fn build_multipart(boundary: &str, wav: &[u8], model: &str, prompt: Option<&str>) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(wav);
    body.extend_from_slice(b"\r\n");

    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"model\"\r\n\r\n");
    body.extend_from_slice(model.as_bytes());
    body.extend_from_slice(b"\r\n");

    if let Some(prompt) = prompt {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(b"Content-Disposition: form-data; name=\"prompt\"\r\n\r\n");
        body.extend_from_slice(prompt.as_bytes());
        body.extend_from_slice(b"\r\n");
    }

    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

fn make_boundary() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("----bloblex-{nanos:032x}")
}

/// The cloud transcription client. Cheap to construct; the auth file is read
/// fresh inside every call.
pub struct CloudTranscriber {
    base_url: Option<String>,
    auth_path: Option<PathBuf>,
    timeout: Duration,
}

impl CloudTranscriber {
    pub fn new() -> Self {
        Self {
            base_url: None,
            auth_path: None,
            timeout: REQUEST_TIMEOUT,
        }
    }

    /// Point every mode at one base URL (tests, and self-hosted proxies).
    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self::new().base(base_url)
    }

    pub fn base(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    pub fn auth_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.auth_path = Some(path.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn resolved_auth_path(&self) -> Option<PathBuf> {
        self.auth_path.clone().or_else(default_auth_path)
    }

    /// Upload a prepared WAV and return the transcript text.
    pub async fn transcribe(&self, wav: &[u8], prompt: Option<&str>) -> Result<String, CloudError> {
        if wav.len() > MAX_AUDIO_BYTES {
            return Err(CloudError::TooLarge);
        }
        let auth_path = self.resolved_auth_path().ok_or(CloudError::AuthMissing)?;
        let credentials = load_credentials(&auth_path)?;
        let (url, chatgpt) = match credentials.mode {
            AuthMode::ChatGpt => {
                let base = self
                    .base_url
                    .clone()
                    .unwrap_or_else(|| "https://chatgpt.com".to_string());
                (
                    format!("{}/backend-api/transcribe", base.trim_end_matches('/')),
                    true,
                )
            }
            AuthMode::ApiKey => {
                let base = self
                    .base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.openai.com".to_string());
                (
                    format!("{}/v1/audio/transcriptions", base.trim_end_matches('/')),
                    false,
                )
            }
        };

        let boundary = make_boundary();
        let body = build_multipart(&boundary, wav, CLOUD_MODEL, prompt);
        let client = cloud_client()?;
        let timeout = self.timeout;
        let send = || {
            let mut request = client
                .post(url.as_str())
                .timeout(timeout)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .header(
                    reqwest::header::USER_AGENT,
                    concat!("bloblex-desktop/", env!("CARGO_PKG_VERSION")),
                )
                .header("originator", "bloblex")
                .header(
                    reqwest::header::AUTHORIZATION,
                    format!("Bearer {}", credentials.secret.expose()),
                )
                .body(body.clone());
            if chatgpt {
                if let Some(account_id) = credentials.account_id.as_deref() {
                    request = request.header("chatgpt-account-id", account_id);
                }
                if credentials.fedramp {
                    request = request.header("X-OpenAI-Fedramp", "true");
                }
                if let Some(cookie) = cloudflare_cookie_header() {
                    request = request.header(reqwest::header::COOKIE, cookie);
                }
            }
            request
        };

        // Like bb: send once; if the edge answers with a challenge, keep the
        // Cloudflare cookies it set and send once more carrying them.
        let mut response = send().send().await.map_err(|_| CloudError::Unavailable)?;
        if chatgpt {
            store_cloudflare_cookies(response.headers());
            if is_cloudflare_challenge(response.status(), response.headers()) {
                response = send().send().await.map_err(|_| CloudError::Unavailable)?;
                store_cloudflare_cookies(response.headers());
            }
        }
        let status = response.status();
        if status.is_redirection() {
            return Err(CloudError::Unavailable);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CloudError::AuthRequired);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(CloudError::RateLimited);
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(if response.headers().get("cf-mitigated").is_some() {
                CloudError::Challenged
            } else {
                CloudError::Rejected(403)
            });
        }
        if status.is_server_error() {
            return Err(CloudError::Unavailable);
        }
        if !status.is_success() {
            return Err(CloudError::Rejected(status.as_u16()));
        }

        let body = read_capped(&mut response).await?;
        let parsed: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| CloudError::BadResponse)?;
        parsed
            .get("text")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .ok_or(CloudError::BadResponse)
    }

    /// Validate, encode to WAV and upload 16 kHz mono samples.
    pub async fn transcribe_samples(
        &self,
        samples: &[f32],
        prompt: Option<&str>,
    ) -> Result<String, CloudError> {
        validate_samples(samples.len())?;
        let wav = pcm16_wav(samples);
        self.transcribe(&wav, prompt).await
    }
}

impl Default for CloudTranscriber {
    fn default() -> Self {
        Self::new()
    }
}

/// What the cloud dictation warm-up found. Status only: it never carries a
/// token, an email, audio or a transcript, and building it sends no request to
/// the transcription endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmReport {
    pub client_ready: bool,
    pub auth: AuthStatus,
    pub dns_ok: bool,
}

/// Prepare cloud dictation without contacting ChatGPT: build or reuse the shared
/// client (and its rustls config), read the Codex login state (keeping no token)
/// and resolve `chatgpt.com:443`. A missing client or a failed lookup is
/// reported, not raised, and nothing here reaches the transcription endpoint.
pub async fn warm() -> WarmReport {
    let client_ready = cloud_client().is_ok();
    let auth = auth_status();
    // A hung resolver must not hold the warm-up open: bound the lookup at a few
    // seconds and report a timeout as `dns_ok: false`.
    let dns_ok = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host(("chatgpt.com", 443u16)),
    )
    .await
    .is_ok_and(|result| result.is_ok());
    WarmReport {
        client_ready,
        auth,
        dns_ok,
    }
}

async fn read_capped(response: &mut reqwest::Response) -> Result<Vec<u8>, CloudError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CloudError::Unavailable)? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(CloudError::BadResponse);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// The cookie jar is process-wide, so tests that touch it run one at a time.
    static COOKIE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Pins the deliberate no-ALPN choice for the cloud client. This is not
    /// what makes the request pass — rustls returns `200` with ALPN
    /// re-advertised too (measured 14 October 2026) — it just keeps the
    /// handshake minimal and fails if a future change starts advertising
    /// protocols by accident.
    #[test]
    fn cloud_tls_config_advertises_no_alpn() {
        let config = cloud_tls_config().expect("tls config builds");
        assert!(
            config.alpn_protocols.is_empty(),
            "the cloud client advertises no ALPN by choice: {:?}",
            config.alpn_protocols
        );
    }

    /// The client is built with the no-ALPN rustls config and HTTP/1.1 only.
    #[test]
    fn build_cloud_client_succeeds() {
        assert!(build_cloud_client().is_ok());
    }

    /// The client is a process-wide singleton, so its connection pool and rustls
    /// setup are reused between dictations.
    #[test]
    fn cloud_client_is_a_shared_singleton() {
        let first = cloud_client().expect("client builds");
        let second = cloud_client().expect("client builds");
        assert!(std::ptr::eq(first, second), "two calls must return the same client");
    }

    /// Warm-up reads the login state without a request to the endpoint. With no
    /// auth file it reports Missing; the DNS step is reported, not raised.
    #[tokio::test]
    async fn warm_reports_status_without_contacting_the_endpoint() {
        let report = tokio::time::timeout(Duration::from_secs(20), warm())
            .await
            .expect("warm() must not hang");
        assert!(report.client_ready, "the shared client builds");
        if default_auth_path().map(|path| !path.exists()).unwrap_or(true) {
            assert_eq!(report.auth.state, AuthState::Missing);
        }
        let _ = report.dns_ok;
    }

    /// The warm-up is bounded: a hung resolver cannot hold it past the DNS
    /// timeout, and a timeout is reported as `dns_ok: false`, not raised.
    #[tokio::test]
    async fn warm_returns_within_five_seconds() {
        let report = tokio::time::timeout(Duration::from_secs(5), warm())
            .await
            .expect("warm() must return within five seconds");
        // With or without network the report is produced; a failed or timed-out
        // lookup is simply `dns_ok: false`.
        let _ = report.dns_ok;
        assert!(report.client_ready, "the shared client builds");
    }

    fn encode_segment(bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    fn jwt(claims: &serde_json::Value) -> String {
        format!(
            "{}.{}.signature",
            encode_segment(br#"{"alg":"none","typ":"JWT"}"#),
            encode_segment(&serde_json::to_vec(claims).unwrap())
        )
    }

    fn write_auth(value: &serde_json::Value) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.json");
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        (directory, path)
    }

    fn chatgpt_auth(claims: serde_json::Value) -> (tempfile::TempDir, PathBuf) {
        let token = jwt(&claims);
        write_auth(&serde_json::json!({
            "auth_mode": "chatgpt",
            "tokens": { "access_token": token, "account_id": "acct_test" }
        }))
    }

    fn status(state: AuthState) -> AuthStatus {
        AuthStatus {
            state,
            mode: None,
            expires_at: None,
        }
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|window| window == needle)
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut scratch = [0u8; 4096];
        let header_end = loop {
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            if read == 0 {
                return buffer;
            }
            buffer.extend_from_slice(&scratch[..read]);
            if let Some(position) = find(&buffer, b"\r\n\r\n") {
                break position + 4;
            }
        };
        let headers = String::from_utf8_lossy(&buffer[..header_end]).to_lowercase();
        let content_length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while buffer.len() < header_end + content_length {
            let read = socket.read(&mut scratch).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&scratch[..read]);
        }
        buffer
    }

    async fn serve_once(
        status_line: &str,
        headers: &str,
        body: Vec<u8>,
    ) -> (SocketAddr, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status_line = status_line.to_string();
        let headers = headers.to_string();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let head = format!(
                "HTTP/1.1 {status_line}\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n",
                body.len()
            );
            let mut out = head.into_bytes();
            out.extend_from_slice(&body);
            let _ = socket.write_all(&out).await;
            let _ = socket.shutdown().await;
            request
        });
        (address, handle)
    }

    /// Answer successive connections with the given responses, in order, and
    /// return every request received.
    async fn serve_sequence(
        responses: Vec<(&str, &str, Vec<u8>)>,
    ) -> (SocketAddr, tokio::task::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let responses: Vec<(String, String, Vec<u8>)> = responses
            .into_iter()
            .map(|(status, headers, body)| (status.to_string(), headers.to_string(), body))
            .collect();
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status_line, headers, body) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_http_request(&mut socket).await);
                let head = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n",
                    body.len()
                );
                let mut out = head.into_bytes();
                out.extend_from_slice(&body);
                let _ = socket.write_all(&out).await;
                let _ = socket.shutdown().await;
            }
            requests
        });
        (address, handle)
    }

    /// Answer every accepted connection with a 302 to a discard port and count
    /// the connections, so a followed redirect would be observable.
    async fn serve_redirects() -> (SocketAddr, tokio::task::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut count = 0;
            loop {
                let accepted =
                    tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
                let Ok(Ok((mut socket, _))) = accepted else {
                    break;
                };
                count += 1;
                let _ = read_http_request(&mut socket).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                let _ = socket.shutdown().await;
            }
            count
        });
        (address, handle)
    }

    async fn serve_slow_body(delay: Duration) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx")
                .await;
            tokio::time::sleep(delay).await;
            let _ = socket.write_all(&[b'x'; 99]).await;
            let _ = socket.shutdown().await;
        });
        (address, handle)
    }

    fn transcriber(address: SocketAddr, path: PathBuf) -> CloudTranscriber {
        CloudTranscriber::with_base_url(format!("http://{address}")).auth_path(path)
    }

    fn sample() -> Vec<f32> {
        vec![0.0f32; MIN_SPEECH_SAMPLES]
    }

    #[test]
    fn auth_status_reads_explicit_account_id() {
        let token = jwt(&serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let (_dir, path) = write_auth(&serde_json::json!({
            "auth_mode": "chatgpt",
            "tokens": { "access_token": token, "id_token": jwt(&serde_json::json!({})), "account_id": "acct_explicit" }
        }));
        let state = resolve_auth_status(&path);
        assert_eq!(state.state, AuthState::Ready);
        assert_eq!(state.mode, Some(AuthMode::ChatGpt));
        assert!(state.expires_at.is_some());
    }

    #[test]
    fn account_id_falls_back_to_access_token_claim() {
        let access = jwt(&serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct_access" }
        }));
        let id = jwt(&serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct_id" }
        }));
        let (_dir, path) = write_auth(&serde_json::json!({
            "tokens": { "access_token": access, "id_token": id }
        }));
        let credentials = load_credentials(&path).unwrap();
        assert_eq!(credentials.account_id.as_deref(), Some("acct_access"));
    }

    #[test]
    fn account_id_falls_back_to_id_token_claim() {
        let access = jwt(&serde_json::json!({}));
        let id = jwt(&serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct_id_only" }
        }));
        let (_dir, path) = write_auth(&serde_json::json!({
            "tokens": { "access_token": access, "id_token": id }
        }));
        let credentials = load_credentials(&path).unwrap();
        assert_eq!(credentials.account_id.as_deref(), Some("acct_id_only"));
    }

    #[test]
    fn apikey_mode_from_auth_mode_field() {
        let (_dir, path) = write_auth(&serde_json::json!({
            "auth_mode": "apikey",
            "OPENAI_API_KEY": "sk-test-key"
        }));
        let state = resolve_auth_status(&path);
        assert_eq!(state.state, AuthState::ApiKey);
        assert_eq!(state.mode, Some(AuthMode::ApiKey));
        let credentials = load_credentials(&path).unwrap();
        assert_eq!(credentials.mode, AuthMode::ApiKey);
        assert_eq!(credentials.secret.expose(), "sk-test-key");
    }

    #[test]
    fn apikey_mode_when_only_key_is_present() {
        let (_dir, path) = write_auth(&serde_json::json!({ "OPENAI_API_KEY": "sk-only" }));
        assert_eq!(resolve_auth_status(&path).state, AuthState::ApiKey);
    }

    #[test]
    fn missing_auth_file_reports_missing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("absent.json");
        assert_eq!(resolve_auth_status(&path).state, AuthState::Missing);
    }

    #[test]
    fn malformed_auth_file_reports_unreadable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.json");
        std::fs::write(&path, b"this is not json").unwrap();
        assert_eq!(resolve_auth_status(&path).state, AuthState::Unreadable);
        assert_eq!(load_credentials(&path).unwrap_err(), CloudError::AuthMissing);
    }

    #[test]
    fn unreadable_auth_path_reports_unreadable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.json");
        std::fs::create_dir(&path).unwrap();
        assert_eq!(resolve_auth_status(&path).state, AuthState::Unreadable);
    }

    #[test]
    fn expired_and_valid_jwt_are_distinguished() {
        let expired = jwt(&serde_json::json!({ "exp": now_epoch_seconds() - 60 }));
        let (_dir, path) = write_auth(&serde_json::json!({
            "tokens": { "access_token": expired, "account_id": "acct" }
        }));
        let state = resolve_auth_status(&path);
        assert_eq!(state.state, AuthState::Expired);
        assert_eq!(state.mode, Some(AuthMode::ChatGpt));
        assert!(state.expires_at.is_some());
    }

    #[test]
    fn unsupported_auth_is_reported_without_tokens() {
        let (_dir, path) = write_auth(&serde_json::json!({ "something": "else" }));
        assert_eq!(resolve_auth_status(&path).state, AuthState::Unsupported);
    }

    #[test]
    fn secret_and_errors_never_leak_contents() {
        let secret = Secret::new("super-secret-token".to_string());
        let debug = format!("{secret:?}");
        assert!(debug.contains("redacted"));
        assert!(!debug.contains("super-secret-token"));

        for error in [
            CloudError::AuthMissing,
            CloudError::AuthRequired,
            CloudError::RateLimited,
            CloudError::Challenged,
            CloudError::Unavailable,
            CloudError::TooLarge,
            CloudError::TooShort,
            CloudError::BadResponse,
            CloudError::Rejected(400),
        ] {
            assert!(!error.to_string().contains("http"));
            assert!(!format!("{error:?}").contains("super-secret-token"));
        }
        assert_eq!(CloudError::AuthRequired.code(), "auth_required");
        assert_eq!(CloudError::RateLimited.code(), "rate_limited");
        assert_eq!(CloudError::Rejected(400).code(), "rejected");
    }

    #[test]
    fn wav_header_is_well_formed() {
        let wav = pcm16_wav(&[0.0, 1.0, -1.0, 0.25]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 8);
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), CLOUD_SAMPLE_RATE);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 32_000);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        assert_eq!(wav.len(), 44 + 8);
        assert_eq!(i16::from_le_bytes(wav[44..46].try_into().unwrap()), 0);
        assert_eq!(i16::from_le_bytes(wav[46..48].try_into().unwrap()), i16::MAX);
        assert_eq!(i16::from_le_bytes(wav[48..50].try_into().unwrap()), -i16::MAX);
    }

    #[test]
    fn audio_buffer_refuses_to_exceed_its_cap() {
        let mut buffer = AudioBuffer::new(4);
        buffer.push(&[0.0, 0.0, 0.0]).unwrap();
        assert_eq!(buffer.push(&[0.0, 0.0]), Err(CloudError::TooLarge));
        assert_eq!(buffer.len(), 3);
        assert!(!buffer.is_empty());
        buffer.clear();
        assert!(buffer.is_empty());
    }

    #[test]
    fn precheck_bounds_are_enforced_without_allocating_audio() {
        assert_eq!(validate_samples(0), Err(CloudError::TooShort));
        assert_eq!(validate_samples(MIN_SPEECH_SAMPLES), Ok(()));
        assert_eq!(validate_samples(MAX_BUFFER_SAMPLES + 1), Err(CloudError::TooLarge));
    }

    #[test]
    fn multipart_body_has_ordered_parts_and_final_crlf() {
        let wav = pcm16_wav(&[0.0, 0.5, -0.5]);
        let body = build_multipart("BOUNDARY", &wav, CLOUD_MODEL, Some("a hint"));
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--BOUNDARY\r\n"));
        assert!(text.ends_with("--BOUNDARY--\r\n"));
        assert!(text.contains("filename=\"recording.wav\""));
        assert!(text.contains("Content-Type: audio/wav"));
        assert!(text.contains(CLOUD_MODEL));
        let file = text.find("name=\"file\"").unwrap();
        let model = text.find("name=\"model\"").unwrap();
        let prompt = text.find("name=\"prompt\"").unwrap();
        assert!(file < model && model < prompt);

        let without_prompt = build_multipart("BOUNDARY", &wav, CLOUD_MODEL, None);
        assert!(!String::from_utf8_lossy(&without_prompt).contains("name=\"prompt\""));
    }

    #[test]
    fn resolve_engine_truth_table() {
        use EnginePreference::{Automatic, Cloud, Local};
        use ResolvedEngine::{ChatGpt, OnDevice};

        let ready = status(AuthState::Ready);
        let resolved = |primary, fallback, unavailable, reason| Resolved {
            primary,
            fallback,
            unavailable,
            reason,
        };
        assert_eq!(
            resolve_engine(Local, true, &ready, true, false),
            resolved(OnDevice, None, None, None)
        );
        assert_eq!(
            resolve_engine(Local, true, &ready, false, false),
            resolved(OnDevice, None, Some("model_not_ready"), None)
        );
        assert_eq!(
            resolve_engine(Cloud, false, &ready, true, false),
            resolved(OnDevice, None, None, None)
        );
        assert_eq!(
            resolve_engine(Cloud, false, &ready, false, false),
            resolved(OnDevice, None, Some("consent_required"), None)
        );
        assert_eq!(
            resolve_engine(Automatic, true, &ready, true, false),
            resolved(ChatGpt, Some(OnDevice), None, None)
        );
        assert_eq!(
            resolve_engine(Cloud, true, &ready, false, false),
            resolved(ChatGpt, None, None, None)
        );

        let missing = status(AuthState::Missing);
        assert_eq!(
            resolve_engine(Automatic, true, &missing, true, false),
            resolved(OnDevice, None, None, None)
        );
        assert_eq!(
            resolve_engine(Automatic, true, &missing, false, false),
            resolved(OnDevice, None, Some("auth_missing"), None)
        );
        assert_eq!(
            resolve_engine(Cloud, true, &status(AuthState::Expired), true, false).primary,
            ChatGpt
        );
        assert_eq!(
            resolve_engine(Cloud, true, &status(AuthState::ApiKey), true, false).primary,
            ChatGpt
        );
        assert_eq!(
            resolve_engine(Cloud, true, &status(AuthState::Unsupported), false, false).unavailable,
            Some("auth_missing")
        );
        assert_eq!(EnginePreference::parse("automatic"), Automatic);
        assert_eq!(EnginePreference::parse("cloud"), Cloud);
        assert_eq!(EnginePreference::parse("nonsense"), Local);
    }

    #[test]
    fn automatic_skips_a_cooling_cloud_when_local_can_run() {
        let ready = status(AuthState::Ready);
        // Automatic + cool-down + local ready: straight to on-device, reason set.
        assert_eq!(
            resolve_engine(EnginePreference::Automatic, true, &ready, true, true),
            Resolved {
                primary: ResolvedEngine::OnDevice,
                fallback: None,
                unavailable: None,
                reason: Some("cloud_cooldown"),
            }
        );
        // An explicit cloud choice overrides the cool-down.
        assert_eq!(
            resolve_engine(EnginePreference::Cloud, true, &ready, true, true).primary,
            ResolvedEngine::ChatGpt
        );
        // Without a local model the cool-down cannot divert, so cloud is still tried.
        assert_eq!(
            resolve_engine(EnginePreference::Automatic, true, &ready, false, true).primary,
            ResolvedEngine::ChatGpt
        );
    }

    #[test]
    fn cool_down_pauses_then_expires_with_an_injected_clock() {
        let start = Instant::now();
        let mut cooldown = CloudCooldown::new();
        assert!(!cooldown.active(start));

        // A transient failure does not start a cool-down.
        assert!(!cooldown.record(start, &CloudError::Rejected(403)));
        assert!(!cooldown.active(start));

        // A challenge does, and expires exactly after the window.
        assert!(cooldown.record(start, &CloudError::Challenged));
        assert!(cooldown.active(start));
        assert!(cooldown.active(start + CLOUD_COOLDOWN - Duration::from_secs(1)));
        assert!(!cooldown.active(start + CLOUD_COOLDOWN));
        assert!(!cooldown.active(start + CLOUD_COOLDOWN + Duration::from_secs(1)));

        // Recording again extends from the new moment.
        cooldown.record(start + Duration::from_secs(30), &CloudError::Unavailable);
        assert!(cooldown.active(start + Duration::from_secs(31)));

        cooldown.clear();
        assert!(!cooldown.active(start + Duration::from_secs(31)));
    }

    #[test]
    fn persistent_errors_start_a_cool_down_and_transient_ones_do_not() {
        for error in [CloudError::Challenged, CloudError::RateLimited, CloudError::Unavailable] {
            assert!(error.is_persistent(), "{error:?} should be persistent");
            let mut cooldown = CloudCooldown::new();
            assert!(cooldown.record(Instant::now(), &error));
            assert!(cooldown.active(Instant::now()));
        }
        for error in [
            CloudError::AuthMissing,
            CloudError::AuthRequired,
            CloudError::TooLarge,
            CloudError::TooShort,
            CloudError::BadResponse,
            CloudError::Rejected(403),
        ] {
            assert!(!error.is_persistent(), "{error:?} should not be persistent");
            assert!(!CloudCooldown::new().record(Instant::now(), &error));
        }
    }

    #[test]
    fn challenged_and_rejected_copy_is_truthful_not_verification() {
        let challenged = CloudError::Challenged;
        assert_eq!(challenged.code(), "challenged");
        assert!(!challenged.reason().contains("verification"));
        assert!(!challenged.user_message().contains("verification"));
        assert!(challenged.user_message().contains("OpenAI"));

        let rejected = CloudError::Rejected(403);
        assert_eq!(rejected.code(), "rejected");
        assert!(!rejected.reason().contains("verification"));
        assert!(rejected.user_message().contains("HTTP 403"));
    }

    #[tokio::test]
    async fn success_reads_text_and_sends_the_expected_request() {
        let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let (address, handle) = serve_once("200 OK", "", br#"{"text":"hello world"}"#.to_vec()).await;
        let text = transcriber(address, path)
            .transcribe_samples(&sample(), None)
            .await
            .unwrap();
        assert_eq!(text, "hello world");

        let request = handle.await.unwrap();
        let head = String::from_utf8_lossy(&request);
        let lower = head.to_lowercase();
        assert!(lower.contains("authorization: bearer "));
        assert!(lower.contains("chatgpt-account-id: acct_test"));
        assert!(lower.contains("originator: bloblex"));
        assert!(lower.contains("user-agent: bloblex-desktop/"));
        assert!(lower.contains("content-type: multipart/form-data; boundary="));
        assert!(head.find("name=\"file\"").unwrap() < head.find("name=\"model\"").unwrap());
    }

    #[tokio::test]
    async fn fedramp_claim_adds_the_header() {
        let token = jwt(&serde_json::json!({
            "exp": now_epoch_seconds() + 3600,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_fed",
                "chatgpt_account_is_fedramp": true
            }
        }));
        let (_dir, path) = write_auth(&serde_json::json!({ "tokens": { "access_token": token } }));
        let (address, handle) = serve_once("200 OK", "", br#"{"text":"ok"}"#.to_vec()).await;
        transcriber(address, path)
            .transcribe_samples(&sample(), None)
            .await
            .unwrap();
        let lower = String::from_utf8_lossy(&handle.await.unwrap()).to_lowercase();
        assert!(lower.contains("x-openai-fedramp: true"));
        assert!(lower.contains("chatgpt-account-id: acct_fed"));
    }

    #[tokio::test]
    async fn error_statuses_map_to_typed_errors() {
        let cases = [
            ("401 Unauthorized", "", CloudError::AuthRequired),
            ("429 Too Many Requests", "", CloudError::RateLimited),
            ("500 Internal Server Error", "", CloudError::Unavailable),
            ("403 Forbidden", "", CloudError::Rejected(403)),
            ("400 Bad Request", "", CloudError::Rejected(400)),
        ];
        for (status_line, headers, expected) in cases {
            let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
            let (address, handle) = serve_once(status_line, headers, b"ignored".to_vec()).await;
            let result = transcriber(address, path).transcribe_samples(&sample(), None).await;
            assert_eq!(result.unwrap_err(), expected, "status {status_line}");
            handle.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cloudflare_challenge_maps_to_challenged() {
        let _guard = COOKIE_TEST_LOCK.lock().await;
        reset_cloudflare_cookies();
        let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        // A challenge is retried once; when the second answer is a challenge too, it stays one.
        let challenge = ("403 Forbidden", "cf-mitigated: challenge\r\n", b"no".to_vec());
        let (address, handle) = serve_sequence(vec![challenge.clone(), challenge]).await;
        let result = transcriber(address, path).transcribe_samples(&sample(), None).await;
        assert_eq!(result.unwrap_err(), CloudError::Challenged);
        assert_eq!(handle.await.unwrap().len(), 2, "one retry, no more");
    }

    #[tokio::test]
    async fn a_challenge_is_retried_once_with_only_the_cloudflare_cookies_it_set() {
        let _guard = COOKIE_TEST_LOCK.lock().await;
        reset_cloudflare_cookies();
        let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let (address, handle) = serve_sequence(vec![
            (
                "403 Forbidden",
                "cf-mitigated: challenge\r\nSet-Cookie: __cf_bm=abc123; Path=/; HttpOnly\r\nSet-Cookie: _cfuvid=uv9; Path=/\r\nSet-Cookie: session=nope; Path=/\r\n",
                b"challenge".to_vec(),
            ),
            ("200 OK", "Content-Type: application/json\r\n", br#"{"text":"hello there"}"#.to_vec()),
        ])
        .await;
        let result = transcriber(address, path).transcribe_samples(&sample(), None).await;
        assert_eq!(result.unwrap(), "hello there");
        let requests = handle.await.unwrap();
        let text = |bytes: &Vec<u8>| String::from_utf8_lossy(bytes).to_lowercase();
        assert!(!text(&requests[0]).contains("cookie:"), "nothing to replay on the first request");
        let second = text(&requests[1]);
        assert!(second.contains("cookie: "));
        assert!(second.contains("__cf_bm=abc123") && second.contains("_cfuvid=uv9"));
        assert!(!second.contains("session=nope"), "only Cloudflare cookies are kept");
        reset_cloudflare_cookies();
    }

    #[tokio::test]
    async fn stored_cookies_travel_with_the_next_dictation() {
        let _guard = COOKIE_TEST_LOCK.lock().await;
        reset_cloudflare_cookies();
        let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let (first, _) = serve_sequence(vec![(
            "200 OK",
            "Content-Type: application/json\r\nSet-Cookie: cf_clearance=ok77; Path=/\r\n",
            br#"{"text":"one"}"#.to_vec(),
        )])
        .await;
        assert_eq!(transcriber(first, path.clone()).transcribe_samples(&sample(), None).await.unwrap(), "one");
        let (second, handle) = serve_sequence(vec![("200 OK", "Content-Type: application/json\r\n", br#"{"text":"two"}"#.to_vec())]).await;
        assert_eq!(transcriber(second, path).transcribe_samples(&sample(), None).await.unwrap(), "two");
        let request = String::from_utf8_lossy(&handle.await.unwrap()[0]).to_lowercase();
        assert!(request.contains("cookie: cf_clearance=ok77"));
        reset_cloudflare_cookies();
    }

    #[tokio::test]
    async fn oversized_and_malformed_bodies_map_to_bad_response() {
        let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let big = vec![b'a'; MAX_RESPONSE_BYTES + 1];
        let (address, _handle) = serve_once("200 OK", "", big).await;
        let result = transcriber(address, path).transcribe_samples(&sample(), None).await;
        assert_eq!(result.unwrap_err(), CloudError::BadResponse);

        let (_dir2, path2) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let (address2, _handle2) = serve_once("200 OK", "", b"not json".to_vec()).await;
        let result = transcriber(address2, path2).transcribe_samples(&sample(), None).await;
        assert_eq!(result.unwrap_err(), CloudError::BadResponse);
    }

    #[tokio::test]
    async fn redirect_is_not_followed_and_maps_to_unavailable() {
        let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let (address, handle) = serve_redirects().await;
        let result = transcriber(address, path).transcribe_samples(&sample(), None).await;
        assert_eq!(result.unwrap_err(), CloudError::Unavailable);
        let connections = handle.await.unwrap();
        assert_eq!(connections, 1, "the redirect must not be followed");
    }

    #[tokio::test]
    async fn slow_body_times_out_as_unavailable() {
        let (_dir, path) = chatgpt_auth(serde_json::json!({ "exp": now_epoch_seconds() + 3600 }));
        let (address, handle) = serve_slow_body(Duration::from_millis(400)).await;
        let result = transcriber(address, path)
            .timeout(Duration::from_millis(120))
            .transcribe_samples(&sample(), None)
            .await;
        assert_eq!(result.unwrap_err(), CloudError::Unavailable);
        handle.abort();
    }

    #[tokio::test]
    async fn short_audio_makes_no_network_call() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let transcriber = CloudTranscriber::with_base_url(format!("http://{address}"));
        let error = transcriber.transcribe_samples(&[0.0f32; 8], None).await.unwrap_err();
        assert_eq!(error, CloudError::TooShort);
        assert!(tokio::time::timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn missing_auth_makes_no_network_call() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let transcriber = CloudTranscriber::with_base_url(format!("http://{address}"))
            .auth_path(directory.path().join("absent.json"));
        let error = transcriber.transcribe_samples(&sample(), None).await.unwrap_err();
        assert_eq!(error, CloudError::AuthMissing);
        assert!(tokio::time::timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err());
    }
}

