//! Gateway tests (FIX29 WP6b).
//!
//! Every test uses the fake `TailscaleCli` from [`super::tailscale::tests`] and
//! a temporary or in-memory database. No test ever starts a `tailscale`
//! process, and no test opens a non-loopback socket.
//!
//! Several tests drive the real HTTP and WebSocket surface on the bound
//! loopback port, so the router, the middleware and the checks are exercised as
//! a device would exercise them.

use super::pairing::{self, DEVICE_COOKIE, PAIR_COOKIE};
use super::tailscale::tests::{FakeCli, EMPTY_SERVE, RUNNING_STATUS};
use super::{RemoteState, DEFAULT_REMOTE_PORT};
use crate::remote::policy;
use crate::{dispatch, AppState};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use futures_util::SinkExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as ClientMessage;

/// The test state's capability token. It must never appear in a response.
const CAPABILITY: &str = "test-only";
const ORIGIN: &str = "https://work-pc.example-tailnet.ts.net";

struct Gateway {
    st: AppState,
    fake: Arc<FakeCli>,
    port: u16,
    origin: String,
    client: reqwest::Client,
    /// Kept so a static-file test can clean up its folder.
    temp_dir: Option<PathBuf>,
    outside: Option<PathBuf>,
    outside_name: Option<String>,
}

async fn gateway() -> Gateway {
    let (st, _events) = crate::phase2a_tests::state();
    let fake = Arc::new(FakeCli::new(RUNNING_STATUS, EMPTY_SERVE));
    st.remote.set_cli(fake.clone());
    // Port 0: an ephemeral loopback port, so parallel tests cannot collide.
    st.db.set_setting("remote.port", &json!(0)).unwrap();
    super::enable(&st).await.unwrap();
    let port = st.remote.bound_address().expect("the listener is bound").port();
    Gateway {
        st,
        fake,
        port,
        origin: ORIGIN.to_string(),
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        temp_dir: None,
        outside: None,
        outside_name: None,
    }
}

/// The built-in "not installed" page is what an empty manifest serves.
async fn gateway_with_static_files() -> Gateway {
    let root = std::env::temp_dir();
    let name = format!("bitbots-remote-web-{}", uuid::Uuid::new_v4());
    let dir = root.join(&name);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>Bitbots Remote</title>").unwrap();
    std::fs::write(dir.join("assets/app.js"), "console.log('remote')").unwrap();
    // A real file one directory up, so a traversal attempt has something to
    // leak if the manifest were not the only gate.
    let outside = root.join(format!("{name}-outside.txt"));
    std::fs::write(&outside, "PRIVATE OUTSIDE FILE").unwrap();

    let (mut st, _events) = crate::phase2a_tests::state();
    let fake = Arc::new(FakeCli::new(RUNNING_STATUS, EMPTY_SERVE));
    let mut remote = RemoteState::with_cli(fake.clone());
    remote.web = super::web::StaticFiles::load(dir.clone());
    st.remote = Arc::new(remote);
    st.db.set_setting("remote.port", &json!(0)).unwrap();
    super::enable(&st).await.unwrap();
    let port = st.remote.bound_address().expect("the listener is bound").port();
    Gateway {
        st,
        fake,
        port,
        origin: ORIGIN.to_string(),
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        temp_dir: Some(dir),
        outside: Some(outside),
        outside_name: Some(format!("{name}-outside.txt")),
    }
}

/// Seeds one paired device and returns `(device id, token)`.
fn seed_device(st: &AppState, id: &str, tier: &str, login: Option<&str>) -> (String, String) {
    let token = pairing::generate_token();
    let hash = pairing::hash_token(&token);
    let device = json!({
        "id": id,
        "name": format!("{tier} device"),
        "kind": "phone",
        "platform": "iOS 19",
        "tier": tier,
        "login": login,
        "pairedAt": super::now_rfc3339(),
    });
    st.db.remote_device_create(&device, &hash).unwrap();
    (id.to_string(), token)
}

impl Gateway {
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    /// One `/api/rpc` call. Every response is checked for the capability.
    async fn rpc(&self, token: &str, method: &str, params: Value) -> (StatusCode, Value) {
        let response = self
            .client
            .post(self.url("/api/rpc"))
            .header("Origin", &self.origin)
            .header("Cookie", format!("{DEVICE_COOKIE}={token}"))
            .header("Content-Type", "application/json")
            .json(&json!({"v": 1, "id": "req_1", "method": method, "params": params}))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        assert!(!body.to_string().contains(CAPABILITY), "the capability appeared in {body}");
        assert!(!body.to_string().contains(token), "the device token appeared in {body}");
        (status, body)
    }

    async fn rpc_error(&self, token: &str, method: &str, params: Value) -> String {
        let (_, body) = self.rpc(token, method, params).await;
        assert_eq!(body["ok"], false, "{body}");
        body["error"]["code"].as_str().unwrap_or_default().to_string()
    }

    async fn open_socket(&self, token: &str) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
        let mut request = self.url("/api/events").replace("http://", "ws://").into_client_request().unwrap();
        request.headers_mut().insert("Origin", self.origin.parse().unwrap());
        request.headers_mut().insert("Cookie", format!("{DEVICE_COOKIE}={token}").parse().unwrap());
        let (socket, _) = tokio_tungstenite::connect_async(request).await.expect("the upgrade succeeds");
        socket
    }

    /// Sends the first cursor message and returns the next text frame.
    async fn cursor(
        &self,
        socket: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        after: u64,
    ) -> Value {
        socket
            .send(ClientMessage::Text(json!({"v": 1, "afterSequence": after}).to_string().into()))
            .await
            .unwrap();
        next_frame(socket).await
    }
}

