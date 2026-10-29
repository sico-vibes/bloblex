//! Two stdio MCP servers that forward to the running daemon. Messages are
//! newline-delimited JSON-RPC; nothing but protocol output is written to stdout.
//!
//! - `bitbotsd mcp-bridge`: launched by a provider CLI Bitbots starts. It
//!   forwards tool listing and calls to the daemon, authorized by the
//!   per-session token in `BLOBLEX_MCP_TOKEN` (`mcp.tools.*`).
//! - `bitbotsd mcp-server --endpoint <file>` (wave 14): launched by an outside
//!   Claude Code session the owner connected. It reads `{address, token}` from
//!   the endpoint file Bitbots writes while the Bitbots MCP is on, forwards to
//!   `ext.tools.*`, and reads the file again when the daemon answers 401 or
//!   cannot be reached, so a rotated token or a restarted Bitbots is picked up
//!   without restarting the client.
//!
//! Each request is handled on its own task, so a long `wait_for_turn` never
//! blocks a `steer` or `stop_turn` that arrives meanwhile.

use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
    time::{timeout, Duration},
};

const PROTOCOL_VERSION: &str = "2025-06-18";
/// The team bridge's request timeout.
const TEAM_TIMEOUT: Duration = Duration::from_secs(60);
/// The Bitbots MCP's request timeout: `wait_for_turn` may wait up to 600 s, plus a margin.
const EXTERNAL_TIMEOUT: Duration = Duration::from_secs(660);
/// How long the hello after `initialize` may take; it never holds up the client for long.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// Why a forwarded call failed.
#[derive(Debug)]
enum Failure {
    /// The daemon answered 401: the token is stale or the feature is off.
    Unauthorized,
    /// The daemon is not running, not reachable or not yet known.
    Unreachable(String),
    /// Anything else, already worded for the client.
    Other(String),
}

struct Backend {
    /// The endpoint file of the Bitbots MCP; `None` for the team bridge.
    endpoint: Option<PathBuf>,
    creds: StdMutex<(String, String)>,
    timeout: Duration,
}

impl Backend {
    fn team_with(address: &str, token: &str) -> Self {
        Self { endpoint: None, creds: StdMutex::new((address.to_owned(), token.to_owned())), timeout: TEAM_TIMEOUT }
    }

    fn external(endpoint: PathBuf) -> Self {
        let creds = read_endpoint(&endpoint).unwrap_or_default();
        Self { endpoint: Some(endpoint), creds: StdMutex::new(creds), timeout: EXTERNAL_TIMEOUT }
    }

    fn is_external(&self) -> bool {
        self.endpoint.is_some()
    }

    fn list_method(&self) -> &'static str {
        if self.is_external() { "ext.tools.list" } else { "mcp.tools.list" }
    }

    fn call_method(&self) -> &'static str {
        if self.is_external() { "ext.tools.call" } else { "mcp.tools.call" }
    }

    /// Reads the endpoint file again; true when it names a different address or token.
    fn reload(&self) -> bool {
        let Some(fresh) = self.endpoint.as_deref().and_then(read_endpoint) else { return false };
        let mut creds = self.creds.lock().unwrap_or_else(|poison| poison.into_inner());
        let changed = *creds != fresh;
        *creds = fresh;
        changed
    }

    async fn attempt(&self, method: &str, params: &Value) -> Result<Value, Failure> {
        let (address, token) = self.creds.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
        post(&address, &token, method, params.clone(), self.timeout).await
    }

    /// One forwarded call. The external server tries once more after reading a
    /// changed endpoint file.
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        match self.attempt(method, &params).await {
            Ok(value) => Ok(value),
            Err(failure @ (Failure::Unauthorized | Failure::Unreachable(_))) if self.is_external() => {
                if self.reload() {
                    self.attempt(method, &params).await.map_err(failure_message)
                } else {
                    Err(failure_message(failure))
                }
            }
            Err(failure) => Err(failure_message(failure)),
        }
    }
}

fn failure_message(failure: Failure) -> String {
    match failure {
        Failure::Unauthorized => "Bitbots refused the request. Turn the Bitbots MCP on in Bitbots > Settings > Connections.".to_owned(),
        Failure::Unreachable(message) | Failure::Other(message) => message,
    }
}

