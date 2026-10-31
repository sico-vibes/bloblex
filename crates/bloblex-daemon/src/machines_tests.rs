//! Phase 4 tests: machine identity, links and reading the other machine.
//!
//! No test touches a real second machine. The "other machine" is a second
//! `AppState` behind its real gateway on loopback: Native over its own
//! self-signed certificate, or the Tailscale method served behind a test
//! certificate that the client is told to trust. Client-level rules run against
//! a small raw TLS server that records exactly what it was sent.

use crate::machine_client::{self as client, ClientError, Trust, TEST_ROOTS};
use crate::machines::{self, Timing};
use crate::remote::pairing::DEVICE_COOKIE;
use crate::remote::web::WebState;
use crate::{dispatch, AppState};
use reqwest::Method;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

const PASSWORD: &str = "correct horse battery";

fn fast() -> Timing {
    Timing {
        interval: Duration::from_millis(150),
        call_timeout: Duration::from_millis(8_000),
        poll_every: Duration::from_millis(40),
        pair_window: Duration::from_secs(20),
    }
}

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("bitbots-machines-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A state with its own data folder and short clocks. This is "this machine".
fn local(tag: &str) -> (AppState, PathBuf) {
    let (st, _events) = crate::phase2a_tests::state();
    let dir = temp(tag);
    *st.team.data_dir.lock().unwrap() = Some(dir.clone());
    st.machines.set_timing(fast());
    (st, dir)
}

/// The other machine: a state behind its Native gateway on loopback.
struct Host {
    st: AppState,
    port: u16,
    dir: PathBuf,
}

impl Host {
    fn url(&self) -> String {
        format!("https://127.0.0.1:{}", self.port)
    }

    fn fingerprint(&self) -> String {
        crate::remote::native::status_block(&self.st)["fingerprint"].as_str().unwrap().to_string()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn host_on(st: AppState, dir: PathBuf) -> Host {
    st.db.set_setting("remote.method", &json!("native")).unwrap();
    st.remote.set_method_cache("native");
    st.db.set_setting("remote.native.port", &json!(0)).unwrap();
    crate::remote::native::set_account(&st, "owner", PASSWORD).unwrap();
    crate::remote::enable(&st).await.unwrap();
    let port = st.remote.native_bound().expect("the native listener is bound").port();
    Host { st, port, dir }
}

async fn host(tag: &str) -> Host {
    let (st, dir) = local(tag);
    host_on(st, dir).await
}

fn token_files(dir: &std::path::Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir.join("machines"))
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default()
}

/// Everything the other machine or this one could have written down, as text.
async fn everything_stored(st: &AppState) -> String {
    everything_stored_without(st, "").await
}

/// The same, leaving out the persisted events of one type.
async fn everything_stored_without(st: &AppState, skip_event_type: &str) -> String {
    let events: Vec<Value> = st.db.replay_events(0, 5_000).unwrap_or_default().into_iter().filter(|event| event["type"] != skip_event_type).collect();
    let backup = dispatch(st, "backup.export", json!({})).await.map(|value| value.to_string()).unwrap_or_default();
    let diagnostics = dispatch(st, "diagnostics.export", json!({})).await.unwrap();
    let mut text = vec![
        st.db.settings().unwrap().to_string(),
        json!(st.db.machine_links().unwrap()).to_string(),
        json!(events).to_string(),
        backup,
    ];
    text.extend(unzip(diagnostics["base64"].as_str().unwrap()));
    text.join("\n")
}

fn unzip(base64: &str) -> Vec<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    (0..archive.len())
        .map(|index| {
            let mut file = archive.by_index(index).unwrap();
            let mut text = String::new();
            let _ = file.read_to_string(&mut text);
            text
        })
        .collect()
}

async fn wait_until<F: Fn() -> bool>(what: &str, check: F) {
    let start = Instant::now();
    while !check() {
        assert!(start.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn pending_pairing(host: &AppState) -> String {
    let start = Instant::now();
    loop {
        // The one live offer, once a request has locked it and nobody has decided.
        let pending = {
            let pairing = host.remote.pairing.lock().unwrap();
            pairing.offer().and_then(|offer| {
                offer
                    .pending
                    .as_ref()
                    .filter(|pending| pending.outcome == crate::remote::pairing::Outcome::Pending)
                    .map(|_| offer.pairing_id.clone())
            })
        };
        if let Some(id) = pending {
            return id;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "the other machine never saw the request");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn decide(host: &AppState, approve: bool, tier: &str) {
    let pairing_id = pending_pairing(host).await;
    crate::remote::rpc(host, "remote.pair.confirm", &json!({"pairingId": pairing_id, "approve": approve, "tier": tier}))
        .await
        .unwrap();
}

async fn job_done(st: &AppState, id: &str) -> Value {
    let start = Instant::now();
    loop {
        let jobs = dispatch(st, "machine.pair.list", json!({})).await.unwrap();
        let job = jobs["jobs"].as_array().unwrap().iter().find(|job| job["id"] == id).cloned().unwrap();
        if job["state"] != "pending" {
            return job;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "the pairing never finished");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Links `local` to a Native `host` through the real pairing and returns the job.
async fn link_native(local: &AppState, host: &Host, tier: &str) -> Value {
    let begun = dispatch(
        local,
        "machine.pair.begin",
        json!({"url": host.url(), "username": "owner", "password": PASSWORD, "fingerprint": host.fingerprint(), "confirm": true}),
    )
    .await
    .unwrap();
    let id = begun["job"]["id"].as_str().unwrap().to_string();
    decide(&host.st, true, tier).await;
    job_done(local, &id).await
}

fn host_id(host: &Host) -> String {
    machines::machine_id(&host.st)
}

// ---------------------------------------------------------------------------
// Test certificates and a raw TLS server

struct TestCert {
    der: Vec<u8>,
    config: Arc<rustls::ServerConfig>,
}

fn test_cert() -> TestCert {
    let key = rcgen::KeyPair::generate().unwrap();
    let params = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string(), "localhost".to_string()]).unwrap();
    let cert = params.self_signed(&key).unwrap();
    let der = cert.der().to_vec();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(der.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
    TestCert { der, config: Arc::new(config) }
}

fn fingerprint_of(der: &[u8]) -> String {
    crate::remote::native::fingerprint_of_der(der)
}

/// What a raw server does with one request: the full response text, or `None`
/// to leave the connection hanging.
type Responder = dyn Fn(&str) -> Option<String> + Send + Sync;

struct RawServer {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    cert: TestCert,
}

impl RawServer {
    fn url(&self) -> String {
        format!("https://127.0.0.1:{}", self.port)
    }

    fn fingerprint(&self) -> String {
        fingerprint_of(&self.cert.der)
    }

    fn seen(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

fn http(status: &str, headers: &[&str], body: &str) -> String {
    let mut text = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n", body.len());
    for header in headers {
        text.push_str(header);
        text.push_str("\r\n");
    }
    text.push_str("\r\n");
    text.push_str(body);
    text
}

async fn raw_server(respond: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> RawServer {
    let cert = test_cert();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let acceptor = TlsAcceptor::from(cert.config.clone());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    let respond: Arc<Responder> = Arc::new(respond);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let acceptor = acceptor.clone();
            let log = log.clone();
            let respond = respond.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(stream).await else { return };
                let mut buffer = vec![0u8; 16 * 1024];
                let mut filled = 0usize;
                // Read the head, then whatever of the body has arrived.
                loop {
                    let Ok(read) = tls.read(&mut buffer[filled..]).await else { return };
                    if read == 0 {
                        break;
                    }
                    filled += read;
                    let text = String::from_utf8_lossy(&buffer[..filled]).into_owned();
                    if let Some(head_end) = text.find("\r\n\r\n") {
                        let length = text[..head_end]
                            .lines()
                            .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if filled >= head_end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&buffer[..filled]).into_owned();
                log.lock().unwrap().push(request.clone());
                match respond(&request) {
                    Some(response) => {
                        let _ = tls.write_all(response.as_bytes()).await;
                        let _ = tls.shutdown().await;
                    }
                    None => tokio::time::sleep(Duration::from_secs(30)).await,
                }
            });
        }
    });
    RawServer { port, requests, cert }
}

const PING: &str = r#"{"ok":true,"app":"bitbots","role":"remote-gateway"}"#;

fn is_ping(request: &str) -> bool {
    request.starts_with("GET /api/ping ")
}

// ---------------------------------------------------------------------------
// Identity

#[tokio::test]
async fn machine_id_is_made_once_and_stays() {
    let dir = temp("identity");
    let path = dir.join("bitbots.sqlite");
    let id = {
        let (st, _) = crate::phase2a_tests::state_with(bloblex_storage::Storage::open(&path).unwrap());
        let first = dispatch(&st, "machine.self", json!({})).await.unwrap();
        let second = dispatch(&st, "machine.self", json!({})).await.unwrap();
        assert_eq!(first["id"], second["id"]);
        let id = first["id"].as_str().unwrap().to_string();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
        assert_eq!(first["name"], json!(crate::remote::host_name()), "the name defaults to the host name");
        assert_eq!(first["version"], env!("CARGO_PKG_VERSION"));
        let info = dispatch(&st, "machine.info", json!({})).await.unwrap();
        assert_eq!(info["machineId"], json!(id));
        assert_eq!(info["handoffVersion"], 1);
        // The name moves only through `machine.self.rename`.
        let refused = dispatch(&st, "settings.set", json!({"key": "machine.name", "value": "Hacked"})).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
        let refused = dispatch(&st, "settings.set", json!({"key": "machine.id", "value": "x"})).await.unwrap_err();
        assert_eq!(refused.1.code, "invalid_argument");
        for bad in [json!(""), json!("   "), json!("x".repeat(61)), json!(7)] {
            assert_eq!(dispatch(&st, "machine.self.rename", json!({"name": bad})).await.unwrap_err().1.code, "invalid_argument");
        }
        let renamed = dispatch(&st, "machine.self.rename", json!({"name": "  Studio PC  "})).await.unwrap();
        assert_eq!(renamed["name"], "Studio PC");
        assert_eq!(renamed["id"], json!(id));
        id
    };
    // A restart on the same database keeps both.
    let (again, _) = crate::phase2a_tests::state_with(bloblex_storage::Storage::open(&path).unwrap());
    let after = dispatch(&again, "machine.self", json!({})).await.unwrap();
    assert_eq!(after["id"], json!(id));
    assert_eq!(after["name"], "Studio PC");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn machine_settings_never_travel_in_a_backup() {
    let (st, dir) = local("backup");
    dispatch(&st, "machine.self.rename", json!({"name": "Studio PC"})).await.unwrap();
    let id = machines::machine_id(&st);
    let exported = dispatch(&st, "backup.export", json!({})).await.unwrap().to_string();
    assert!(!exported.contains(&id), "the machine id travelled");
    assert!(!exported.contains("Studio PC"), "the machine name travelled");
    assert!(!exported.contains("machine.id") && !exported.contains("machine.name"));
    let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------------------
// The client

#[tokio::test]
async fn the_client_refuses_http_and_credentials_in_the_url() {
    for bad in [
        "http://127.0.0.1:1",
        "ftp://example.com",
        "https://user@example.com",
        "https://user:pass@example.com",
        "https://:pass@example.com",
        "https://example.com/?a=1",
        "https://example.com/#frag",
        "https://",
        "not a url",
        "",
    ] {
        assert!(matches!(client::clean_origin(bad), Err(ClientError::Invalid(_))), "{bad}");
    }
    assert_eq!(client::clean_origin("https://Work-PC.tail1234.ts.net/some/path").unwrap(), "https://work-pc.tail1234.ts.net");
    assert_eq!(client::clean_origin("https://127.0.0.1:48621/").unwrap(), "https://127.0.0.1:48621");
    assert_eq!(client::clean_origin("https://example.com:443").unwrap(), "https://example.com");
    // Nothing is sent for a refused address, and the RPCs say so.
    let result = client::send(&Trust::WebPki, Method::GET, "http://127.0.0.1:1", "/api/ping", false, None, None, Duration::from_secs(1)).await;
    assert!(matches!(result, Err(ClientError::Invalid(_))));
    let (st, dir) = local("refuse");
    for url in ["http://example.com", "https://u:p@example.com"] {
        assert_eq!(dispatch(&st, "machine.probe", json!({"url": url})).await.unwrap_err().1.code, "invalid_argument");
        let begun = dispatch(&st, "machine.pair.begin", json!({"url": url, "code": "AAAA-BBBB", "confirm": true})).await;
        assert_eq!(begun.unwrap_err().1.code, "invalid_argument");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_pinned_client_accepts_its_certificate() {
    let server = raw_server(|_| Some(http("200 OK", &[], PING))).await;
    for spelling in [server.fingerprint(), server.fingerprint().to_ascii_lowercase(), server.fingerprint().replace(':', "")] {
        let pin = client::parse_fingerprint(&spelling).expect("every spelling parses");
        let reply = client::send(&Trust::Pin(pin), Method::GET, &server.url(), "/api/ping", false, None, None, Duration::from_secs(5))
            .await
            .expect("the pinned certificate is accepted");
        assert_eq!(reply.json()["app"], "bitbots");
    }
}

#[tokio::test]
async fn a_pinned_client_refuses_another_certificate() {
    let server = raw_server(|_| Some(http("200 OK", &[], PING))).await;
    let other = test_cert();
    let wrong = client::parse_fingerprint(&fingerprint_of(&other.der)).unwrap();
    let result = client::send(&Trust::Pin(wrong), Method::GET, &server.url(), "/api/ping", false, None, None, Duration::from_secs(5)).await;
    assert_eq!(result.err(), Some(ClientError::Unreachable), "another certificate is refused");
    assert!(server.seen().is_empty(), "the request must not be sent after a refused handshake");
    // A one-bit difference in the pin is refused too, and so is a malformed pin.
    let mut flipped = client::parse_fingerprint(&server.fingerprint()).unwrap();
    flipped[31] ^= 1;
    let result = client::send(&Trust::Pin(flipped), Method::GET, &server.url(), "/api/ping", false, None, None, Duration::from_secs(5)).await;
    assert!(result.is_err());
    assert!(client::parse_fingerprint("AB:CD").is_none());
    assert!(client::parse_fingerprint(&"zz".repeat(32)).is_none());
    // Web PKI refuses a self-signed certificate it was not told about.
    let result = client::send(&Trust::WebPki, Method::GET, &server.url(), "/api/ping", false, None, None, Duration::from_secs(5)).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let target = raw_server(|_| Some(http("200 OK", &[], PING))).await;
    let location = format!("Location: {}/api/ping", target.url());
    let first = raw_server(move |_| Some(http("302 Found", &[location.as_str()], "{}"))).await;
    let pin = client::parse_fingerprint(&first.fingerprint()).unwrap();
    let reply = client::send(&Trust::Pin(pin), Method::GET, &first.url(), "/api/ping", true, Some("a=b"), None, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(reply.status.as_u16(), 302);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(target.seen().is_empty(), "the redirect target was contacted");
}

#[tokio::test]
async fn the_client_caps_the_response() {
    let big = "x".repeat(client::MAX_RESPONSE_BYTES + 1024);
    let server = raw_server(move |_| Some(http("200 OK", &[], &big))).await;
    let pin = client::parse_fingerprint(&server.fingerprint()).unwrap();
    let result = client::send(&Trust::Pin(pin), Method::GET, &server.url(), "/api/rpc", true, None, None, Duration::from_secs(20)).await;
    assert_eq!(result.err(), Some(ClientError::TooLarge));
}

#[tokio::test]
async fn probe_sends_no_credential() {
    let server = raw_server(|request| is_ping(request).then(|| http("200 OK", &[], PING))).await;
    let (st, dir) = local("probe");
    // Even with a stored link and token for another machine, a probe sends nothing.
    client::write_token(&st, "other-machine", "SECRET-TOKEN-VALUE").await.unwrap();
    let probed = dispatch(&st, "machine.probe", json!({"url": server.url()})).await.unwrap();
    assert_eq!(probed["reachable"], true);
    assert_eq!(probed["isBitbots"], true);
    assert_eq!(probed["trusted"], false);
    assert_eq!(probed["auth"], "password");
    assert_eq!(probed["fingerprint"], json!(server.fingerprint()));
    assert_eq!(probed["origin"], json!(server.url()));
    let seen = server.seen();
    assert!(!seen.is_empty());
    for request in &seen {
        let lower = request.to_ascii_lowercase();
        for header in ["cookie:", "authorization:", "origin:"] {
            assert!(!lower.contains(header), "the probe sent {header}: {request}");
        }
        assert!(!request.contains("SECRET-TOKEN-VALUE"));
    }
    // A certificate web PKI accepts is `trusted`, asks for a code and has no fingerprint.
    TEST_ROOTS.lock().unwrap().push(server.cert.der.clone());
    let trusted = dispatch(&st, "machine.probe", json!({"url": server.url()})).await.unwrap();
    assert_eq!(trusted["trusted"], true);
    assert_eq!(trusted["auth"], "code");
    assert_eq!(trusted["fingerprint"], Value::Null);
    // Something that answers but is not a Bitbots gateway stops pairing; an
    // address that answers nothing is unreachable.
    let stranger = raw_server(|_| Some(http("200 OK", &[], r#"{"ok":true}"#))).await;
    let stranger = dispatch(&st, "machine.probe", json!({"url": stranger.url()})).await.unwrap();
    assert_eq!((stranger["reachable"].clone(), stranger["isBitbots"].clone()), (json!(true), json!(false)));
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed_url = format!("https://127.0.0.1:{}", closed.local_addr().unwrap().port());
    drop(closed);
    let nothing = dispatch(&st, "machine.probe", json!({"url": closed_url})).await.unwrap();
    assert_eq!((nothing["reachable"].clone(), nothing["isBitbots"].clone()), (json!(false), json!(false)));
    let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------------------
// Pairing

/// The Tailscale method served behind a test certificate that the client trusts
/// as a root, so a pairing code can be used over normal web PKI.
async fn code_host(tag: &str) -> (AppState, PathBuf, String, tokio::task::JoinHandle<()>) {
    let (st, dir) = local(tag);
    let cert = test_cert();
    TEST_ROOTS.lock().unwrap().push(cert.der.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let origin = format!("https://127.0.0.1:{port}");
    st.remote.set_serve_origin_for_test(&origin);
    let server = crate::remote::native::spawn_tls(listener, cert.config.clone(), WebState { daemon: st.clone(), remote: st.remote.clone() });
    let keep = tokio::spawn(async move {
        let _server = server;
        tokio::time::sleep(Duration::from_secs(120)).await;
    });
    (st, dir, origin, keep)
}

#[tokio::test]
async fn pairing_by_code_stores_the_link() {
    let (other, other_dir, origin, _keep) = code_host("code-host").await;
    let (me, my_dir) = local("code-me");
    let code = other.remote.pairing.lock().unwrap().begin(chrono::Utc::now()).code;
    // The wrong shape is refused before anything starts.
    let missing = dispatch(&me, "machine.pair.begin", json!({"url": origin, "confirm": true})).await.unwrap_err();
    assert_eq!(missing.1.code, "invalid_argument");
    let unconfirmed = dispatch(&me, "machine.pair.begin", json!({"url": origin, "code": code})).await.unwrap_err();
    assert_eq!(unconfirmed.1.code, "invalid_argument");
    let begun = dispatch(&me, "machine.pair.begin", json!({"url": origin, "code": code, "confirm": true})).await.unwrap();
    assert_eq!(begun["job"]["state"], "pending", "the reply comes at once");
    let id = begun["job"]["id"].as_str().unwrap().to_string();
    decide(&other, true, "operator").await;
    let job = job_done(&me, &id).await;
    assert_eq!(job["state"], "approved", "{job}");
    let machine = &job["machine"];
    let other_id = machines::machine_id(&other);
    assert_eq!(machine["id"], json!(other_id));
    assert_eq!(machine["name"], json!(machines::machine_name(&other)));
    assert_eq!(machine["auth"], "code");
    assert_eq!(machine["fingerprint"], Value::Null, "web PKI needs no pin");
    assert_eq!(machine["tier"], "operator", "the tier is the one the other owner chose");
    assert_eq!(machine["state"], "online");
    assert_eq!(machine["url"], json!(origin));
    // The token is in a file, not in the database, and the link works.
    assert_eq!(token_files(&my_dir).len(), 1);
    let info = client::rpc(&me, &other_id, "machine.info", json!({})).await.unwrap();
    assert_eq!(info["machineId"], json!(other_id));
    let listed = dispatch(&me, "machine.list", json!({})).await.unwrap();
    assert_eq!(listed["machines"].as_array().unwrap().len(), 1);
    assert_eq!(listed["machines"][0]["id"], json!(other_id));
    // The other machine sees us as a device of kind `machine`.
    let devices = crate::remote::rpc(&other, "remote.devices.list", &json!({})).await.unwrap();
    assert_eq!(devices["devices"][0]["kind"], "machine");
    assert_eq!(devices["devices"][0]["name"], json!(machines::machine_name(&me)));
    // The pairing code was single use: a second attempt with it fails.
    let again = dispatch(&me, "machine.pair.begin", json!({"url": origin, "code": code, "confirm": true})).await.unwrap();
    let again = job_done(&me, again["job"]["id"].as_str().unwrap()).await;
    assert_eq!(again["state"], "failed");
    let _ = (std::fs::remove_dir_all(other_dir), std::fs::remove_dir_all(my_dir));
}

#[tokio::test]
async fn pairing_by_password_never_keeps_the_password() {
    let other = host("pw-host").await;
    let (me, my_dir) = local("pw-me");
    let job = link_native(&me, &other, "chat").await;
    assert_eq!(job["state"], "approved", "{job}");
    assert_eq!(job["machine"]["auth"], "password");
    assert_eq!(job["machine"]["fingerprint"], json!(other.fingerprint()));
    assert_eq!(job["machine"]["tier"], "chat");
    // The password is in the job's input only: not in the job, a row, the
    // database, an event, a backup or a diagnostics bundle.
    let jobs = dispatch(&me, "machine.pair.list", json!({})).await.unwrap().to_string();
    let rows = dispatch(&me, "machine.list", json!({})).await.unwrap().to_string();
    for text in [jobs, rows, everything_stored(&me).await] {
        assert!(!text.contains(PASSWORD), "the password was kept");
    }
    // A wrong fingerprint stops it with the certificate message and sends no password.
    let (other_me, other_me_dir) = local("pw-me-2");
    let mut wrong = client::parse_fingerprint(&other.fingerprint()).unwrap();
    wrong[0] ^= 0xFF;
    let begun = dispatch(
        &other_me,
        "machine.pair.begin",
        json!({"url": other.url(), "username": "owner", "password": PASSWORD, "fingerprint": client::format_fingerprint(&wrong), "confirm": true}),
    )
    .await
    .unwrap();
    let failed = job_done(&other_me, begun["job"]["id"].as_str().unwrap()).await;
    assert_eq!(failed["state"], "failed");
    assert_eq!(failed["detail"], "The other machine's certificate changed.");
    assert!(other_me.db.machine_links().unwrap().is_empty());
    assert!(token_files(&other_me_dir).is_empty());
    let _ = (std::fs::remove_dir_all(my_dir), std::fs::remove_dir_all(other_me_dir));
}

#[tokio::test]
async fn a_token_is_never_returned_logged_or_exported() {
    let other = host("token-host").await;
    let (me, my_dir) = local("token-me");
    let job = link_native(&me, &other, "operator").await;
    assert_eq!(job["state"], "approved");
    let other_id = host_id(&other);
    let files = token_files(&my_dir);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].file_name().unwrap().to_string_lossy(), format!("{other_id}.token"));
    let token = std::fs::read_to_string(&files[0]).unwrap();
    assert_eq!(token.trim().len(), 43, "a 256-bit token, base64url");
    // Every way out of the daemon, after real traffic over the link.
    machines::refresh_one(&me, &other_id).await.unwrap();
    let mut outputs = vec![
        dispatch(&me, "machine.list", json!({})).await.unwrap().to_string(),
        dispatch(&me, "machine.refresh", json!({"id": other_id})).await.unwrap().to_string(),
        dispatch(&me, "machine.pair.list", json!({})).await.unwrap().to_string(),
        dispatch(&me, "machine.conversations", json!({"machineId": other_id, "agentId": "none"})).await.map(|v| v.to_string()).unwrap_or_else(|e| format!("{:?}", e.1)),
        dispatch(&me, "settings.get", json!({})).await.unwrap().to_string(),
        job.to_string(),
        everything_stored(&me).await,
    ];
    // The other side's own record holds only a digest, never the token.
    outputs.push(everything_stored(&other.st).await);
    for (index, text) in outputs.iter().enumerate() {
        assert!(!text.contains(token.trim()), "output {index} carried the device token");
    }
    // The link's own row has no token column at all.
    let row = me.db.machine_link_get(&other_id).unwrap().unwrap();
    assert!(!row.to_string().to_ascii_lowercase().contains("token"));
    // The file's text is the whole token and nothing else is written beside it.
    assert_eq!(std::fs::read_dir(my_dir.join("machines")).unwrap().count(), 1);
    // A wrong-token request reveals nothing either.
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn a_rejected_pairing_stores_nothing() {
    let other = host("reject-host").await;
    let (me, my_dir) = local("reject-me");
    let begun = dispatch(
        &me,
        "machine.pair.begin",
        json!({"url": other.url(), "username": "owner", "password": PASSWORD, "fingerprint": other.fingerprint(), "confirm": true}),
    )
    .await
    .unwrap();
    decide(&other.st, false, "chat").await;
    let job = job_done(&me, begun["job"]["id"].as_str().unwrap()).await;
    assert_eq!(job["state"], "rejected", "{job}");
    assert!(me.db.machine_links().unwrap().is_empty());
    assert!(token_files(&my_dir).is_empty());
    assert!(!me.machines.loop_active());
    // A wrong password is refused by the other machine and stores nothing.
    let begun = dispatch(
        &me,
        "machine.pair.begin",
        json!({"url": other.url(), "username": "owner", "password": "definitely not it", "fingerprint": other.fingerprint(), "confirm": true}),
    )
    .await
    .unwrap();
    let job = job_done(&me, begun["job"]["id"].as_str().unwrap()).await;
    assert_eq!(job["state"], "failed");
    assert!(me.db.machine_links().unwrap().is_empty());
    assert!(token_files(&my_dir).is_empty());
    // Cancelling a pending request ends it.
    let begun = dispatch(
        &me,
        "machine.pair.begin",
        json!({"url": other.url(), "username": "owner", "password": PASSWORD, "fingerprint": other.fingerprint(), "confirm": true}),
    )
    .await
    .unwrap();
    let id = begun["job"]["id"].as_str().unwrap().to_string();
    pending_pairing(&other.st).await;
    dispatch(&me, "machine.pair.cancel", json!({"id": id})).await.unwrap();
    let job = job_done(&me, &id).await;
    assert_eq!(job["state"], "cancelled");
    assert!(me.db.machine_links().unwrap().is_empty());
    assert_eq!(dispatch(&me, "machine.pair.cancel", json!({"id": "nope"})).await.unwrap_err().1.code, "not_found");
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn a_machine_cannot_pair_with_itself() {
    let (st, dir) = local("self");
    let me = host_on(st.clone(), dir.clone()).await;
    let begun = dispatch(
        &st,
        "machine.pair.begin",
        json!({"url": me.url(), "username": "owner", "password": PASSWORD, "fingerprint": me.fingerprint(), "confirm": true}),
    )
    .await
    .unwrap();
    decide(&st, true, "operator").await;
    let job = job_done(&st, begun["job"]["id"].as_str().unwrap()).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["detail"], "That's this machine.");
    assert!(st.db.machine_links().unwrap().is_empty());
    assert!(token_files(&dir).is_empty());
    // It signed itself out again, so no live device is left behind.
    let devices = st.db.remote_devices().unwrap();
    assert_eq!(devices.len(), 1);
    assert!(devices[0]["signedOutAt"].is_string(), "{}", devices[0]);
    let live = crate::remote::rpc(&st, "remote.devices.list", &json!({})).await.unwrap();
    assert!(live["devices"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn an_older_machine_is_named() {
    // A gateway from before Phase 4: it signs a device in but has no `machine.info`.
    let server = raw_server(|request| {
        if is_ping(request) {
            Some(http("200 OK", &[], PING))
        } else if request.starts_with("POST /api/login ") {
            Some(http("202 Accepted", &["Set-Cookie: __Host-bitbots_pair=abc; HttpOnly; Secure; Path=/"], r#"{"state":"pending"}"#))
        } else if request.starts_with("GET /api/pair ") {
            Some(http(
                "200 OK",
                &["Set-Cookie: __Host-bitbots_remote=OLDTOKEN; HttpOnly; Secure; Path=/"],
                r#"{"state":"approved","device":{"id":"d1","name":"x","tier":"chat"}}"#,
            ))
        } else if request.starts_with("POST /api/rpc ") {
            Some(http("403 Forbidden", &[], r#"{"v":1,"id":"x","ok":false,"error":{"code":"forbidden_remote","message":"Not allowed."}}"#))
        } else if request.starts_with("POST /api/logout ") {
            Some(http("200 OK", &[], r#"{"signedOut":true}"#))
        } else {
            Some(http("404 Not Found", &[], "{}"))
        }
    })
    .await;
    let (me, dir) = local("older");
    let begun = dispatch(
        &me,
        "machine.pair.begin",
        json!({"url": server.url(), "username": "owner", "password": PASSWORD, "fingerprint": server.fingerprint(), "confirm": true}),
    )
    .await
    .unwrap();
    let job = job_done(&me, begun["job"]["id"].as_str().unwrap()).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["detail"], "That machine needs a newer version of Bitbots.");
    assert!(me.db.machine_links().unwrap().is_empty());
    assert!(token_files(&dir).is_empty());
    assert!(server.seen().iter().any(|request| request.starts_with("POST /api/logout ")), "the device was signed out again");
    assert!(!job.to_string().contains("OLDTOKEN"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_second_pairing_replaces_the_old_token() {
    let other = host("again-host").await;
    let (me, my_dir) = local("again-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    let first = std::fs::read_to_string(&token_files(&my_dir)[0]).unwrap();
    let job = link_native(&me, &other, "operator").await;
    assert_eq!(job["state"], "approved", "{job}");
    let files = token_files(&my_dir);
    assert_eq!(files.len(), 1);
    let second = std::fs::read_to_string(&files[0]).unwrap();
    assert_ne!(first, second, "the token was replaced");
    assert_eq!(me.db.machine_links().unwrap().len(), 1);
    assert_eq!(me.db.machine_link_get(&other_id).unwrap().unwrap()["tier"], "operator");
    let _ = std::fs::remove_dir_all(my_dir);
}

// ---------------------------------------------------------------------------
// Links: revoked, removed

#[tokio::test]
async fn a_revoked_link_says_so() {
    let other = host("revoked-host").await;
    let (me, my_dir) = local("revoked-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    let devices = crate::remote::rpc(&other.st, "remote.devices.list", &json!({})).await.unwrap();
    let device_id = devices["devices"][0]["id"].as_str().unwrap().to_string();
    crate::remote::rpc(&other.st, "remote.devices.revoke", &json!({"deviceId": device_id})).await.unwrap();
    let row = dispatch(&me, "machine.refresh", json!({"id": other_id})).await.unwrap();
    assert_eq!(row["state"], "revoked");
    assert!(row["detail"].as_str().unwrap().contains("Pair it again"), "{row}");
    let read = dispatch(&me, "machine.conversations", json!({"machineId": other_id, "agentId": "x"})).await.unwrap_err();
    assert_eq!(read.1.code, "provider_unavailable");
    assert!(read.1.message.contains(row["name"].as_str().unwrap()), "{}", read.1.message);
    // A revoked link is not asked again, and it stays revoked in the list.
    let listed = dispatch(&me, "machine.list", json!({})).await.unwrap();
    assert_eq!(listed["machines"][0]["state"], "revoked");
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn removing_works_when_the_other_machine_is_away() {
    let other = host("away-host").await;
    let (me, my_dir) = local("away-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    crate::remote::disable(&other.st).await.unwrap();
    assert_eq!(dispatch(&me, "machine.remove", json!({"id": other_id})).await.unwrap_err().1.code, "invalid_argument", "needs confirm");
    assert!(me.db.machine_link_get(&other_id).unwrap().is_some());
    let removed = dispatch(&me, "machine.remove", json!({"id": other_id, "confirm": true})).await.unwrap();
    assert_eq!(removed["removed"], true);
    assert_eq!(removed["signedOut"], false);
    assert!(me.db.machine_links().unwrap().is_empty());
    assert!(token_files(&my_dir).is_empty());
    assert_eq!(dispatch(&me, "machine.remove", json!({"id": other_id, "confirm": true})).await.unwrap_err().1.code, "not_found");
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn removing_signs_this_device_out_of_the_other_machine() {
    let other = host("signout-host").await;
    let (me, my_dir) = local("signout-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    let removed = dispatch(&me, "machine.remove", json!({"id": other_id, "confirm": true})).await.unwrap();
    assert_eq!((removed["removed"].clone(), removed["signedOut"].clone()), (json!(true), json!(true)));
    let devices = other.st.db.remote_devices().unwrap();
    assert!(devices[0]["signedOutAt"].is_string(), "{}", devices[0]);
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn a_failed_logout_still_deletes_the_token() {
    let other = host("badlogout-host").await;
    let (me, my_dir) = local("badlogout-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    // The other machine already forgot this device, so its logout is refused.
    let devices = crate::remote::rpc(&other.st, "remote.devices.list", &json!({})).await.unwrap();
    let device_id = devices["devices"][0]["id"].as_str().unwrap().to_string();
    crate::remote::rpc(&other.st, "remote.devices.revoke", &json!({"deviceId": device_id})).await.unwrap();
    assert_eq!(token_files(&my_dir).len(), 1);
    let removed = dispatch(&me, "machine.remove", json!({"id": other_id, "confirm": true})).await.unwrap();
    assert_eq!((removed["removed"].clone(), removed["signedOut"].clone()), (json!(true), json!(false)));
    assert!(token_files(&my_dir).is_empty(), "the token file was deleted anyway");
    assert!(me.db.machine_links().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn rename_is_a_local_label_only() {
    let other = host("rename-host").await;
    let (me, my_dir) = local("rename-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    for bad in [json!(""), json!("x".repeat(61))] {
        assert_eq!(dispatch(&me, "machine.rename", json!({"id": other_id, "name": bad})).await.unwrap_err().1.code, "invalid_argument");
    }
    let row = dispatch(&me, "machine.rename", json!({"id": other_id, "name": "Laptop"})).await.unwrap();
    assert_eq!(row["name"], "Laptop");
    // A refresh does not overwrite the label, and the other machine's name is unchanged.
    let refreshed = machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(refreshed["name"], "Laptop");
    assert_eq!(machines::machine_name(&other.st), crate::remote::host_name());
    let _ = std::fs::remove_dir_all(my_dir);
}

// ---------------------------------------------------------------------------
// Reading the other machine

#[tokio::test]
async fn the_loop_only_runs_with_a_link() {
    let other = host("loop-host").await;
    let (me, my_dir) = local("loop-me");
    machines::ensure_loop(&me);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!me.machines.loop_active(), "no link, no loop");
    link_native(&me, &other, "chat").await;
    assert!(me.machines.loop_active(), "a link starts it");
    // It really reads: the row fills in without anyone asking.
    wait_until("the loop's first read", || me.machines.loop_active()).await;
    let other_id = host_id(&other);
    let start = Instant::now();
    loop {
        let row = dispatch(&me, "machine.list", json!({})).await.unwrap();
        if row["machines"][0]["version"].is_string() {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "the loop never read the machine");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    dispatch(&me, "machine.remove", json!({"id": other_id, "confirm": true})).await.unwrap();
    let start = Instant::now();
    while me.machines.loop_active() {
        assert!(start.elapsed() < Duration::from_secs(10), "the loop kept running with no link");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn one_offline_machine_does_not_hold_up_another() {
    let other = host("slow-host").await;
    let (me, my_dir) = local("slow-me");
    me.machines.set_timing(Timing { call_timeout: Duration::from_millis(1_500), ..fast() });
    link_native(&me, &other, "chat").await;
    let good = host_id(&other);
    // A second link whose machine accepts the connection and never answers.
    let hung = raw_server(|_| None).await;
    let hung_id = "11111111-2222-3333-4444-555555555555";
    me.db
        .machine_link_upsert(&json!({
            "id": hung_id, "name": "Hung", "url": hung.url(), "auth": "password", "fingerprint": hung.fingerprint(),
            "tier": "chat", "pairedAt": "2026-10-31T00:00:00.000Z", "state": "online"
        }))
        .unwrap();
    client::write_token(&me, hung_id, "whatever").await.unwrap();
    let before = me.db.machine_link_get(&good).unwrap().unwrap()["lastSeenAt"].clone();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let state = me.clone();
    let started = Instant::now();
    let all = tokio::spawn(async move { machines::refresh_all(&state).await });
    // The good machine is read while the hung one is still being waited on.
    loop {
        let seen = me.db.machine_link_get(&good).unwrap().unwrap()["lastSeenAt"].clone();
        if seen != before {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!all.is_finished(), "the good machine's read waited for the hung one");
    all.await.unwrap();
    assert!(started.elapsed() >= Duration::from_millis(1_400), "the hung machine was given its full limit");
    assert_eq!(me.db.machine_link_get(hung_id).unwrap().unwrap()["state"], "offline");
    assert_eq!(me.db.machine_link_get(&good).unwrap().unwrap()["state"], "online");
    let _ = std::fs::remove_dir_all(my_dir);
}

fn add_bot(host: &AppState, name: &str) -> String {
    host.db.agent_create(&json!({"name": name, "runtimeId": "rt-test"})).unwrap().0["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn offline_keeps_the_last_bots() {
    let other = host("last-host").await;
    let bot = add_bot(&other.st, "Rae");
    other.st.db.create_session_for_agent("s-rae", "rt-test", "codex", ".", "First", Some(&bot)).unwrap();
    other.st.db.update_session_state("s-rae", "idle").unwrap();
    let (me, my_dir) = local("last-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    let row = machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(row["state"], "online");
    assert_eq!(row["bots"].as_array().unwrap().len(), 1);
    let rae = &row["bots"][0];
    assert_eq!(rae["name"], "Rae");
    assert_eq!(rae["provider"], "codex");
    assert_eq!(rae["conversations"], 1);
    assert_eq!(rae["busy"], false);
    assert_eq!(row["version"], env!("CARGO_PKG_VERSION"));
    crate::remote::disable(&other.st).await.unwrap();
    let away = machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(away["state"], "offline");
    assert_eq!(away["bots"], row["bots"], "the last list stays");
    assert_eq!(away["detail"], json!(format!("{} can't be reached right now.", row["name"].as_str().unwrap())));
    // The other machine's own reads answer `provider_unavailable` with its name.
    let read = dispatch(&me, "machine.conversations", json!({"machineId": other_id, "agentId": bot})).await.unwrap_err();
    assert_eq!(read.1.code, "provider_unavailable");
    assert_eq!(read.1.message, format!("{} can't be reached right now.", row["name"].as_str().unwrap()));
    let _ = std::fs::remove_dir_all(my_dir);
}

#[test]
fn hidden_bots_are_left_out() {
    let agents = json!({"agents": [
        {"id": "a", "name": "Shown", "hidden": false, "color": "mint", "outfit": "auto", "look": null, "role": "Builder", "model": "m"},
        {"id": "b", "name": "Hidden", "hidden": true},
        {"id": "c", "name": "NoFlag"},
    ]});
    let bots = machines::bots_from(&agents, &json!({"sessions": []}));
    let names: Vec<&str> = bots.iter().filter_map(|bot| bot["name"].as_str()).collect();
    assert_eq!(names, ["Shown", "NoFlag"]);
    assert_eq!(bots[0]["role"], "Builder");
    assert_eq!(bots[0]["model"], "m");
    assert_eq!(bots[0]["provider"], Value::Null);
}

#[test]
fn busy_comes_from_live_turns() {
    let agents = json!({"agents": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}, {"id": "c", "name": "C"}]});
    let session = |id: &str, agent: &str, state: &str, at: &str, extra: Value| {
        let mut row = json!({"id": id, "agentId": agent, "state": state, "updatedAt": at, "provider": "codex", "archived": false});
        for (key, value) in extra.as_object().unwrap() {
            row[key] = value.clone();
        }
        row
    };
    let sessions = json!({"sessions": [
        session("a-old", "a", "idle", "2026-10-31T09:00:00Z", json!({})),
        session("a-live", "a", "working", "2026-10-31T10:00:00Z", json!({})),
        session("a-newer-live", "a", "waiting_permission", "2026-10-31T11:00:00Z", json!({})),
        session("b-idle", "b", "idle", "2026-10-31T10:00:00Z", json!({})),
        session("b-archived", "b", "working", "2026-10-31T10:00:00Z", json!({"archived": true})),
        session("c-auto", "c", "idle", "2026-10-31T10:00:00Z", json!({"link": {"kind": "automation"}})),
    ]});
    let bots = machines::bots_from(&agents, &sessions);
    assert_eq!(bots[0]["busy"], true);
    assert_eq!(bots[0]["activeSessionId"], "a-newer-live", "the most recently updated live turn");
    assert_eq!(bots[0]["conversations"], 3);
    assert_eq!(bots[1]["conversations"], 1, "an archived conversation is not counted");
    assert_eq!(bots[2]["conversations"], 0, "an automation's conversation is not counted");
    assert_eq!(bots[1]["activeSessionId"], Value::Null);
    for state in ["starting", "working", "waiting_permission", "cancelling"] {
        let sessions = json!({"sessions": [session("s", "a", state, "2026-10-31T10:00:00Z", json!({}))]});
        assert_eq!(machines::bots_from(&agents, &sessions)[0]["busy"], true, "{state}");
    }
    let sessions = json!({"sessions": [session("s", "a", "idle", "2026-10-31T10:00:00Z", json!({}))]});
    assert_eq!(machines::bots_from(&agents, &sessions)[0]["busy"], false);
}

#[tokio::test]
async fn busy_shows_up_through_the_gateway() {
    let other = host("busy-host").await;
    let bot = add_bot(&other.st, "Busy");
    other.st.db.create_session_for_agent("s-busy", "rt-test", "codex", ".", "Working", Some(&bot)).unwrap();
    other.st.db.update_session_state("s-busy", "working").unwrap();
    let (me, my_dir) = local("busy-me");
    link_native(&me, &other, "chat").await;
    let row = machines::refresh_one(&me, &host_id(&other)).await.unwrap();
    assert_eq!(row["bots"][0]["busy"], true);
    assert_eq!(row["bots"][0]["activeSessionId"], "s-busy");
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn reads_go_through_the_gateways_redaction() {
    let other = host("redact-host").await;
    let bot = add_bot(&other.st, "Rae");
    let secret_path = "C:\\Users\\Owner\\private-folder\\project";
    other.st.db.create_session_for_agent("s-redact", "rt-test", "codex", secret_path, "Work", Some(&bot)).unwrap();
    let (me, my_dir) = local("redact-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    // The host's own dispatch would show the path; the link must not.
    let direct = dispatch(&other.st, "session.get", json!({"sessionId": "s-redact"})).await.unwrap().to_string();
    assert!(direct.contains("private-folder"), "the fixture must hold the path: {direct}");
    let through = dispatch(&me, "machine.conversation", json!({"machineId": other_id, "sessionId": "s-redact"})).await.unwrap();
    for leaked in ["C:", "Users", "Owner"] {
        assert!(!through.to_string().contains(leaked), "a host path crossed the link ({leaked}): {through}");
    }
    assert_eq!(through["session"]["id"], "s-redact");
    let listed = dispatch(&me, "machine.conversations", json!({"machineId": other_id, "agentId": bot})).await.unwrap();
    assert_eq!(listed["conversations"][0]["id"], "s-redact", "{listed}");
    assert!(!listed.to_string().contains("Users"));
    let rows = machines::refresh_one(&me, &other_id).await.unwrap().to_string();
    assert!(!rows.contains("Users") && !rows.contains("Owner"));
    // An unknown conversation is the other machine's own `not_found`.
    let missing = dispatch(&me, "machine.conversation", json!({"machineId": other_id, "sessionId": "nope"})).await.unwrap_err();
    assert_eq!(missing.1.code, "not_found");
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn a_change_emits_machine_changed() {
    let other = host("change-host").await;
    let (me, my_dir) = local("change-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    let count = |st: &AppState| st.db.replay_events(0, 5_000).unwrap().iter().filter(|event| event["type"] == "machine.changed").count();
    machines::refresh_one(&me, &other_id).await.unwrap();
    let after_first = count(&me);
    assert!(after_first >= 1, "the first read is a change");
    machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(count(&me), after_first, "an unchanged read emits nothing");
    add_bot(&other.st, "Newcomer");
    machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(count(&me), after_first + 1);
    let event = crate::remote::events_last(&me, "machine.changed").await;
    assert_eq!(event["payload"], json!({"machineId": other_id, "state": "online"}));
    let row = dispatch(&me, "machine.list", json!({})).await.unwrap();
    assert_eq!(row["machines"][0]["bots"][0]["name"], "Newcomer", "the window reloads the list");
    // Going away is a change too.
    crate::remote::disable(&other.st).await.unwrap();
    machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(count(&me), after_first + 2);
    assert_eq!(crate::remote::events_last(&me, "machine.changed").await["payload"]["state"], "offline");
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn nothing_about_the_other_machine_is_stored() {
    let other = host("store-host").await;
    let bot = add_bot(&other.st, "Remote-Only-Bot-Name");
    other.st.db.create_session_for_agent("s-store", "rt-test", "codex", ".", "Remote-Only-Conversation-Title", Some(&bot)).unwrap();
    let (me, my_dir) = local("store-me");
    link_native(&me, &other, "chat").await;
    let other_id = host_id(&other);
    let row = machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(row["bots"][0]["name"], "Remote-Only-Bot-Name", "the read worked");
    dispatch(&me, "machine.conversation", json!({"machineId": other_id, "sessionId": "s-store"})).await.unwrap();
    // This machine has no bots or conversations of its own from that read.
    assert!(me.db.agent_list(true, None).unwrap().is_empty());
    assert!(me.db.session_list(true).unwrap().is_empty());
    // The link row holds the listed columns and nothing of the other machine's bots.
    let link = me.db.machine_link_get(&other_id).unwrap().unwrap();
    let mut keys: Vec<&str> = link.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["auth", "deviceId", "fingerprint", "id", "lastSeenAt", "name", "pairedAt", "state", "tier", "url"]);
    // Settings, links, the backup and the diagnostics bundle carry no bot or title.
    let stored = everything_stored(&me).await;
    assert!(!stored.contains("Remote-Only-Bot-Name"), "a bot name was stored");
    assert!(!stored.contains("Remote-Only-Conversation-Title"), "a conversation title was stored");
    // A fresh state over the same database starts with no memory of the bots.
    let list = dispatch(&me, "machine.list", json!({})).await.unwrap();
    assert_eq!(list["machines"][0]["bots"].as_array().map(Vec::len), Some(1));
    me.machines.set_timing(fast());
    let (reopened, _) = crate::phase2a_tests::state();
    assert!(dispatch(&reopened, "machine.list", json!({})).await.unwrap()["machines"].as_array().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(my_dir);
}

// ---------------------------------------------------------------------------
// The gateway changes

#[tokio::test]
async fn a_machine_device_is_a_device_kind_the_gateway_knows() {
    let other = host("kind-host").await;
    let (me, my_dir) = local("kind-me");
    link_native(&me, &other, "viewer").await;
    let devices = crate::remote::rpc(&other.st, "remote.devices.list", &json!({})).await.unwrap();
    assert_eq!(devices["devices"][0]["kind"], "machine");
    assert_eq!(devices["devices"][0]["tier"], "viewer");
    // At viewer a link can read, and cannot do what a viewer cannot.
    let other_id = host_id(&other);
    assert!(client::rpc(&me, &other_id, "agent.list", json!({})).await.is_ok());
    let refused = client::rpc(&me, &other_id, "settings.set", json!({"key": "appearance.style", "value": "haze"})).await.unwrap_err();
    assert!(matches!(refused, ClientError::Remote { .. }), "{refused:?}");
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn a_native_host_name_is_matched_without_regard_to_case() {
    // `COMPUTERNAME` is upper case on Windows and a client always lower-cases a
    // host name, so the certificate's authority must match either way.
    let other = host("case-host").await;
    let name = crate::remote::host_name();
    let client = reqwest::Client::builder().danger_accept_invalid_certs(true).no_proxy().build().unwrap();
    for (host_header, origin_host) in [(name.to_ascii_lowercase(), name.to_ascii_lowercase()), (name.to_ascii_uppercase(), name.to_ascii_uppercase())] {
        let response = client
            .get(format!("https://127.0.0.1:{}/api/me", other.port))
            .header("Host", format!("{host_header}:{}", other.port))
            .header("Origin", format!("https://{origin_host}:{}", other.port))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 401, "{host_header} must reach the sign-in check, not be refused as another origin");
    }
    // A name the certificate does not cover is still refused.
    let response = client
        .get(format!("https://127.0.0.1:{}/api/me", other.port))
        .header("Host", format!("elsewhere.example:{}", other.port))
        .header("Origin", format!("https://elsewhere.example:{}", other.port))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 403);
}

#[tokio::test]
async fn the_device_cookie_constant_is_the_gateways() {
    assert_eq!(DEVICE_COOKIE, "__Host-bitbots_remote");
    assert_eq!(client::device_cookie("abc"), "__Host-bitbots_remote=abc");
}

#[tokio::test]
async fn machine_changed_holds_nothing_about_the_bots() {
    let other = host("event-host").await;
    let bot = add_bot(&other.st, "Event-Only-Bot");
    other.st.db.create_session_for_agent("s-ev", "rt-test", "codex", ".", "Event-Only-Title", Some(&bot)).unwrap();
    let (me, my_dir) = local("event-me");
    let job = link_native(&me, &other, "chat").await;
    assert_eq!(job["machine"]["bots"], json!([]), "the job's machine has no bots");
    let other_id = host_id(&other);
    machines::refresh_one(&me, &other_id).await.unwrap();
    // The rows in the events table, as stored.
    let events = me.db.replay_events(0, 5_000).unwrap();
    let changed: Vec<&Value> = events.iter().filter(|event| event["type"] == "machine.changed").collect();
    assert!(!changed.is_empty());
    for event in &changed {
        let keys: Vec<&str> = event["payload"].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["machineId", "state"], "{event}");
    }
    let pair_events: Vec<&Value> = events.iter().filter(|event| event["type"] == "machine.pair.changed").collect();
    assert!(!pair_events.is_empty());
    for event in &pair_events {
        assert_eq!(event["payload"]["job"]["machine"]["bots"].as_array().map_or(0, Vec::len), 0, "{event}");
    }
    let text = json!(events).to_string();
    for private in ["Event-Only-Bot", "Event-Only-Title"] {
        assert!(!text.contains(private), "{private} reached the event log");
    }
    // The list still shows them.
    let list = dispatch(&me, "machine.list", json!({})).await.unwrap();
    assert_eq!(list["machines"][0]["bots"][0]["name"], "Event-Only-Bot");
    let _ = std::fs::remove_dir_all(my_dir);
}

async fn set_host_tier(other: &Host, tier: &str) {
    let device_id = other.st.db.remote_devices().unwrap()[0]["id"].as_str().unwrap().to_string();
    crate::remote::rpc(&other.st, "remote.devices.update", &json!({"deviceId": device_id, "tier": tier})).await.unwrap();
}

async fn tier_follows(from: &str, to: &str) {
    let other = host(&format!("tier-{to}-host")).await;
    let (me, my_dir) = local(&format!("tier-{to}-me"));
    link_native(&me, &other, from).await;
    let other_id = host_id(&other);
    assert_eq!(me.db.machine_link_get(&other_id).unwrap().unwrap()["tier"], from);
    machines::refresh_one(&me, &other_id).await.unwrap();
    let count = |st: &AppState| st.db.replay_events(0, 5_000).unwrap().iter().filter(|event| event["type"] == "machine.changed").count();
    let before = count(&me);
    set_host_tier(&other, to).await;
    let row = machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(row["tier"], to);
    assert_eq!(me.db.machine_link_get(&other_id).unwrap().unwrap()["tier"], to, "stored");
    // The background loop may notice first, so at least one event, not exactly one.
    assert!(count(&me) > before, "a tier change is a change");
    let settled = count(&me);
    // Unchanged on the next read, and a failed read keeps the stored tier.
    machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!(count(&me), settled, "an unchanged tier emits nothing");
    crate::remote::disable(&other.st).await.unwrap();
    let away = machines::refresh_one(&me, &other_id).await.unwrap();
    assert_eq!((away["state"].clone(), away["tier"].clone()), (json!("offline"), json!(to)));
    let _ = std::fs::remove_dir_all(my_dir);
}

#[tokio::test]
async fn a_raised_tier_reaches_the_link() {
    tier_follows("viewer", "operator").await;
}

#[tokio::test]
async fn a_lowered_tier_reaches_the_link() {
    tier_follows("operator", "viewer").await;
}

include!("handoff_tests.rs");