async fn next_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), futures_util::StreamExt::next(socket))
            .await
            .expect("a frame arrives")
            .expect("the socket is open")
            .expect("the frame is valid");
        match message {
            ClientMessage::Text(text) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                assert!(!text.contains(CAPABILITY), "the capability appeared in a frame: {text}");
                return value;
            }
            ClientMessage::Close(_) => return Value::Null,
            _ => continue,
        }
    }
}

async fn expect_closed(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), futures_util::StreamExt::next(socket)).await {
            Ok(None) | Ok(Some(Ok(ClientMessage::Close(_)))) | Ok(Some(Err(_))) => return,
            Ok(Some(Ok(_))) => continue,
            Err(_) => panic!("the socket was not closed"),
        }
    }
}

/// A raw HTTP/1.1 request, so a path is sent exactly as written and a client
/// cannot normalise `..` away.
async fn raw_get(port: u16, target: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).to_string()
}

// ---------------------------------------------------------------------------
// Lifecycle

#[tokio::test]
async fn the_listener_binds_loopback_only() {
    let gateway = gateway().await;
    let addr = gateway.st.remote.bound_address().expect("bound");
    assert!(addr.ip().is_loopback(), "{addr}");
    assert!(addr.is_ipv4(), "{addr}");
    assert_eq!(gateway.st.remote.link(), "online");
    assert_eq!(gateway.st.remote.serve_port(), Some(443));
    assert_eq!(gateway.st.remote.serve_origin().as_deref(), Some(ORIGIN));
    // The only `serve` argv is our own handler; never funnel, never reset.
    let calls = gateway.fake.calls();
    assert!(
        calls
            .iter()
            .any(|call| call.join(" ") == format!("serve --bg --https=443 http://127.0.0.1:{}", gateway.port)),
        "{calls:?}"
    );
    for call in &calls {
        let argv: Vec<&str> = call.iter().map(String::as_str).collect();
        assert!(!super::tailscale::is_forbidden_argv(&argv), "{argv:?}");
    }
}

#[tokio::test]
async fn disable_removes_only_our_handler_and_keeps_devices() {
    let gateway = gateway().await;
    let (device_id, _token) = seed_device(&gateway.st, "dev-keep", "chat", None);
    let status = dispatch(&gateway.st, "remote.disable", json!({})).await.unwrap();
    assert_eq!(status["enabled"], false);
    assert_eq!(status["link"], "off");
    assert!(gateway.st.remote.bound_address().is_none());
    let devices = dispatch(&gateway.st, "remote.devices.list", json!({})).await.unwrap();
    assert_eq!(devices["devices"][0]["id"], device_id.as_str());
    let calls = gateway.fake.calls();
    let off = calls.iter().position(|call| call.join(" ") == "serve --https=443 off");
    assert!(off.is_some(), "disable must turn off the handler it added: {calls:?}");
    for call in &calls {
        let argv: Vec<&str> = call.iter().map(String::as_str).collect();
        assert!(!super::tailscale::is_forbidden_argv(&argv), "{argv:?}");
    }
}

#[tokio::test]
async fn a_refused_serve_leaves_the_gateway_off_and_never_forbidden() {
    let (st, _events) = crate::phase2a_tests::state();
    let fake = Arc::new(FakeCli::new(RUNNING_STATUS, EMPTY_SERVE));
    st.remote.set_cli(fake.clone());
    st.db.set_setting("remote.port", &json!(0)).unwrap();
    *fake.serve_ok.lock().unwrap() = false;
    let error = super::enable(&st).await.unwrap_err();
    assert_eq!(error.1.code, "unsupported");
    assert!(st.remote.bound_address().is_none(), "a refused serve must not leave a listener");
    assert_eq!(st.remote.link(), "error");
    for call in fake.calls() {
        let argv: Vec<&str> = call.iter().map(String::as_str).collect();
        assert!(!super::tailscale::is_forbidden_argv(&argv), "{argv:?}");
    }
}

#[tokio::test]
async fn a_user_configured_port_is_the_default_and_zero_is_ephemeral() {
    let (st, _events) = crate::phase2a_tests::state();
    let fake = Arc::new(FakeCli::new(RUNNING_STATUS, EMPTY_SERVE));
    st.remote.set_cli(fake);
    assert_eq!(super::remote_port(&st), DEFAULT_REMOTE_PORT);
    st.db.set_setting("remote.port", &json!(0)).unwrap();
    assert_eq!(super::remote_port(&st), 0);
}

#[tokio::test]
async fn funnel_on_refuses_to_start() {
    let (st, _events) = crate::phase2a_tests::state();
    let serve = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"a.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:48620"}}}},"AllowFunnel":{"a.ts.net:443":true}}"#;
    let fake = Arc::new(FakeCli::new(RUNNING_STATUS, serve));
    st.remote.set_cli(fake);
    st.db.set_setting("remote.port", &json!(0)).unwrap();
    let error = super::enable(&st).await.unwrap_err();
    assert_eq!(error.1.code, "unsupported");
    assert!(error.1.message.contains("Funnel"));
    assert_eq!(st.remote.tailscale_state(), super::tailscale::TailscaleState::FunnelOn);
    assert!(st.remote.bound_address().is_none());
}

