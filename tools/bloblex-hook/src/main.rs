use serde_json::Value;
use std::io::Read;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{timeout, Duration},
};
#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("bloblex hook bridge unavailable: {e}");
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(64 * 1024 + 1)
        .read_to_end(&mut input)?;
    if input.len() > 64 * 1024 {
        return Ok(());
    }
    let Ok(value) = serde_json::from_slice::<Value>(&input) else {
        return Ok(());
    };
    let (Some(addr), Some(token)) = (
        std::env::var("BLOBLEX_DAEMON_ADDR").ok(),
        std::env::var("BLOBLEX_DAEMON_CAPABILITY").ok(),
    ) else {
        return Ok(());
    };
    let body =
        serde_json::json!({"v":1,"id":"hook","method":"hook.event","params":{"event":value}})
            .to_string();
    let req=format!("POST /v1/rpc HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",addr,token,body.len(),body);
    let result = timeout(Duration::from_millis(500), async {
        let mut s = TcpStream::connect(&addr).await?;
        s.write_all(req.as_bytes()).await?;
        let mut response = vec![0u8; 2048];
        let n = s.read(&mut response).await?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&response[..n]).to_string())
    })
    .await;
    let _ = result;
    Ok(())
}