fn read_endpoint(path: &std::path::Path) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let address = value["address"].as_str().filter(|text| !text.is_empty())?.to_owned();
    let token = value["token"].as_str().filter(|text| !text.is_empty())?.to_owned();
    Some((address, token))
}

/// `bitbotsd mcp-bridge`.
pub async fn run() {
    let address = std::env::var("BLOBLEX_DAEMON_ADDR").unwrap_or_default();
    let token = std::env::var("BLOBLEX_MCP_TOKEN").unwrap_or_default();
    serve(Arc::new(Backend::team_with(&address, &token)), BufReader::new(tokio::io::stdin()), tokio::io::stdout()).await;
}

/// `bitbotsd mcp-server --endpoint <file>`.
pub async fn run_external(endpoint: PathBuf) {
    serve(Arc::new(Backend::external(endpoint)), BufReader::new(tokio::io::stdin()), tokio::io::stdout()).await;
}

async fn serve<R, W>(backend: Arc<Backend>, reader: R, mut writer: W)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (sender, mut receiver) = mpsc::unbounded_channel::<Value>();
    let writing = tokio::spawn(async move {
        while let Some(response) = receiver.recv().await {
            let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
            bytes.push(b'\n');
            if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() { break; }
        }
    });
    let mut lines = reader.lines();
    let mut pending = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let (backend, sender) = (backend.clone(), sender.clone());
        pending.spawn(async move {
            if let Some(response) = handle(&backend, &message).await { let _ = sender.send(response); }
        });
    }
    // The client closed its end: let quick answers go out, never wait out a long call.
    let _ = timeout(Duration::from_secs(3), async { while pending.join_next().await.is_some() {} }).await;
    drop(sender);
    let _ = timeout(Duration::from_secs(1), writing).await;
}