// ---------------------------------------------------------------------------
// Pairing

#[tokio::test]
async fn pairing_flow_locks_the_offer_and_stores_only_the_hash() {
    let gateway = gateway().await;
    let begun = dispatch(&gateway.st, "remote.pair.begin", json!({})).await.unwrap();
    let code = begun["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 9);
    assert_eq!(begun["url"], format!("{ORIGIN}/"));
    assert_eq!(begun["qrPayload"], format!("{ORIGIN}/#pair={code}"));
    assert_eq!(begun["attemptsLeft"], 5);

    // A wrong code is refused with the uniform error, and the body is small.
    let wrong = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .json(&json!({"code": "AAAA-AAAA", "name": "Thief", "kind": "phone", "platform": "iOS"}))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::BAD_REQUEST);
    let wrong_body: Value = wrong.json().await.unwrap();
    assert_eq!(wrong_body["error"]["code"], "pairing_invalid");

    // The right code locks the offer and sets the short-lived pairing cookie.
    let right = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .header("Tailscale-User-Login", "sam@example.com")
        .json(&json!({"code": code, "name": "Sam's phone", "kind": "phone", "platform": "iOS 19"}))
        .send()
        .await
        .unwrap();
    assert_eq!(right.status(), StatusCode::ACCEPTED);
    let pair_cookie = cookie_of(&right, PAIR_COOKIE).expect("the pairing cookie is set");
    assert!(pair_cookie.contains("HttpOnly"));
    assert!(pair_cookie.contains("Secure"));
    assert!(pair_cookie.contains("SameSite=Strict"));
    assert!(pair_cookie.contains("Path=/"));
    let pairing_id = pair_cookie.split_once('=').unwrap().1.split(';').next().unwrap().to_string();

    // A later code, right or wrong, is refused against the same uniform error.
    let later = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .json(&json!({"code": code, "name": "Attacker", "kind": "browser", "platform": "Chrome"}))
        .send()
        .await
        .unwrap();
    assert_eq!(later.status(), StatusCode::BAD_REQUEST);
    assert_eq!(later.json::<Value>().await.unwrap()["error"]["code"], "pairing_invalid");

    // The desktop sees the request, including the Tailscale login.
    let requested = super::events_last(&gateway.st, "remote.pairing.requested").await;
    assert_eq!(requested["payload"]["name"], "Sam's phone");
    assert_eq!(requested["payload"]["login"], "sam@example.com");

    // Nothing is stored before the owner decides.
    assert_eq!(dispatch(&gateway.st, "remote.devices.list", json!({})).await.unwrap()["devices"].as_array().unwrap().len(), 0);

    let confirmed = dispatch(&gateway.st, "remote.pair.confirm", json!({"pairingId": pairing_id, "approve": true, "tier": "chat"})).await.unwrap();
    let device_id = confirmed["device"]["id"].as_str().unwrap().to_string();
    assert_eq!(confirmed["device"]["tier"], "chat");

    // The phone's poll sets the device cookie and clears the pairing cookie.
    let polled = gateway
        .client
        .get(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .header("Cookie", format!("{PAIR_COOKIE}={pairing_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(polled.status(), StatusCode::OK);
    let device_cookie = cookie_of(&polled, DEVICE_COOKIE).expect("the device cookie is set");
    assert!(device_cookie.contains("HttpOnly"));
    assert!(device_cookie.contains("Secure"));
    assert!(device_cookie.contains("SameSite=Strict"));
    assert!(device_cookie.contains("Path=/"));
    assert!(device_cookie.contains("Max-Age=2592000"));
    assert!(polled.headers().get_all("set-cookie").iter().any(|value| value.to_str().unwrap_or_default().starts_with(PAIR_COOKIE) && value.to_str().unwrap_or_default().contains("Max-Age=0")));
    let token = device_cookie.split_once('=').unwrap().1.split(';').next().unwrap().to_string();
    assert_eq!(polled.json::<Value>().await.unwrap()["state"], "approved");

    // Only the hash is stored, and it matches the token the cookie carries.
    let (device, stored) = gateway.st.db.remote_device_by_token_hash(&pairing::hash_token(&token)).unwrap().unwrap();
    assert_eq!(device["id"], device_id.as_str());
    assert_eq!(stored, pairing::hash_token(&token));
    assert_ne!(stored, token);
    let listed = dispatch(&gateway.st, "remote.devices.list", json!({})).await.unwrap();
    assert_eq!(listed["devices"][0]["id"], device_id.as_str());
    assert_eq!(listed["devices"][0]["login"], "sam@example.com");
    assert!(!listed.to_string().contains(&token), "the token must never be listed");
    assert!(!listed.to_string().contains(&stored), "the hash must never be listed");
}

#[tokio::test]
async fn rejecting_burns_the_offer_and_the_phone_is_told() {
    let gateway = gateway().await;
    let begun = dispatch(&gateway.st, "remote.pair.begin", json!({})).await.unwrap();
    let code = begun["code"].as_str().unwrap().to_string();
    let pairing_id = gateway.st.remote.pairing.lock().unwrap().offer().unwrap().pairing_id.clone();
    let submitted = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .json(&json!({"code": code, "name": "Phone", "kind": "phone", "platform": "iOS"}))
        .send()
        .await
        .unwrap();
    assert_eq!(submitted.status(), StatusCode::ACCEPTED);
    let rejected = dispatch(&gateway.st, "remote.pair.confirm", json!({"pairingId": pairing_id, "approve": false})).await.unwrap();
    assert_eq!(rejected["approved"], false);
    assert_eq!(dispatch(&gateway.st, "remote.devices.list", json!({})).await.unwrap()["devices"].as_array().unwrap().len(), 0);
    // The offer is burned: the right code no longer works.
    let after = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .json(&json!({"code": code, "name": "Again", "kind": "phone", "platform": "iOS"}))
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), StatusCode::BAD_REQUEST);
    let polled = gateway
        .client
        .get(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .header("Cookie", format!("{PAIR_COOKIE}={pairing_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(polled.json::<Value>().await.unwrap()["state"], "rejected");
}

#[tokio::test]
async fn a_bad_code_burns_after_five_attempts_and_answers_uniformly() {
    let gateway = gateway().await;
    let begun = dispatch(&gateway.st, "remote.pair.begin", json!({})).await.unwrap();
    let code = begun["code"].as_str().unwrap().to_string();
    for attempt in 1..=5 {
        let response = gateway
            .client
            .post(gateway.url("/api/pair"))
            .header("Origin", &gateway.origin)
            .json(&json!({"code": "AAAA-AAAA", "name": "Guesser", "kind": "phone", "platform": "iOS"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "attempt {attempt}");
        assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "pairing_invalid");
    }
    // The right code is refused now, with exactly the same answer.
    let burned = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .json(&json!({"code": code, "name": "Owner", "kind": "phone", "platform": "iOS"}))
        .send()
        .await
        .unwrap();
    assert_eq!(burned.status(), StatusCode::BAD_REQUEST);
    assert_eq!(burned.json::<Value>().await.unwrap()["error"]["code"], "pairing_invalid");
    assert!(gateway.st.remote.pairing.lock().unwrap().offer().unwrap().burned);
}

#[tokio::test]
async fn pairing_requires_remote_to_be_on() {
    let (st, _events) = crate::phase2a_tests::state();
    let error = dispatch(&st, "remote.pair.begin", json!({})).await.unwrap_err();
    assert_eq!(error.1.code, "conflict");
}

fn cookie_of(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with(&format!("{name}=")))
        .map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Authentication

#[tokio::test]
async fn a_missing_or_wrong_origin_is_refused_before_anything_else() {
    let gateway = gateway().await;
    let (_, token) = seed_device(&gateway.st, "dev-origin", "viewer", None);
    for origin in [None, Some("https://evil.example.ts.net"), Some("http://127.0.0.1:48620")] {
        let mut request = gateway
            .client
            .post(gateway.url("/api/rpc"))
            .header("Cookie", format!("{DEVICE_COOKIE}={token}"))
            .json(&json!({"v": 1, "id": "r", "method": "daemon.health", "params": {}}));
        if let Some(origin) = origin {
            request = request.header("Origin", origin);
        }
        assert_eq!(request.send().await.unwrap().status(), StatusCode::FORBIDDEN, "{origin:?}");
    }
    // The WebSocket upgrade is checked too.
    let mut bad = gateway.url("/api/events").replace("http://", "ws://").into_client_request().unwrap();
    bad.headers_mut().insert("Origin", "https://evil.example.ts.net".parse().unwrap());
    bad.headers_mut().insert("Cookie", format!("{DEVICE_COOKIE}={token}").parse().unwrap());
    match tokio_tungstenite::connect_async(bad).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => assert_eq!(response.status(), StatusCode::FORBIDDEN),
        other => panic!("expected a 403 upgrade: {other:?}"),
    }
}

#[tokio::test]
async fn without_a_cookie_the_answer_is_unauthorized() {
    let gateway = gateway().await;
    let response = gateway
        .client
        .get(gateway.url("/api/me"))
        .header("Origin", &gateway.origin)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "unauthorized");
}

#[tokio::test]
async fn a_revoked_device_is_refused_and_its_socket_closes() {
    let gateway = gateway().await;
    let (device_id, token) = seed_device(&gateway.st, "dev-revoke", "chat", None);
    let mut socket = gateway.open_socket(&token).await;
    let first = gateway.cursor(&mut socket, 0).await;
    assert_eq!(first["type"], "events.replay.complete");
    dispatch(&gateway.st, "remote.devices.revoke", json!({"deviceId": device_id})).await.unwrap();
    expect_closed(&mut socket).await;
    assert_eq!(gateway.rpc_error(&token, "daemon.health", json!({})).await, "device_revoked");
    let devices = dispatch(&gateway.st, "remote.devices.list", json!({})).await.unwrap();
    assert_eq!(devices["devices"].as_array().unwrap().len(), 0, "a revoked device leaves the list");
}

#[tokio::test]
async fn a_signed_out_device_is_refused() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-logout", "chat", None);
    let response = gateway
        .client
        .post(gateway.url("/api/logout"))
        .header("Origin", &gateway.origin)
        .header("Cookie", format!("{DEVICE_COOKIE}={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cleared = cookie_of(&response, DEVICE_COOKIE).unwrap();
    assert!(cleared.contains("Max-Age=0"), "{cleared}");
    assert_eq!(gateway.rpc_error(&token, "daemon.health", json!({})).await, "device_revoked");
}

#[tokio::test]
async fn a_login_mismatch_is_refused_and_written_to_the_activity_list() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-login", "viewer", Some("sam@example.com"));
    let good = gateway
        .client
        .get(gateway.url("/api/me"))
        .header("Origin", &gateway.origin)
        .header("Cookie", format!("{DEVICE_COOKIE}={token}"))
        .header("Tailscale-User-Login", "sam@example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), StatusCode::OK);
    let body: Value = good.json().await.unwrap();
    assert_eq!(body["protocolVersion"], 1);
    assert_eq!(body["device"]["tier"], "viewer");
    assert_eq!(body["approvalsFromRemote"], false);
    assert_eq!(body["quietHoursActive"], false);
    assert!(!body.to_string().contains("sam@example.com"), "the login must not be echoed");

    let bad = gateway
        .client
        .get(gateway.url("/api/me"))
        .header("Origin", &gateway.origin)
        .header("Cookie", format!("{DEVICE_COOKIE}={token}"))
        .header("Tailscale-User-Login", "someone@else.com")
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(bad.json::<Value>().await.unwrap()["error"]["code"], "device_revoked");
    let activity = dispatch(&gateway.st, "remote.activity.list", json!({})).await.unwrap();
    let entry = &activity["entries"][0];
    assert_eq!(entry["kind"], "denied");
    assert!(entry["summary"].as_str().unwrap().contains("no longer matches"), "{entry}");
}

#[tokio::test]
async fn an_idle_device_past_its_expiry_is_refused() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-idle", "chat", None);
    // Backdate the last-seen stamp past the 30-day window.
    gateway
        .st
        .db
        .remote_device_touch("dev-idle", &(chrono::Utc::now() - chrono::Duration::days(31)).to_rfc3339())
        .unwrap();
    assert_eq!(gateway.rpc_error(&token, "daemon.health", json!({})).await, "device_revoked");
}

#[tokio::test]
async fn a_body_over_256_kib_is_payload_too_large() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-big", "viewer", None);
    let mut request = json!({"v": 1, "id": "big", "method": "session.prompt", "params": {}});
    request["params"]["text"] = json!("x".repeat(300 * 1024));
    let response = gateway
        .client
        .post(gateway.url("/api/rpc"))
        .header("Origin", &gateway.origin)
        .header("Cookie", format!("{DEVICE_COOKIE}={token}"))
        .body(request.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.json::<Value>().await.unwrap()["error"]["code"], "payload_too_large");
}

#[tokio::test]
async fn the_per_device_rate_limit_stops_a_flood() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-flood", "viewer", None);
    let mut limited = false;
    for _ in 0..60 {
        let (status, body) = gateway.rpc(&token, "daemon.health", json!({})).await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(body["error"]["code"], "rate_limited");
            limited = true;
            break;
        }
    }
    assert!(limited, "the flood was never throttled");
}

