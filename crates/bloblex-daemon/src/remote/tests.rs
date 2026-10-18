//! Gateway tests (FIX29 WP6b).
//!
//! Every test uses the fake `TailscaleCli` from [`super::tailscale::tests`] and
//! a temporary or in-memory database. No test ever starts a `tailscale`
//! process, and no test opens a non-loopback socket.
//!
//! Several tests drive the real HTTP and WebSocket surface on the bound
//! loopback port, so the router, the middleware and the checks are exercised as
//! a device would exercise them.

use super::connectivity;
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

/// The real packaged remote layout (FIX34): the entry page is `remote.html`.
async fn gateway_with_static_files() -> Gateway {
    let root = std::env::temp_dir();
    let name = format!("bitbots-remote-web-{}", uuid::Uuid::new_v4());
    let dir = root.join(&name);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(
        dir.join("remote.html"),
        "<!doctype html><title>Bitbots Remote</title><p id=\"entry\">remote entry</p>",
    )
    .unwrap();
    std::fs::write(dir.join("remote.webmanifest"), "{\"name\":\"Bitbots Remote\"}").unwrap();
    std::fs::write(dir.join("remote-sw.js"), "self.addEventListener('install',()=>{})").unwrap();
    std::fs::write(dir.join("assets/app.css"), "body{margin:0}").unwrap();
    std::fs::write(dir.join("assets/app-AbC123.js"), "console.log('remote')").unwrap();
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

/// FIX35 C6: a signed-out phone must learn which sign-in screen to show.
#[tokio::test]
async fn a_refused_me_names_the_active_method_and_nothing_else() {
    // Tailscale (the default): the phone shows the pairing-code screen.
    let gateway = gateway().await;
    let response = gateway
        .client
        .get(gateway.url("/api/me"))
        .header("Origin", &gateway.origin)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["method"], "tailscale");
    // Nothing else rides along: no host name, no device data.
    assert!(body.get("host").is_none(), "{body}");
    assert!(body.get("device").is_none(), "{body}");

    // Native: the phone shows the username-and-password screen.
    let native = native_gateway().await;
    let response = native.get("/api/me", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["method"], "native");
    assert!(body.get("host").is_none(), "{body}");
    assert!(body.get("device").is_none(), "{body}");
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

/// The `content-type` a raw response carried, lowercased, or `None`.
fn raw_content_type(response: &str) -> Option<String> {
    response.lines()
        .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
        .map(|line| line.split_once(':').unwrap().1.trim().to_ascii_lowercase())
}

#[tokio::test]
async fn static_files_come_from_the_manifest_and_nothing_else() {
    let gateway = gateway_with_static_files().await;
    // The entry page is `remote.html`; both `/` and `/remote.html` serve it as
    // HTML, so the browser renders it instead of downloading it.
    for path in ["/", "/remote.html"] {
        let entry = raw_get(gateway.port, path).await;
        assert!(entry.contains("200 OK"), "{path}: {entry}");
        assert!(entry.contains("remote entry"), "{path}: {entry}");
        assert_eq!(raw_content_type(&entry).as_deref(), Some("text/html; charset=utf-8"), "{path}: {entry}");
    }
    // Every listed file stays servable at its own path, with its own type.
    for (path, expected) in [
        ("/remote-sw.js", "text/javascript; charset=utf-8"),
        ("/assets/app.css", "text/css; charset=utf-8"),
        ("/remote.webmanifest", "application/manifest+json"),
    ] {
        let file = raw_get(gateway.port, path).await;
        assert!(file.contains("200 OK"), "{path}: {file}");
        assert_eq!(raw_content_type(&file).as_deref(), Some(expected), "{path}: {file}");
    }
    let asset = raw_get(gateway.port, "/assets/app-AbC123.js").await;
    assert!(asset.contains("200 OK"), "{asset}");
    assert!(asset.contains("console.log('remote')"), "{asset}");
    assert_eq!(raw_content_type(&asset).as_deref(), Some("text/javascript; charset=utf-8"), "{asset}");
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
async fn a_folder_with_files_but_no_entry_page_serves_the_built_in_page() {
    let root = std::env::temp_dir();
    let name = format!("bitbots-remote-web-noentry-{}", uuid::Uuid::new_v4());
    let dir = root.join(&name);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("assets/app-AbC123.js"), "console.log('remote')").unwrap();

    let (mut st, _events) = crate::phase2a_tests::state();
    let fake = Arc::new(FakeCli::new(RUNNING_STATUS, EMPTY_SERVE));
    let mut remote = RemoteState::with_cli(fake.clone());
    remote.web = super::web::StaticFiles::load(dir.clone());
    st.remote = Arc::new(remote);
    st.db.set_setting("remote.port", &json!(0)).unwrap();
    super::enable(&st).await.unwrap();
    let port = st.remote.bound_address().expect("the listener is bound").port();

    // Files exist, so the folder is not empty, but there is no entry page:
    // `/` falls back to the built-in page rather than 404.
    let response = raw_get(port, "/").await;
    assert!(response.contains("200 OK"), "{response}");
    assert!(response.contains("not installed"), "{response}");

    let _ = std::fs::remove_dir_all(dir);
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
        "remote.method.set", "remote.native.account.set", "remote.native.cert.regenerate", "remote.native.port.set",
        "remote.native.upnp.set", "remote.native.externalIp.set", "remote.native.firewall.add", "remote.native.firewall.remove",
    ] {
        let rule = policy::rule_for(method).unwrap_or_else(|| panic!("no tier rule for {method}"));
        assert_eq!(rule.class, policy::MethodClass::Never, "{method}");
    }
}

// ---------------------------------------------------------------------------
// Native Remote (FIX35 C1)

/// A Native host: TLS on an ephemeral loopback port, with an account set.
struct NativeGateway {
    st: AppState,
    port: u16,
    origin: String,
    client: reqwest::Client,
    dir: PathBuf,
}