async fn handle(backend: &Backend, message: &Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => {
            if backend.is_external() {
                // Tell Bitbots which client this is; a failure never blocks the handshake.
                let client = message["params"]["clientInfo"]["name"].as_str().unwrap_or("");
                let hello = backend.call("ext.hello", json!({"clientName": client}));
                let _ = timeout(HELLO_TIMEOUT, hello).await;
            }
            Ok(json!({
                "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": if backend.is_external() { "bitbots" } else { "bloblex" }, "version": env!("CARGO_PKG_VERSION")},
                "instructions": if backend.is_external() {
                    "Bitbots tools: see the owner's bots, projects and conversations, send or steer a message, wait for the reply and read turn metrics. What you may do depends on the level the owner chose in Bitbots."
                } else {
                    "Bitbots team tools: list your teammates and message them."
                }
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => backend.call(backend.list_method(), json!({})).await,
        "tools/call" => backend.call(backend.call_method(), message["params"].clone()).await
            .or_else(|error| Ok(json!({"content":[{"type":"text","text":error}],"isError":true}))),
        _ => Err(format!("Method {method} is not supported")),
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":error}}),
    })
}

async fn post(address: &str, token: &str, method: &str, params: Value, limit: Duration) -> Result<Value, Failure> {
    if address.is_empty() || token.is_empty() { return Err(Failure::Unreachable("Bitbots is not running.".into())); }
    let body = json!({"v":1,"id":"mcp","method":method,"params":params}).to_string();
    let request = format!("POST /v1/rpc HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let response = timeout(limit, async {
        let mut stream = TcpStream::connect(address).await?;
        stream.write_all(request.as_bytes()).await?;
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    }).await.map_err(|_| Failure::Other("Bitbots did not answer in time.".to_string()))?.map_err(|_| Failure::Unreachable("Bitbots is not reachable.".to_string()))?;
    let text = String::from_utf8_lossy(&response);
    let unreadable = || Failure::Other("Bitbots sent an unreadable answer.".to_string());
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(unreadable)?;
    if head.lines().next().is_some_and(|status| status.split_whitespace().nth(1) == Some("401")) { return Err(Failure::Unauthorized); }
    let value: Value = serde_json::from_str(body).map_err(|_| unreadable())?;
    if value["ok"] == true { Ok(value["result"].clone()) } else { Err(Failure::Other(value["error"]["message"].as_str().unwrap_or("Bitbots rejected the request.").to_owned())) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn initialize_and_unknown_methods_answer_without_the_daemon() {
        let backend = Backend::team_with("", "");
        let init = handle(&backend, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "bloblex");
        assert!(handle(&backend, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.is_none());
        let unknown = handle(&backend, &json!({"jsonrpc":"2.0","id":2,"method":"resources/list"})).await.unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
        let call = handle(&backend, &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_blobs"}})).await.unwrap();
        assert_eq!(call["result"]["isError"], true);
    }

    /// A stand-in for the daemon: answers 401 unless the bearer token is `current`,
    /// and records every method it was asked. One request per connection.
    async fn stub_daemon(current: Arc<StdMutex<String>>, seen: Arc<StdMutex<Vec<String>>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let (current, seen) = (current.clone(), seen.clone());
                tokio::spawn(async move {
                    let mut data = Vec::new();
                    let mut buffer = [0u8; 4096];
                    loop {
                        let Ok(count) = stream.read(&mut buffer).await else { return };
                        if count == 0 { return; }
                        data.extend_from_slice(&buffer[..count]);
                        let text = String::from_utf8_lossy(&data).to_string();
                        let Some((head, body)) = text.split_once("\r\n\r\n") else { continue };
                        let length = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|value| value.trim().parse::<usize>().ok())).unwrap_or(0);
                        if body.len() < length { continue; }
                        let bearer = head.lines().find_map(|line| line.strip_prefix("Authorization: Bearer ")).unwrap_or("").to_owned();
                        let (status, answer) = if bearer != *current.lock().unwrap() {
                            ("401 Unauthorized", json!({"ok":false,"error":{"code":"unauthorized","message":"no"}}))
                        } else {
                            let request: Value = serde_json::from_str(body).unwrap();
                            let method = request["method"].as_str().unwrap_or("").to_owned();
                            seen.lock().unwrap().push(method.clone());
                            let result = match method.as_str() {
                                "ext.tools.list" => json!({"tools":[{"name":"get_status","description":"x","inputSchema":{"type":"object"}}]}),
                                _ => json!({}),
                            };
                            ("200 OK", json!({"v":1,"id":"mcp","ok":true,"result":result}))
                        };
                        let payload = answer.to_string();
                        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
                        let _ = stream.write_all(reply.as_bytes()).await;
                        return;
                    }
                });
            }
        });
        address
    }

    #[tokio::test]
    async fn the_mcp_server_loop_answers_initialize_then_lists_tools_through_a_stub_daemon() {
        let current = Arc::new(StdMutex::new("first-token".to_owned()));
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let address = stub_daemon(current.clone(), seen.clone()).await;
        let dir = std::env::temp_dir().join(format!("bitbots-mcp-server-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let endpoint = dir.join("mcp-external.json");
        std::fs::write(&endpoint, json!({"address": address, "token": "first-token"}).to_string()).unwrap();
        let backend = Arc::new(Backend::external(endpoint.clone()));

        let (client, server) = tokio::io::duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server);
        tokio::spawn(serve(backend, BufReader::new(server_read), server_write));
        let (client_read, mut client_write) = tokio::io::split(client);
        let mut replies = BufReader::new(client_read).lines();

        let send = |value: Value| format!("{value}\n");
        client_write.write_all(send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-code"}}})).as_bytes()).await.unwrap();
        let init: Value = serde_json::from_str(&replies.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "bitbots");
        assert_eq!(seen.lock().unwrap().first().map(String::as_str), Some("ext.hello"), "the hello follows initialize");

        client_write.write_all(send(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).as_bytes()).await.unwrap();
        client_write.write_all(send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).as_bytes()).await.unwrap();
        let listed: Value = serde_json::from_str(&replies.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(listed["result"]["tools"][0]["name"], "get_status");

        // A rotated token: the daemon answers 401, the server reads the file again and succeeds.
        *current.lock().unwrap() = "second-token".to_owned();
        std::fs::write(&endpoint, json!({"address": address, "token": "second-token"}).to_string()).unwrap();
        client_write.write_all(send(json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).as_bytes()).await.unwrap();
        let again: Value = serde_json::from_str(&replies.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(again["result"]["tools"][0]["name"], "get_status", "{again}");

        // A tool call the daemon refuses comes back as a tool error, not a protocol error.
        *current.lock().unwrap() = "third-token".to_owned();
        client_write.write_all(send(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_status","arguments":{}}})).as_bytes()).await.unwrap();
        let refused: Value = serde_json::from_str(&replies.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(refused["result"]["isError"], true);
        let _ = std::fs::remove_dir_all(dir);
    }
}