// ---------------------------------------------------------------------------
// The /api/rpc pipeline

#[tokio::test]
async fn a_viewer_cannot_prompt() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-viewer", "viewer", None);
    assert_eq!(
        gateway.rpc_error(&token, "session.prompt", json!({"sessionId": "s", "text": "hi"})).await,
        "tier_required"
    );
    // A read still passes.
    let (status, body) = gateway.rpc(&token, "daemon.health", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn quiet_hours_refuse_chat_and_approvals_but_allow_reads() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-quiet", "operator", None);
    // Equal bounds mean "all day", so the test does not depend on the clock.
    dispatch(
        &gateway.st,
        "remote.security.set",
        json!({"approvalsFromRemote": true, "idleExpiryDays": 30, "quietHours": {"enabled": true, "from": "00:00", "to": "00:00"}}),
    )
    .await
    .unwrap();
    assert_eq!(gateway.rpc_error(&token, "session.cancel", json!({"sessionId": "s"})).await, "quiet_hours");
    assert_eq!(gateway.rpc_error(&token, "permission.reply", json!({"permissionId": "p", "choice": "allow"})).await, "quiet_hours");
    assert_eq!(gateway.rpc_error(&token, "session.prompt", json!({"sessionId": "s", "text": "hi"})).await, "quiet_hours");
    let (status, body) = gateway.rpc(&token, "daemon.health", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn approvals_from_remote_off_refuses_permission_reply() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-operator", "operator", None);
    assert_eq!(
        gateway.rpc_error(&token, "permission.reply", json!({"permissionId": "p", "choice": "allow"})).await,
        "approvals_disabled"
    );
    // A chat-tier device never approves, whatever the host allows.
    let (_other, chat_token) = seed_device(&gateway.st, "dev-chat", "chat", None);
    dispatch(&gateway.st, "remote.security.set", json!({"approvalsFromRemote": true})).await.unwrap();
    assert_eq!(
        gateway.rpc_error(&chat_token, "permission.reply", json!({"permissionId": "p", "choice": "allow"})).await,
        "approvals_disabled"
    );
}

#[tokio::test]
async fn provider_polling_and_attachments_are_refused() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-params", "operator", None);
    assert_eq!(
        gateway.rpc_error(&token, "runtime.models", json!({"runtimeId": "rt-test", "refresh": true})).await,
        "invalid_params"
    );
    for method in ["session.prompt", "session.queue.add"] {
        let params = json!({"sessionId": "s", "text": "hi", "attachments": [{"path": "C:\\secret\\a.png"}]});
        assert_eq!(gateway.rpc_error(&token, method, params).await, "invalid_params", "{method}");
        let staged = json!({"sessionId": "s", "text": "hi", "attachments": [{"stagedId": "up_1"}]});
        assert_eq!(gateway.rpc_error(&token, method, staged).await, "invalid_params", "staged {method}");
        let empty = json!({"sessionId": "s", "text": "hi", "attachments": []});
        let code = gateway.rpc_error(&token, method, empty).await;
        assert_ne!(code, "invalid_params", "an empty attachment list is allowed");
    }
}

