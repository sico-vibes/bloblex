//! `bloblexd mcp-bridge`: a stdio MCP server launched by a provider CLI. It
//! forwards tool listing and calls to the running daemon, authorized by the
//! per-session token in `BLOBLEX_MCP_TOKEN`. Messages are newline-delimited
//! JSON-RPC; nothing but protocol output is written to stdout.

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    time::{timeout, Duration},
};

const PROTOCOL_VERSION: &str = "2025-06-18";

pub async fn run() {
    let address = std::env::var("BLOBLEX_DAEMON_ADDR").unwrap_or_default();
    let token = std::env::var("BLOBLEX_MCP_TOKEN").unwrap_or_default();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(response) = handle(&address, &token, &message).await else { continue };
        let mut bytes = serde_json::to_vec(&response).unwrap_or_default();
        bytes.push(b'\n');
        if stdout.write_all(&bytes).await.is_err() || stdout.flush().await.is_err() { break; }
    }
}

async fn handle(address: &str, token: &str, message: &Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "bloblex", "version": env!("CARGO_PKG_VERSION")},
            "instructions": "Bloblex team tools: list your teammates and message them."
        })),
        "ping" => Ok(json!({})),
        "tools/list" => daemon(address, token, "mcp.tools.list", json!({})).await,
        "tools/call" => daemon(address, token, "mcp.tools.call", message["params"].clone()).await
            .or_else(|error| Ok(json!({"content":[{"type":"text","text":error}],"isError":true}))),
        _ => Err(format!("Method {method} is not supported")),
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":error}}),
    })
}

async fn daemon(address: &str, token: &str, method: &str, params: Value) -> Result<Value, String> {
    if address.is_empty() || token.is_empty() { return Err("Bloblex is not running.".into()); }
    let body = json!({"v":1,"id":"mcp","method":method,"params":params}).to_string();
    let request = format!("POST /v1/rpc HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let response = timeout(Duration::from_secs(60), async {
        let mut stream = TcpStream::connect(address).await?;
        stream.write_all(request.as_bytes()).await?;
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    }).await.map_err(|_| "Bloblex did not answer in time.".to_string())?.map_err(|_| "Bloblex is not reachable.".to_string())?;
    let text = String::from_utf8_lossy(&response);
    let (_, body) = text.split_once("\r\n\r\n").ok_or("Bloblex sent an unreadable answer.")?;
    let value: Value = serde_json::from_str(body).map_err(|_| "Bloblex sent an unreadable answer.".to_string())?;
    if value["ok"] == true { Ok(value["result"].clone()) } else { Err(value["error"]["message"].as_str().unwrap_or("Bloblex rejected the request.").to_owned()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initialize_and_unknown_methods_answer_without_the_daemon() {
        let init = handle("", "", &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).await.unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "bloblex");
        assert!(handle("", "", &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.is_none());
        let unknown = handle("", "", &json!({"jsonrpc":"2.0","id":2,"method":"resources/list"})).await.unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
        let call = handle("", "", &json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_blobs"}})).await.unwrap();
        assert_eq!(call["result"]["isError"], true);
    }
}