impl Drop for NativeGateway {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn native_gateway() -> NativeGateway {
    let (st, _events) = crate::phase2a_tests::state();
    let dir = std::env::temp_dir().join(format!("bitbots-native-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    *st.team.data_dir.lock().unwrap() = Some(dir.clone());
    st.db.set_setting("remote.method", &json!("native")).unwrap();
    st.remote.set_method_cache("native");
    // Port 0: an ephemeral port, so parallel tests cannot collide.
    st.db.set_setting("remote.native.port", &json!(0)).unwrap();
    super::native::set_account(&st, "owner", "correct horse battery").unwrap();
    super::enable(&st).await.unwrap();
    let port = st.remote.native_bound().expect("the native listener is bound").port();
    NativeGateway {
        st,
        port,
        origin: format!("https://127.0.0.1:{port}"),
        client: reqwest::Client::builder().danger_accept_invalid_certs(true).no_proxy().build().unwrap(),
        dir,
    }
}

impl NativeGateway {
    fn url(&self, path: &str) -> String {
        format!("https://127.0.0.1:{}{path}", self.port)
    }

    /// A request to a chosen `Host`, so the Host check can be exercised apart
    /// from the Origin check. The socket always dials loopback (the test
    /// listener binds loopback only); `host` becomes the `Host` header, which is
    /// what the certificate's authority check reads.
    async fn post(&self, path: &str, host: &str, origin: &str, cookie: Option<&str>, body: &Value) -> reqwest::Response {
        let url = format!("https://127.0.0.1:{}{path}", self.port);
        let authority = format!("{host}:{}", self.port);
        let mut request = self
            .client
            .post(url)
            .header("Host", authority)
            .header("Origin", origin)
            .header("Content-Type", "application/json");
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        request.json(body).send().await.unwrap()
    }

    async fn login(&self, body: Value) -> reqwest::Response {
        self.post("/api/login", "127.0.0.1", &self.origin, None, &body).await
    }

    async fn login_with(&self, cookie: &str, body: Value) -> reqwest::Response {
        self.post("/api/login", "127.0.0.1", &self.origin, Some(cookie), &body).await
    }

    async fn get(&self, path: &str, cookie: Option<&str>) -> reqwest::Response {
        let mut request = self.client.get(self.url(path)).header("Origin", &self.origin);
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        request.send().await.unwrap()
    }
}

/// Signs in and has the owner approve the device, returning `(device id, cookie)`.
async fn approve_native_device(gateway: &NativeGateway) -> (String, String) {
    let pending = gateway
        .login(json!({"username": "owner", "password": "correct horse battery", "name": "Pixel 8", "kind": "phone", "platform": "Android 15"}))
        .await;
    assert_eq!(pending.status(), StatusCode::ACCEPTED);
    let pair_cookie = cookie_of(&pending, PAIR_COOKIE).expect("a pair cookie");
    let requested = super::events_last(&gateway.st, "remote.pairing.requested").await;
    let pairing_id = requested["payload"]["pairingId"].as_str().unwrap().to_string();
    super::rpc(&gateway.st, "remote.pair.confirm", &json!({"pairingId": pairing_id, "approve": true, "tier": "chat"}))
        .await
        .unwrap();
    let polled = gateway.get("/api/pair", Some(&pair_cookie)).await;
    assert_eq!(polled.status(), StatusCode::OK);
    let device_cookie = cookie_of(&polled, DEVICE_COOKIE).expect("a device cookie");
    let approved: Value = polled.json().await.unwrap();
    let device_id = approved["device"]["id"].as_str().unwrap().to_string();
    (device_id, device_cookie)
}

#[tokio::test]
async fn the_native_certificate_is_stable_and_regeneration_changes_it() {
    let gateway = native_gateway().await;
    let first = super::native::ensure_cert(&gateway.st, false).unwrap();
    let again = super::native::ensure_cert(&gateway.st, false).unwrap();
    assert_eq!(first.fingerprint, again.fingerprint, "the fingerprint is stable across a restart");
    assert_eq!(first.fingerprint.len(), 95, "32 hex pairs: {}", first.fingerprint);
    assert!(gateway.dir.join(super::native::CERT_FILE).exists());
    assert!(gateway.dir.join(super::native::KEY_FILE).exists());
    let regenerated = super::native::ensure_cert(&gateway.st, true).unwrap();
    assert_ne!(first.fingerprint, regenerated.fingerprint, "regeneration changes the fingerprint");
    // The key file's permissions were restricted by a recorded command.
    let commands = gateway.st.remote.key_commands.lock().unwrap().clone();
    assert!(!commands.is_empty(), "a permission command was recorded");
    let expected = if cfg!(windows) { "icacls" } else { "chmod" };
    assert_eq!(commands[0][0], expected);
    assert!(commands[0].iter().any(|arg| arg.contains("remote-native-key.pem")), "{:?}", commands[0]);
}

#[tokio::test]
async fn the_native_listener_serves_tls_and_refuses_plain_http() {
    let gateway = native_gateway().await;
    let response = gateway.get("/", None).await;
    assert_eq!(response.status(), StatusCode::OK, "a TLS request succeeds with the generated certificate");
    // A plain-HTTP request fails the handshake and is dropped, never answered.
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", gateway.port)).await.unwrap();
    let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", gateway.port);
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;
    let text = String::from_utf8_lossy(&response);
    assert!(!text.contains("HTTP/"), "plain HTTP was answered: {text}");
}

#[tokio::test]
async fn the_native_listener_binds_only_while_native_is_on() {
    let gateway = native_gateway().await;
    assert!(gateway.st.remote.native_listening());
    assert!(gateway.st.remote.native_bound().is_some());
    super::disable(&gateway.st).await.unwrap();
    assert!(!gateway.st.remote.native_listening());
    assert!(gateway.st.remote.native_bound().is_none());
    // The port is closed: the client sees a transport error, not an HTTP status.
    let refused = gateway.client.get(gateway.url("/")).header("Origin", &gateway.origin).send().await;
    assert!(refused.is_err(), "the listener still answered after disable");
}

#[test]
fn the_native_bind_host_is_every_interface_in_production_and_loopback_under_test() {
    // Production keeps the wildcard; only the test default narrows the bind.
    assert_eq!(super::native::PRODUCTION_BIND_V4, "0.0.0.0");
    assert_eq!(super::native::PRODUCTION_BIND_V6, "::");
    let production = super::native::BindHosts::production();
    assert_eq!(production.v4, "0.0.0.0", "production binds every interface");
    assert_eq!(production.v6.as_deref(), Some("::"), "production tries the IPv6 wildcard");
    // The default used while testing binds loopback and never the wildcard, so
    // no test binary opens a socket the Windows Firewall would ask about. This
    // reads the default; it binds nothing.
    let test_bind = super::native::BindHosts::default();
    assert_eq!(test_bind.v4, "127.0.0.1", "tests must bind loopback only");
    assert_eq!(test_bind.v6, None, "tests must skip the IPv6 wildcard");
}

#[tokio::test]
async fn native_checks_origin_and_host_against_the_certificate() {
    let gateway = native_gateway().await;
    // The certificate's own origin passes; a wrong password is a 401, not a 403.
    let accepted = gateway.login(json!({"username": "owner", "password": "not the password"})).await;
    assert_eq!(accepted.status(), StatusCode::UNAUTHORIZED);
    // The Tailscale origin is refused under Native.
    let tailscale = gateway
        .post("/api/login", "127.0.0.1", "https://work-pc.tail1234.ts.net", None, &json!({}))
        .await;
    assert_eq!(tailscale.status(), StatusCode::FORBIDDEN);
    // An accepted origin with a Host outside the certificate is refused.
    let host = gateway
        .post("/api/login", "127.0.0.2", &gateway.origin, None, &json!({}))
        .await;
    assert_eq!(host.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_native_origin_is_refused_under_tailscale() {
    let gateway = gateway().await;
    let response = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", "https://127.0.0.1:48621")
        .header("Content-Type", "application/json")
        .json(&json!({"code": "AAAA-AAAA"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn native_login_answers_uniformly_and_approves_through_the_owner() {
    let gateway = native_gateway().await;
    let wrong = gateway.login(json!({"username": "owner", "password": "definitely wrong"})).await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.json::<Value>().await.unwrap()["error"]["code"], "login_invalid");
    let wrong_user = gateway.login(json!({"username": "nobody", "password": "correct horse battery"})).await;
    assert_eq!(wrong_user.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_user.json::<Value>().await.unwrap()["error"]["code"], "login_invalid");

    let pending = gateway
        .login(json!({"username": "owner", "password": "correct horse battery", "name": "Pixel 8", "kind": "phone", "platform": "Android 15"}))
        .await;
    assert_eq!(pending.status(), StatusCode::ACCEPTED);
    let pair_cookie = cookie_of(&pending, PAIR_COOKIE).expect("a pair cookie");
    assert_eq!(pending.json::<Value>().await.unwrap()["state"], "pending");
    let requested = super::events_last(&gateway.st, "remote.pairing.requested").await;
    assert_eq!(requested["payload"]["method"], "native");
    assert!(requested["payload"]["login"].is_null());
    let pairing_id = requested["payload"]["pairingId"].as_str().unwrap().to_string();
    let approved = super::rpc(&gateway.st, "remote.pair.confirm", &json!({"pairingId": pairing_id, "approve": true, "tier": "chat"}))
        .await
        .unwrap();
    assert_eq!(approved["approved"], true);
    let polled = gateway.get("/api/pair", Some(&pair_cookie)).await;
    assert_eq!(polled.status(), StatusCode::OK);
    let device_cookie = cookie_of(&polled, DEVICE_COOKIE).expect("a device cookie");
    let me: Value = gateway.get("/api/me", Some(&device_cookie)).await.json().await.unwrap();
    assert_eq!(me["method"], "native");
    // Signing in again with the cookie is approved at once.
    let again = gateway
        .login_with(&device_cookie, json!({"username": "owner", "password": "correct horse battery"}))
        .await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(again.json::<Value>().await.unwrap()["state"], "approved");
}

#[tokio::test]
async fn a_revoked_native_device_must_sign_in_again() {
    let gateway = native_gateway().await;
    let (device_id, device_cookie) = approve_native_device(&gateway).await;
    let approved = gateway
        .login_with(&device_cookie, json!({"username": "owner", "password": "correct horse battery"}))
        .await;
    assert_eq!(approved.status(), StatusCode::OK);
    super::rpc(&gateway.st, "remote.devices.revoke", &json!({"deviceId": device_id})).await.unwrap();
    let after = gateway
        .login_with(&device_cookie, json!({"username": "owner", "password": "correct horse battery"}))
        .await;
    assert_eq!(after.status(), StatusCode::ACCEPTED);
    assert_eq!(after.json::<Value>().await.unwrap()["state"], "pending");
}

#[tokio::test]
async fn native_account_set_validates_and_argon2_verifies() {
    let (st, _events) = crate::phase2a_tests::state();
    for bad in [
        json!({"username": "", "password": "correct horse battery"}),
        json!({"username": "a".repeat(65), "password": "correct horse battery"}),
        json!({"username": "owner", "password": "short"}),
        json!({"username": "same", "password": "same"}),
    ] {
        let error = super::rpc(&st, "remote.native.account.set", &bad).await.unwrap_err();
        assert_eq!(error.1.code, "invalid_argument", "{bad}");
    }
    let saved = super::rpc(&st, "remote.native.account.set", &json!({"username": "owner", "password": "correct horse battery"}))
        .await
        .unwrap();
    assert_eq!(saved, json!({"accountSet": true, "username": "owner"}));
    let account = super::native::account_of(&st).unwrap();
    assert_eq!(account.username, "owner");
    assert!(account.hash.starts_with("$argon2id$"), "{}", account.hash);
    assert!(!account.hash.contains("correct horse battery"));
    assert!(super::native::verify_login(&account, "owner", "correct horse battery"));
    assert!(!super::native::verify_login(&account, "owner", "wrong password!!"));
    assert!(!super::native::verify_login(&account, "someone else", "correct horse battery"));
}

#[tokio::test]
async fn native_login_lockout_locks_the_source_and_writes_a_denied_line() {
    let gateway = native_gateway().await;
    for _ in 0..4 {
        let response = gateway.login(json!({"username": "owner", "password": "wrong password!!"})).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    // The fifth failure locks the source.
    let fifth = gateway.login(json!({"username": "owner", "password": "wrong password!!"})).await;
    assert_eq!(fifth.status(), StatusCode::TOO_MANY_REQUESTS);
    // Even the right password is refused while locked.
    let right = gateway.login(json!({"username": "owner", "password": "correct horse battery"})).await;
    assert_eq!(right.status(), StatusCode::TOO_MANY_REQUESTS);
    let entries = gateway.st.db.remote_activity_list(100).unwrap();
    assert!(entries.iter().any(|entry| entry["kind"] == "denied"), "a denied activity line");
    assert!(entries.iter().all(|entry| !entry["summary"].as_str().unwrap_or("").contains("owner")), "no username in a summary");
}

#[tokio::test]
async fn native_global_pause_pauses_every_sign_in_and_flags_the_change() {
    let gateway = native_gateway().await;
    // Twenty-nine failures from other sources, then one over HTTP reaches the cap.
    for index in 0..29 {
        gateway.st.remote.record_login_failure(&format!("10.0.0.{index}"));
    }
    let trigger = gateway.login(json!({"username": "owner", "password": "wrong password!!"})).await;
    assert_eq!(trigger.status(), StatusCode::UNAUTHORIZED);
    let (paused, until) = gateway.st.remote.login_pause_state();
    assert!(paused);
    assert!(until.is_some());
    let changed = super::events_last(&gateway.st, "remote.changed").await;
    assert_eq!(changed["payload"]["status"]["native"]["loginPaused"], true);
    // A later sign-in, even with the right password, is refused.
    let right = gateway.login(json!({"username": "owner", "password": "correct horse battery"})).await;
    assert_eq!(right.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn native_refuses_pair_codes_and_method_switches_while_on() {
    let gateway = native_gateway().await;
    assert_eq!(super::rpc(&gateway.st, "remote.pair.begin", &json!({})).await.unwrap_err().1.code, "conflict");
    assert_eq!(super::rpc(&gateway.st, "remote.method.set", &json!({"method": "tailscale"})).await.unwrap_err().1.code, "conflict");
    // With Remote off, the switch is allowed.
    super::disable(&gateway.st).await.unwrap();
    let switched = super::rpc(&gateway.st, "remote.method.set", &json!({"method": "tailscale"})).await.unwrap();
    assert_eq!(switched["method"], "tailscale");
}

#[tokio::test]
async fn native_enable_needs_an_account() {
    let (st, _events) = crate::phase2a_tests::state();
    let dir = std::env::temp_dir().join(format!("bitbots-native-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    *st.team.data_dir.lock().unwrap() = Some(dir.clone());
    st.db.set_setting("remote.method", &json!("native")).unwrap();
    st.db.set_setting("remote.native.port", &json!(0)).unwrap();
    let error = super::enable(&st).await.unwrap_err();
    assert_eq!(error.1.code, "conflict");
    assert!(error.1.message.contains("username and password"), "{}", error.1.message);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn native_status_reports_the_native_block() {
    let gateway = native_gateway().await;
    // A sign-in records where it came from; this proves the peer address is read
    // from the connection, not defaulted to "loopback".
    let _ = gateway.login(json!({"username": "owner", "password": "not the password"})).await;
    let status = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    // The connection's address is read, but a loopback/private peer is only
    // ever reported as "this network" (FIX35 C2 §4).
    assert_eq!(status["native"]["lastReachedFrom"], "this network");
    assert_eq!(status["method"], "native");
    let native = &status["native"];
    assert_eq!(native["port"], gateway.port);
    assert_eq!(native["accountSet"], true);
    assert_eq!(native["username"], "owner");
    assert_eq!(native["listening"], true);
    assert_eq!(native["loginPaused"], false);
    assert!(native["fingerprint"].as_str().unwrap().contains(':'));
    assert!(native["urls"].as_array().unwrap().iter().any(|url| url.as_str().unwrap().ends_with(&format!(":{}", gateway.port))));
}

#[tokio::test]
async fn native_port_set_validates_and_requires_remote_off() {
    let gateway = native_gateway().await;
    assert_eq!(super::rpc(&gateway.st, "remote.native.port.set", &json!({"port": 5000})).await.unwrap_err().1.code, "conflict");
    super::disable(&gateway.st).await.unwrap();
    assert_eq!(super::rpc(&gateway.st, "remote.native.port.set", &json!({"port": 80})).await.unwrap_err().1.code, "invalid_argument");
    let saved = super::rpc(&gateway.st, "remote.native.port.set", &json!({"port": 49001})).await.unwrap();
    assert_eq!(saved["port"], 49001);
}

#[tokio::test]
async fn native_cert_regenerate_restarts_and_changes_the_fingerprint() {
    let gateway = native_gateway().await;
    let before = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap()["native"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_string();
    let after = super::rpc(&gateway.st, "remote.native.cert.regenerate", &json!({})).await.unwrap();
    let after_fingerprint = after["fingerprint"].as_str().unwrap().to_string();
    assert_ne!(before, after_fingerprint);
    assert!(gateway.st.remote.native_listening(), "the listener restarted");
}

// ---------------------------------------------------------------------------
// Native Remote connectivity (FIX35 C2)

/// A fake router: no socket is ever opened. The test decides what it answers.
struct FakeUpnp {
    external: std::sync::Mutex<std::net::IpAddr>,
    added: std::sync::Mutex<Vec<(u16, std::net::SocketAddr, u32, String)>>,
    removed: std::sync::Mutex<Vec<u16>>,
    fail_add: bool,
}

impl FakeUpnp {
    fn new(external: &str) -> Self {
        Self {
            external: std::sync::Mutex::new(external.parse().unwrap()),
            added: std::sync::Mutex::new(Vec::new()),
            removed: std::sync::Mutex::new(Vec::new()),
            fail_add: false,
        }
    }

    fn failing(external: &str) -> Self {
        Self { fail_add: true, ..Self::new(external) }
    }

    fn set_external(&self, external: &str) {
        *self.external.lock().unwrap() = external.parse().unwrap();
    }

    fn added(&self) -> Vec<(u16, std::net::SocketAddr, u32, String)> {
        self.added.lock().unwrap().clone()
    }

    fn removed(&self) -> Vec<u16> {
        self.removed.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl connectivity::UpnpGateway for FakeUpnp {
    async fn external_ip(&self) -> Result<std::net::IpAddr, String> {
        Ok(*self.external.lock().unwrap())
    }

    async fn add_mapping(
        &self,
        external_port: u16,
        local_addr: std::net::SocketAddr,
        lease: u32,
        description: &str,
    ) -> Result<(), String> {
        if self.fail_add {
            return Err("the gateway refused the mapping".to_string());
        }
        self.added.lock().unwrap().push((external_port, local_addr, lease, description.to_string()));
        Ok(())
    }

    async fn remove_mapping(&self, external_port: u16) -> Result<(), String> {
        self.removed.lock().unwrap().push(external_port);
        Ok(())
    }
}

/// Seeds the fake gateway and a fixed firewall reading, so no test runs `netsh`
/// or searches the network.
fn seed_connectivity(gateway: &NativeGateway, fake: Option<Arc<FakeUpnp>>) {
    *gateway.st.remote.seams.lock().unwrap() = connectivity::TestSeams {
        upnp_active: true,
        gateway: fake.map(|fake| fake as Arc<dyn connectivity::UpnpGateway>),
        firewall: Some(connectivity::FirewallState::Allowed),
    };
}

#[test]
fn native_cgnat_classification_matches_the_spec() {
    use std::net::IpAddr;
    let ip = |text: &str| text.parse::<IpAddr>().unwrap();
    assert_eq!(connectivity::classify(Some(ip("100.64.0.1"))), (true, Some("carrier_nat")));
    assert_eq!(connectivity::classify(Some(ip("100.127.255.255"))), (true, Some("carrier_nat")));
    for private in ["10.1.2.3", "192.168.0.5", "172.16.4.4", "172.31.0.1", "169.254.10.1", "fd00::1", "fc00::1", "fe80::1"] {
        assert_eq!(connectivity::classify(Some(ip(private))), (true, Some("private")), "{private}");
    }
    for public in ["1.1.1.1", "8.8.4.4", "100.63.0.1", "100.128.0.1", "2606:4700:4700::1111"] {
        assert_eq!(connectivity::classify(Some(ip(public))), (false, None), "{public}");
    }
    assert_eq!(connectivity::classify(None), (false, None));
}

#[test]
fn native_firewall_parses_recorded_output_and_builds_the_exact_argv() {
    use connectivity::FirewallState;
    let missing = "No rules match the specified criteria.\r\n";
    assert_eq!(connectivity::parse_firewall(missing, 48621), FirewallState::Missing);
    let allowed = "\r\nRule Name:                            Bitbots-Remote\r\n----------------------------------------------------------------------\r\nEnabled:                              Yes\r\nDirection:                            In\r\nProfiles:                             Domain,Private,Public\r\nLocalPort:                            48621\r\n";
    assert_eq!(connectivity::parse_firewall(allowed, 48621), FirewallState::Allowed);
    assert_eq!(connectivity::parse_firewall(allowed, 48620), FirewallState::Missing, "a rule for another port is not this port");
    // The old name (with a space) is still read as a rule for this port.
    let legacy = allowed.replace("Bitbots-Remote", "Bitbots Remote");
    assert_eq!(connectivity::parse_firewall(&legacy, 48621), FirewallState::Allowed);
    assert_eq!(connectivity::firewall_state_from(false, Some(allowed), 48621), FirewallState::Unsupported);
    assert_eq!(connectivity::firewall_state_from(true, None, 48621), FirewallState::Unknown);

    assert_eq!(connectivity::show_rule_args(connectivity::FIREWALL_RULE_NAME).last().unwrap(), "name=Bitbots-Remote");
    let add = connectivity::elevated_command(&connectivity::add_rule_args(48621));
    assert_eq!(add[0], "powershell");
    assert_eq!(add[1], "-NoProfile");
    assert_eq!(add[2], "-NonInteractive");
    assert_eq!(add[3], "-Command");
    assert_eq!(
        add[4],
        "Start-Process -FilePath netsh -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('advfirewall','firewall','add','rule','name=Bitbots-Remote','dir=in','action=allow','protocol=TCP','localport=48621')"
    );
    // Remove deletes one rule: the current name.
    let remove = connectivity::elevated_command(&connectivity::remove_rule_args());
    assert_eq!(
        remove[4],
        "Start-Process -FilePath netsh -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('advfirewall','firewall','delete','rule','name=Bitbots-Remote')"
    );
}

#[test]
fn native_ping_reports_a_public_peer_but_not_a_private_one() {
    let public: std::net::SocketAddr = "8.8.8.8:51234".parse().unwrap();
    assert_eq!(super::web::reached_from(Some(public)), "8.8.8.8");
    for private in ["127.0.0.1:4000", "192.168.1.20:4000", "10.0.0.9:4000", "[fe80::1]:4000"] {
        let addr: std::net::SocketAddr = private.parse().unwrap();
        assert_eq!(super::web::reached_from(Some(addr)), "this network", "{private}");
    }
    assert_eq!(super::web::reached_from(None), "this network");
}

#[tokio::test]
async fn native_upnp_maps_only_with_consent_and_removes_its_own_mapping() {
    let gateway = native_gateway().await;
    let fake = Arc::new(FakeUpnp::new("203.0.113.7"));
    seed_connectivity(&gateway, Some(fake.clone()));
    let port = gateway.st.remote.native_bound().unwrap().port();

    // Without consent nothing is mapped.
    connectivity::enable(&gateway.st).await;
    assert!(fake.added().is_empty(), "no mapping without consent");
    let status = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(status["native"]["upnp"]["state"], "off");
    assert_eq!(status["native"]["upnp"]["consent"], false);
    assert_eq!(status["native"]["firewall"], "allowed");

    // Consent is stored and acted on at once.
    let saved = super::rpc(&gateway.st, "remote.native.upnp.set", &json!({"enabled": true})).await.unwrap();
    assert_eq!(saved["upnp"]["state"], "mapped");
    let added = fake.added();
    assert_eq!(added.len(), 1, "one mapping");
    assert_eq!(added[0].0, port);
    assert_eq!(added[0].1.port(), port);
    assert_eq!(added[0].2, connectivity::MAPPING_LEASE_SECS);
    assert_eq!(added[0].3, connectivity::MAPPING_DESCRIPTION);
    let status = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(status["native"]["upnp"]["state"], "mapped");
    assert_eq!(status["native"]["upnp"]["consent"], true);
    assert_eq!(status["native"]["externalIp"], "203.0.113.7");
    assert_eq!(status["native"]["externalIpSource"], "upnp");
    assert_eq!(status["native"]["cgnat"], false);

    // A renewal re-adds the same mapping with the same lease.
    connectivity::renew_mapping(&gateway.st).await;
    assert_eq!(fake.added().len(), 2, "the lease was renewed");
    assert_eq!(fake.added()[0], fake.added()[1]);

    // Withdrawing consent removes only Bitbots' mapping.
    super::rpc(&gateway.st, "remote.native.upnp.set", &json!({"enabled": false})).await.unwrap();
    assert_eq!(fake.removed(), vec![port]);
    assert_eq!(fake.added().len(), 2, "nothing else was added");
    let status = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(status["native"]["upnp"]["state"], "off");
}

#[tokio::test]
async fn native_upnp_reports_no_gateway_and_a_failed_mapping() {
    let gateway = native_gateway().await;
    seed_connectivity(&gateway, None);
    super::rpc(&gateway.st, "remote.native.upnp.set", &json!({"enabled": true})).await.unwrap();
    let status = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(status["native"]["upnp"]["state"], "no_gateway");
    assert_eq!(status["native"]["upnp"]["consent"], true);
    assert_eq!(status["native"]["externalIp"], Value::Null);

    let failable = Arc::new(FakeUpnp::failing("203.0.113.7"));
    seed_connectivity(&gateway, Some(failable));
    connectivity::enable(&gateway.st).await;
    let status = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(status["native"]["upnp"]["state"], "failed");
    assert!(status["native"]["upnp"]["error"].is_string(), "{status}");
}

#[tokio::test]
async fn native_external_ip_change_updates_the_urls_and_the_certificate() {
    let gateway = native_gateway().await;
    let fake = Arc::new(FakeUpnp::new("198.51.100.9"));
    seed_connectivity(&gateway, Some(fake.clone()));
    super::rpc(&gateway.st, "remote.native.upnp.set", &json!({"enabled": true})).await.unwrap();

    let first = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(first["native"]["externalIp"], "198.51.100.9");
    let before_fingerprint = first["native"]["fingerprint"].clone();

    // The router hands out a new address.
    fake.set_external("198.51.100.20");
    connectivity::recheck_external_ip(&gateway.st).await;

    let after = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(after["native"]["externalIp"], "198.51.100.20");
    assert_ne!(after["native"]["fingerprint"], before_fingerprint, "the certificate was regenerated for the new name");
    let urls: Vec<String> = after["native"]["urls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|url| url.as_str().unwrap().to_string())
        .collect();
    assert!(urls.iter().any(|url| url.contains("198.51.100.20")), "{urls:?}");
    assert!(!urls.iter().any(|url| url.contains("198.51.100.9")), "{urls:?}");
    let changed = super::events_last(&gateway.st, "remote.changed").await;
    assert_eq!(changed["payload"]["status"]["native"]["externalIp"], "198.51.100.20");
}

#[tokio::test]
async fn native_manual_external_ip_uses_the_key_the_certificate_reads() {
    let gateway = native_gateway().await;
    let before = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap()["native"]["fingerprint"].clone();

    let saved = super::rpc(&gateway.st, "remote.native.externalIp.set", &json!({"ip": "203.0.113.55"})).await.unwrap();
    assert_eq!(saved["externalIp"], "203.0.113.55");
    assert_eq!(saved["externalIpSource"], "manual");
    assert_eq!(saved["cgnat"], false);
    // C1's certificate reads exactly this key.
    let settings = gateway.st.db.settings().unwrap();
    assert_eq!(settings.get(super::native::EXTERNAL_IP_SETTING).and_then(Value::as_str), Some("203.0.113.55"));

    let after = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_ne!(after["native"]["fingerprint"], before, "the certificate SANs were regenerated");
    assert!(after["native"]["urls"]
        .as_array()
        .unwrap()
        .iter()
        .any(|url| url.as_str().unwrap().contains("203.0.113.55")));

    // A private value is flagged, not rejected.
    let private = super::rpc(&gateway.st, "remote.native.externalIp.set", &json!({"ip": "192.168.1.4"})).await.unwrap();
    assert_eq!(private["cgnat"], true);
    assert_eq!(private["cgnatReason"], "private");

    // Clearing it removes the name again.
    let cleared = super::rpc(&gateway.st, "remote.native.externalIp.set", &json!({"ip": null})).await.unwrap();
    assert_eq!(cleared["externalIp"], Value::Null);
    assert_eq!(cleared["externalIpSource"], Value::Null);
    assert_eq!(cleared["cgnat"], false);

    // Bad input is refused, and nothing is written.
    assert_eq!(
        super::rpc(&gateway.st, "remote.native.externalIp.set", &json!({"ip": "not an ip"})).await.unwrap_err().1.code,
        "invalid_argument"
    );
}

#[tokio::test]
async fn native_ping_is_open_and_records_where_it_came_from() {
    let gateway = native_gateway().await;
    // No Origin header: a phone opening the address in its browser proves the
    // route is unauthenticated and exempt from the origin check.
    let response = gateway.client.get(gateway.url("/api/ping")).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap(), json!({"ok": true}));

    let status = super::rpc(&gateway.st, "remote.status", &json!({})).await.unwrap();
    assert_eq!(status["native"]["lastReachedFrom"], "this network");
    assert!(status["native"]["lastReachedAt"].is_string(), "{status}");
    let changed = super::events_last(&gateway.st, "remote.changed").await;
    assert_eq!(changed["payload"]["status"]["native"]["lastReachedFrom"], "this network");
}

#[tokio::test]
async fn native_ping_shares_the_unauthenticated_rate_limit() {
    let gateway = native_gateway().await;
    let mut limited = false;
    for _ in 0..70 {
        let response = gateway.client.get(gateway.url("/api/ping")).send().await.unwrap();
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(limited, "the ping route is limited by C1's unauthenticated bucket");
}

#[tokio::test]
async fn native_failed_sign_ins_write_a_denied_line_only_when_a_limit_starts() {
    let gateway = native_gateway().await;
    for _ in 0..4 {
        let response = gateway.login(json!({"username": "owner", "password": "wrong password!!"})).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let before = gateway.st.db.remote_activity_list(100).unwrap();
    assert!(before.iter().all(|entry| entry["kind"] != "denied"), "four failures write nothing: {before:?}");

    // The fifth failure starts the source's lockout: exactly one line.
    let fifth = gateway.login(json!({"username": "owner", "password": "wrong password!!"})).await;
    assert_eq!(fifth.status(), StatusCode::TOO_MANY_REQUESTS);
    let after = gateway.st.db.remote_activity_list(100).unwrap();
    let denied: Vec<&Value> = after.iter().filter(|entry| entry["kind"] == "denied").collect();
    assert_eq!(denied.len(), 1, "{after:?}");

    // A request refused because the lockout is already running writes nothing.
    let again = gateway.login(json!({"username": "owner", "password": "wrong password!!"})).await;
    assert_eq!(again.status(), StatusCode::TOO_MANY_REQUESTS);
    let more = gateway.st.db.remote_activity_list(100).unwrap();
    assert_eq!(more.iter().filter(|entry| entry["kind"] == "denied").count(), 1, "the lockout did not flood the log");
}

#[tokio::test]
async fn native_global_pause_writes_one_denied_line() {
    let gateway = native_gateway().await;
    for index in 0..29 {
        gateway.st.remote.record_login_failure(&format!("10.0.0.{index}"));
    }
    let before = gateway.st.db.remote_activity_list(100).unwrap();
    assert!(before.iter().all(|entry| entry["kind"] != "denied"), "seeded failures write nothing");

    // The thirtieth failure across all sources pauses every sign-in.
    let trigger = gateway.login(json!({"username": "owner", "password": "wrong password!!"})).await;
    assert_eq!(trigger.status(), StatusCode::UNAUTHORIZED);
    let (paused, _) = gateway.st.remote.login_pause_state();
    assert!(paused);
    let entries = gateway.st.db.remote_activity_list(100).unwrap();
    let denied: Vec<&Value> = entries.iter().filter(|entry| entry["kind"] == "denied").collect();
    assert_eq!(denied.len(), 1, "one line for the pause: {entries:?}");
}

// ---------------------------------------------------------------------------
// Browser-like end-to-end flow (FIX38 H1)
//
// These tests drive the gateway exactly as a browser does, not as `curl` does:
// a cookie jar that keeps what the host sets, no `Origin` on same-origin
// `GET`/`HEAD` (Fetch standard), `Origin` on `POST` and the WebSocket handshake,
// and `Sec-Fetch-Site: same-origin` on every request. That is the header shape
// the beta.32 phone sends — and the shape `require_origin` used to refuse.

/// The names a browser may set. Only what the host sends is kept.
const COOKIE_NAMES: [&str; 2] = [DEVICE_COOKIE, PAIR_COOKIE];

/// A minimal, browser-faithful cookie jar: stores `name=value`, honours
/// `Max-Age=0` as a delete, and joins what it holds into one `Cookie` header.
#[derive(Default)]
struct BrowserJar {
    cookies: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl BrowserJar {
    fn header(&self) -> Option<String> {
        let cookies = self.cookies.lock().unwrap();
        if cookies.is_empty() {
            return None;
        }
        Some(COOKIE_NAMES.iter().filter_map(|name| cookies.get(*name).map(|value| format!("{name}={value}"))).collect::<Vec<_>>().join("; "))
    }

    fn absorb(&self, response: &reqwest::Response) {
        for value in response.headers().get_all("set-cookie").iter() {
            let Ok(text) = value.to_str() else { continue };
            let mut parts = text.split(';');
            let Some((name, value)) = parts.next().and_then(|pair| pair.split_once('=')) else { continue };
            let name = name.trim();
            let value = value.trim();
            let expired = parts.any(|attribute| attribute.trim().eq_ignore_ascii_case("max-age=0"));
            let mut cookies = self.cookies.lock().unwrap();
            if value.is_empty() || expired {
                cookies.remove(name);
            } else {
                cookies.insert(name.to_string(), value.to_string());
            }
        }
    }
}

/// A browser talking to one gateway. `base` is where it points its address bar
/// and `origin` is what it puts in `Origin` on a state-changing request.
struct Browser {
    client: reqwest::Client,
    base: String,
    origin: String,
    jar: BrowserJar,
}

impl Browser {
    fn tailscale(port: u16) -> Self {
        Self::new(format!("http://127.0.0.1:{port}"), ORIGIN.to_string(), false)
    }

    fn native(port: u16) -> Self {
        let base = format!("https://127.0.0.1:{port}");
        Self::new(base.clone(), base, true)
    }

    fn new(base: String, origin: String, insecure: bool) -> Self {
        let mut builder = reqwest::Client::builder().no_proxy();
        if insecure {
            builder = builder.danger_accept_invalid_certs(true);
        }
        Self {
            client: builder.build().unwrap(),
            base,
            origin,
            jar: BrowserJar::default(),
        }
    }

    /// A same-origin `GET`: no `Origin`, `Sec-Fetch-Site: same-origin`, cookies.
    async fn get(&self, path: &str) -> reqwest::Response {
        let mut request = self.client.get(format!("{}{path}", self.base)).header("Sec-Fetch-Site", "same-origin");
        if let Some(cookie) = self.jar.header() {
            request = request.header("Cookie", cookie);
        }
        let response = request.send().await.unwrap();
        self.jar.absorb(&response);
        response
    }

    /// A same-origin `POST`: `Origin` and `Sec-Fetch-Site: same-origin`, cookies.
    async fn post(&self, path: &str, body: &Value) -> reqwest::Response {
        let mut request = self
            .client
            .post(format!("{}{path}", self.base))
            .header("Origin", &self.origin)
            .header("Sec-Fetch-Site", "same-origin")
            .header("Content-Type", "application/json");
        if let Some(cookie) = self.jar.header() {
            request = request.header("Cookie", cookie);
        }
        let response = request.json(body).send().await.unwrap();
        self.jar.absorb(&response);
        response
    }

    /// Opens `/api/events` as a browser does: the handshake carries `Origin` and
    /// the device cookie.
    async fn socket(&self) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
        let mut request = format!("{}/api/events", self.base).replace("http://", "ws://").replace("https://", "wss://").into_client_request().unwrap();
        request.headers_mut().insert("Origin", self.origin.parse().unwrap());
        if let Some(cookie) = self.jar.header() {
            request.headers_mut().insert("Cookie", cookie.parse().unwrap());
        }
        let (socket, _) = tokio_tungstenite::connect_async(request).await.expect("the upgrade succeeds");
        socket
    }
}

#[tokio::test]
async fn tailscale_pairing_completes_for_a_browser() {
    let gateway = gateway().await;
    let code = dispatch(&gateway.st, "remote.pair.begin", json!({})).await.unwrap()["code"].as_str().unwrap().to_string();
    let browser = Browser::tailscale(gateway.port);

    // A signed-out browser first asks who it is. Browsers send no Origin on a
    // same-origin GET; the answer is 401 (no cookie), never 403 (no Origin).
    let me = browser.get("/api/me").await;
    assert_eq!(me.status(), StatusCode::UNAUTHORIZED, "a GET without Origin must reach the handler");
    assert_eq!(me.json::<Value>().await.unwrap()["error"]["code"], "unauthorized");

    // The poll with no offer yet is `expired`, again without an Origin.
    let idle = browser.get("/api/pair").await;
    assert_eq!(idle.status(), StatusCode::OK);
    assert_eq!(idle.json::<Value>().await.unwrap()["state"], "expired");

    // Submitting the code carries an Origin and locks the offer.
    let submitted = browser
        .post("/api/pair", &json!({"code": code, "name": "Pixel 8", "kind": "phone", "platform": "Android 15"}))
        .await;
    assert_eq!(submitted.status(), StatusCode::ACCEPTED);
    assert_eq!(submitted.json::<Value>().await.unwrap()["state"], "pending");
    let requested = super::events_last(&gateway.st, "remote.pairing.requested").await;
    assert_eq!(requested["payload"]["name"], "Pixel 8");
    let pairing_id = requested["payload"]["pairingId"].as_str().unwrap().to_string();

    // The owner approves on the desktop.
    super::rpc(&gateway.st, "remote.pair.confirm", &json!({"pairingId": pairing_id, "approve": true, "tier": "chat"})).await.unwrap();

    // The phone's poll (no Origin) now sees the approval and is handed the
    // device cookie; the browser keeps it.
    let polled = browser.get("/api/pair").await;
    assert_eq!(polled.status(), StatusCode::OK);
    let approved: Value = polled.json().await.unwrap();
    assert_eq!(approved["state"], "approved");
    assert!(browser.jar.header().is_some_and(|cookie| cookie.contains(DEVICE_COOKIE)), "the browser kept the device cookie");

    // /api/me (no Origin) now answers, with the device cookie.
    let me = browser.get("/api/me").await;
    assert_eq!(me.status(), StatusCode::OK);
    let me: Value = me.json().await.unwrap();
    assert_eq!(me["device"]["tier"], "chat");
    assert_eq!(me["method"], "tailscale");

    // A state-changing RPC needs its Origin and works.
    let rpc = browser.post("/api/rpc", &json!({"v": 1, "id": "req_1", "method": "daemon.health", "params": {}})).await;
    assert_eq!(rpc.status(), StatusCode::OK);
    assert_eq!(rpc.json::<Value>().await.unwrap()["ok"], true);

    // The events socket opens with the Origin a browser always sends there.
    let mut socket = browser.socket().await;
    let frame = gateway.cursor(&mut socket, 0).await;
    assert!(frame["type"].is_string(), "the socket streamed a frame: {frame}");
}

#[tokio::test]
async fn native_pairing_completes_for_a_browser() {
    let gateway = native_gateway().await;
    let browser = Browser::native(gateway.port);

    // Signing in carries an Origin.
    let signed = browser
        .post("/api/login", &json!({"username": "owner", "password": "correct horse battery", "name": "Pixel 8", "kind": "phone", "platform": "Android 15"}))
        .await;
    assert_eq!(signed.status(), StatusCode::ACCEPTED);
    assert_eq!(signed.json::<Value>().await.unwrap()["state"], "pending");
    let pairing_id = super::events_last(&gateway.st, "remote.pairing.requested").await["payload"]["pairingId"].as_str().unwrap().to_string();
    super::rpc(&gateway.st, "remote.pair.confirm", &json!({"pairingId": pairing_id, "approve": true, "tier": "operator"})).await.unwrap();

    // The poll (no Origin) approves and sets the cookie.
    let polled = browser.get("/api/pair").await;
    assert_eq!(polled.status(), StatusCode::OK);
    assert_eq!(polled.json::<Value>().await.unwrap()["state"], "approved");
    assert!(browser.jar.header().is_some_and(|cookie| cookie.contains(DEVICE_COOKIE)));
    let me = browser.get("/api/me").await;
    assert_eq!(me.status(), StatusCode::OK);
    let me: Value = me.json().await.unwrap();
    assert_eq!(me["method"], "native");
    assert_eq!(me["device"]["tier"], "operator");
    let rpc = browser.post("/api/rpc", &json!({"v": 1, "id": "req_1", "method": "daemon.health", "params": {}})).await;
    assert_eq!(rpc.status(), StatusCode::OK);
    assert_eq!(rpc.json::<Value>().await.unwrap()["ok"], true);
}

#[tokio::test]
async fn a_cross_site_request_is_refused_on_both_methods() {
    // Tailscale: a cross-site POST (Origin + Sec-Fetch-Site) is refused.
    let gateway = gateway().await;
    let cross = gateway
        .client
        .post(gateway.url("/api/pair"))
        .header("Origin", "https://evil.example")
        .header("Sec-Fetch-Site", "cross-site")
        .json(&json!({"code": "AAAA-AAAA"}))
        .send()
        .await
        .unwrap();
    assert_eq!(cross.status(), StatusCode::FORBIDDEN);
    assert_eq!(cross.json::<Value>().await.unwrap()["error"]["code"], "forbidden_origin");
    // A cross-site GET (no Origin, Sec-Fetch-Site: cross-site) is refused too.
    for site in ["cross-site", "same-site"] {
        let response = gateway.client.get(gateway.url("/api/pair")).header("Sec-Fetch-Site", site).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "Sec-Fetch-Site: {site}");
    }
    // A same-origin GET with a wrong Origin is refused.
    let wrong = gateway.client.get(gateway.url("/api/pair")).header("Origin", "https://evil.example.ts.net").header("Sec-Fetch-Site", "same-origin").send().await.unwrap();
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);

    // Native: the Tailscale origin is refused, and a cross-site GET as well.
    let native = native_gateway().await;
    let foreign = native
        .post("/api/login", "127.0.0.1", "https://work-pc.tail1234.ts.net", None, &json!({}))
        .await;
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
    let cross_get = native.client.get(native.url("/api/me")).header("Sec-Fetch-Site", "cross-site").send().await.unwrap();
    assert_eq!(cross_get.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_websocket_upgrade_without_an_origin_is_refused() {
    let gateway = gateway().await;
    let (_, token) = seed_device(&gateway.st, "dev-ws", "chat", None);
    let mut request = gateway.url("/api/events").replace("http://", "ws://").into_client_request().unwrap();
    request.headers_mut().insert("Cookie", format!("{DEVICE_COOKIE}={token}").parse().unwrap());
    match tokio_tungstenite::connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => assert_eq!(response.status(), StatusCode::FORBIDDEN),
        other => panic!("expected a 403 upgrade: {other:?}"),
    }
}