#[tokio::test]
async fn a_never_method_is_forbidden_remote() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-never", "operator", None);
    for method in ["settings.set", "agent.create", "daemon.shutdown", "remote.enable", "remote.devices.list", "file.revert"] {
        assert_eq!(
            gateway.rpc_error(&token, method, json!({"key": "x", "value": 1})).await,
            "forbidden_remote",
            "{method}"
        );
    }
}

#[tokio::test]
async fn an_unknown_method_is_forbidden_remote() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-unknown", "operator", None);
    assert_eq!(gateway.rpc_error(&token, "made.up.method", json!({})).await, "forbidden_remote");
}

#[tokio::test]
async fn read_results_are_redacted_for_the_device() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-redact", "operator", None);
    dispatch(&gateway.st, "agent.create", json!({"name": "Redact me", "runtimeId": "rt-test", "instructions": "Do the thing.", "customEnv": {"LANG": "en_US.UTF-8"}})).await.unwrap();
    let agent = dispatch(&gateway.st, "agent.list", json!({})).await.unwrap()["agents"][0].clone();
    let agent_id = agent["id"].as_str().unwrap().to_string();
    let (status, body) = gateway.rpc(&token, "agent.get", json!({"agentId": agent_id})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["result"]["agent"]["customEnv"], json!({}), "{body}");
    assert_eq!(body["result"]["agent"]["instructions"], json!({"hasInstructions": true}), "{body}");
    // The daemon's own answer still has the real values.
    let local = dispatch(&gateway.st, "agent.get", json!({"agentId": agent_id})).await.unwrap();
    assert_eq!(local["agent"]["customEnv"]["LANG"], "en_US.UTF-8");
}

#[tokio::test]
async fn a_write_method_writes_one_content_free_activity_line() {
    let gateway = gateway().await;
    let (device_id, token) = seed_device(&gateway.st, "dev-audit", "chat", None);
    // A chat write that the daemon refuses still counts as an attempt only when
    // the gateway denies it; here the tier policy allows it, so the daemon
    // answers not_found and no audit line is written.
    gateway.rpc(&token, "session.rename", json!({"sessionId": "nope", "title": "x"})).await;
    gateway.rpc(&token, "daemon.health", json!({})).await;
    gateway.rpc(&token, "settings.set", json!({"key": "x", "value": 1})).await;
    let activity = dispatch(&gateway.st, "remote.activity.list", json!({})).await.unwrap();
    let entries = activity["entries"].as_array().unwrap();
    let denied: Vec<&Value> = entries.iter().filter(|entry| entry["kind"] == "denied").collect();
    assert_eq!(denied.len(), 1, "{activity}");
    assert_eq!(denied[0]["deviceId"], device_id.as_str());
    for entry in entries {
        let summary = entry["summary"].as_str().unwrap();
        assert!(summary.len() < 120, "{summary}");
        assert!(!summary.contains("Do the thing"), "{summary}");
    }
}

#[tokio::test]
async fn an_empty_attachment_list_is_the_only_size_that_passes() {
    assert!(super::web::attachment_rule("session.prompt", &json!({"attachments": []})).is_none());
    assert!(super::web::attachment_rule("session.prompt", &json!({})).is_none());
    assert!(super::web::attachment_rule("session.prompt", &json!({"attachments": [{}]})).is_some());
    assert!(super::web::attachment_rule("daemon.health", &json!({"attachments": [{}]})).is_none());
}

// ---------------------------------------------------------------------------
// Static files

#[tokio::test]
async fn static_files_come_from_the_manifest_and_nothing_else() {
    let gateway = gateway_with_static_files().await;
    let index = raw_get(gateway.port, "/").await;
    assert!(index.contains("200 OK"), "{index}");
    assert!(index.contains("Bitbots Remote"), "{index}");
    let asset = raw_get(gateway.port, "/assets/app.js").await;
    assert!(asset.contains("200 OK"), "{asset}");
    assert!(asset.contains("console.log('remote')"), "{asset}");
    let missing = raw_get(gateway.port, "/nope.js").await;
    assert!(missing.contains("404"), "{missing}");
}

#[tokio::test]
async fn path_traversal_is_a_404() {
    let gateway = gateway_with_static_files().await;
    let outside = gateway.outside_name.clone().expect("an outside file exists");
    let targets = [
        "/../Cargo.toml".to_string(),
        "/..%2fCargo.toml".to_string(),
        "/%2e%2e/Cargo.toml".to_string(),
        "/assets/../../Cargo.toml".to_string(),
        "/C:/fx49/Cargo.toml".to_string(),
        "/%5c..%5cCargo.toml".to_string(),
        "/assets/..%5c..%5cCargo.toml".to_string(),
        format!("/../{outside}"),
        format!("/..%2f{outside}"),
    ];
    for target in targets {
        let response = raw_get(gateway.port, &target).await;
        assert!(response.contains("404"), "{target} answered {response}");
        assert!(!response.contains("PRIVATE OUTSIDE FILE"), "{target} leaked a file");
        assert!(!response.contains("workspace"), "{target} leaked a file");
    }
    // The manifest itself still works, so the 404s are not a broken router.
    assert!(raw_get(gateway.port, "/").await.contains("200 OK"));
    if let Some(dir) = gateway.temp_dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Some(outside) = gateway.outside {
        let _ = std::fs::remove_file(outside);
    }
}

#[tokio::test]
async fn an_absent_web_folder_serves_the_built_in_page() {
    let gateway = gateway().await;
    let response = raw_get(gateway.port, "/").await;
    assert!(response.contains("200 OK"), "{response}");
    assert!(response.contains("not installed"), "{response}");
    assert!(raw_get(gateway.port, "/anything.js").await.contains("404"));
}

#[tokio::test]
async fn every_response_carries_the_security_headers() {
    let gateway = gateway().await;
    let response = gateway
        .client
        .get(gateway.url("/api/me"))
        .header("Origin", &gateway.origin)
        .send()
        .await
        .unwrap();
    let headers = response.headers().clone();
    let policy = headers.get("content-security-policy").unwrap().to_str().unwrap();
    assert!(policy.contains("default-src 'self'"), "{policy}");
    assert!(policy.contains("connect-src 'self'"), "{policy}");
    assert!(policy.contains("img-src 'self' data:"), "{policy}");
    assert!(policy.contains("style-src 'self' 'unsafe-inline'"), "{policy}");
    assert!(policy.contains("frame-ancestors 'none'"), "{policy}");
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("referrer-policy").unwrap(), "no-referrer");
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    // The page itself is not `no-store`, but it still gets the other headers.
    let page = raw_get(gateway.port, "/").await;
    // Hyper lowercases header names on the wire.
    assert!(page.to_ascii_lowercase().contains("content-security-policy"), "{page}");
}

// ---------------------------------------------------------------------------
// Events

#[tokio::test]
async fn the_socket_replays_from_a_cursor_then_streams_live_events() {
    let gateway = gateway().await;
    let (_device_id, token) = seed_device(&gateway.st, "dev-events", "viewer", None);
    gateway.st.db.create_session("event-session", "rt-test", "codex", ".", "Events").unwrap();
    gateway.st.emit("session.changed", json!({"id": "event-session", "state": "idle"})).await;
    gateway.st.emit("settings.changed", json!({"key": "appearance.style", "value": "dark"})).await;

    let mut socket = gateway.open_socket(&token).await;
    let replayed = gateway.cursor(&mut socket, 0).await;
    assert_eq!(replayed["type"], "session.changed");
    let complete = next_frame(&mut socket).await;
    assert_eq!(complete["type"], "events.replay.complete");
    // The dropped `settings.changed` never reached the wire.
    assert_ne!(complete["type"], "settings.changed");

    gateway.st.emit("session.changed", json!({"id": "event-session", "state": "working"})).await;
    let live = next_frame(&mut socket).await;
    assert_eq!(live["type"], "session.changed");
    assert_eq!(live["payload"]["state"], "working");

    // A dropped event is silent: nothing arrives for a moment.
    gateway.st.emit("settings.changed", json!({"key": "appearance.style", "value": "light"})).await;
    let quiet = tokio::time::timeout(Duration::from_millis(300), futures_util::StreamExt::next(&mut socket)).await;
    assert!(quiet.is_err(), "a dropped event must not be sent");
}

#[tokio::test]
async fn a_second_socket_closes_the_first_and_writes_an_activity_line() {
    let gateway = gateway().await;
    let (device_id, token) = seed_device(&gateway.st, "dev-onesocket", "viewer", None);
    let mut first = gateway.open_socket(&token).await;
    assert_eq!(gateway.cursor(&mut first, 0).await["type"], "events.replay.complete");
    let mut second = gateway.open_socket(&token).await;
    assert_eq!(gateway.cursor(&mut second, 0).await["type"], "events.replay.complete");
    expect_closed(&mut first).await;
    let activity = dispatch(&gateway.st, "remote.activity.list", json!({"limit": 5})).await.unwrap();
    let replacements: Vec<&Value> = activity["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "connected" && entry["summary"].as_str().unwrap_or_default().contains("older one was closed"))
        .collect();
    assert_eq!(replacements.len(), 1, "{activity}");
    assert_eq!(replacements[0]["deviceId"], device_id.as_str());
}

#[tokio::test]
async fn a_revoked_device_socket_closes_at_once() {
    let gateway = gateway().await;
    let (device_id, token) = seed_device(&gateway.st, "dev-kick", "viewer", None);
    let mut socket = gateway.open_socket(&token).await;
    assert_eq!(gateway.cursor(&mut socket, 0).await["type"], "events.replay.complete");
    assert_eq!(gateway.st.remote.connected_count(), 1);
    dispatch(&gateway.st, "remote.devices.revoke", json!({"deviceId": device_id})).await.unwrap();
    expect_closed(&mut socket).await;
    assert_eq!(gateway.st.remote.connected_count(), 0);
}

#[tokio::test]
async fn an_unpaired_socket_is_refused() {
    let gateway = gateway().await;
    let mut request = gateway.url("/api/events").replace("http://", "ws://").into_client_request().unwrap();
    request.headers_mut().insert("Origin", gateway.origin.parse().unwrap());
    request.headers_mut().insert("Cookie", format!("{DEVICE_COOKIE}=not-a-token").parse().unwrap());
    match tokio_tungstenite::connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => assert_eq!(response.status(), StatusCode::UNAUTHORIZED),
        other => panic!("expected a 401 upgrade: {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// remote.* shapes and the settings rule

#[tokio::test]
async fn remote_status_carries_the_contract_fields_and_never_the_login() {
    let gateway = gateway().await;
    let status = dispatch(&gateway.st, "remote.status", json!({})).await.unwrap();
    for key in ["enabled", "link", "url", "port", "servePort", "tailscale", "hostName", "deviceCount", "connectedCount", "keepAwake", "error"] {
        assert!(status.get(key).is_some(), "missing {key}: {status}");
    }
    assert_eq!(status["enabled"], true);
    assert_eq!(status["link"], "online");
    assert_eq!(status["tailscale"], "ready");
    // No login, no email, no raw status JSON.
    let text = status.to_string();
    assert!(!text.contains("sam@example.com"), "{text}");
    assert!(!text.contains("BackendState"), "{text}");
    assert!(!text.contains("CertDomains"), "{text}");
    let requested = super::events_last(&gateway.st, "remote.changed").await;
    assert_eq!(requested["payload"]["status"]["link"], "online");
}

#[tokio::test]
async fn settings_set_refuses_every_remote_key() {
    let gateway = gateway().await;
    for key in ["remote.enabled", "remote.port", "remote.servePort", "remote.security"] {
        let error = dispatch(&gateway.st, "settings.set", json!({"key": key, "value": true})).await.unwrap_err();
        assert_eq!(error.1.code, "invalid_argument", "{key}");
        assert_eq!(error.1.message, "Remote settings change only through Settings › Remote.");
    }
    // The remote family itself may write them.
    let security = dispatch(&gateway.st, "remote.security.set", json!({"approvalsFromRemote": true, "idleExpiryDays": 7})).await.unwrap();
    assert_eq!(security["approvalsFromRemote"], true);
    assert_eq!(security["idleExpiryDays"], 7);
    assert_eq!(security["quietHours"]["from"], "22:00", "an omitted field keeps its value");
    let read_back = dispatch(&gateway.st, "remote.security.get", json!({})).await.unwrap();
    assert_eq!(read_back, security);
    assert_eq!(dispatch(&gateway.st, "remote.security.set", json!({"quietHours": {"from": "nope"}})).await.unwrap_err().1.code, "invalid_argument");
}

#[tokio::test]
async fn device_updates_and_revokes_follow_the_contract() {
    let gateway = gateway().await;
    let (device_id, _token) = seed_device(&gateway.st, "dev-update", "chat", None);
    let updated = dispatch(&gateway.st, "remote.devices.update", json!({"deviceId": device_id, "name": "Sam's phone", "tier": "operator"})).await.unwrap();
    assert_eq!(updated["device"]["name"], "Sam's phone");
    assert_eq!(updated["device"]["tier"], "operator");
    assert_eq!(dispatch(&gateway.st, "remote.devices.update", json!({"deviceId": device_id, "tier": "root"})).await.unwrap_err().1.code, "invalid_argument");
    assert_eq!(dispatch(&gateway.st, "remote.devices.update", json!({"deviceId": "missing", "name": "x"})).await.unwrap_err().1.code, "not_found");
    assert_eq!(dispatch(&gateway.st, "remote.devices.revoke", json!({"deviceId": "missing"})).await.unwrap_err().1.code, "not_found");
    assert_eq!(dispatch(&gateway.st, "remote.devices.revoke", json!({"deviceId": device_id})).await.unwrap()["revoked"], true);
}

#[tokio::test]
async fn the_activity_table_keeps_at_most_five_hundred_rows() {
    let gateway = gateway().await;
    for index in 0..520 {
        gateway
            .st
            .db
            .remote_activity_push(&format!("2026-10-17T00:00:{:02}Z", index % 60), None, "prompt", &format!("Line {index}."))
            .unwrap();
    }
    assert_eq!(gateway.st.db.remote_activity_count().unwrap(), 500);
    let listed = dispatch(&gateway.st, "remote.activity.list", json!({"limit": 1000})).await.unwrap();
    assert_eq!(listed["entries"].as_array().unwrap().len(), 500);
    assert_eq!(listed["entries"][0]["summary"], "Line 519.");
    assert_eq!(dispatch(&gateway.st, "remote.activity.list", json!({"limit": "many"})).await.unwrap_err().1.code, "invalid_argument");
}

#[tokio::test]
async fn pair_cancel_throws_the_live_offer_away() {
    let gateway = gateway().await;
    let begun = dispatch(&gateway.st, "remote.pair.begin", json!({})).await.unwrap();
    let code = begun["code"].as_str().unwrap().to_string();
    assert_eq!(dispatch(&gateway.st, "remote.pair.cancel", json!({})).await.unwrap()["cancelled"], true);
    let after = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", &gateway.origin)
        .json(&json!({"code": code, "name": "Phone", "kind": "phone", "platform": "iOS"}))
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_tier_table_matches_the_gateway_every_remote_method_is_never() {
    // The gateway is reached only from the desktop; every `remote.*` method is
    // `never` remote, so a device can never call one.
    for method in [
        "remote.status", "remote.enable", "remote.disable", "remote.pair.begin", "remote.pair.cancel",
        "remote.pair.confirm", "remote.devices.list", "remote.devices.update", "remote.devices.revoke",
        "remote.security.get", "remote.security.set", "remote.activity.list",
    ] {
        let rule = policy::rule_for(method).unwrap_or_else(|| panic!("no tier rule for {method}"));
        assert_eq!(rule.class, policy::MethodClass::Never, "{method}");
    }
}
