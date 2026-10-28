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

/// Where to send the event and with which bearer: `None` means stay quiet.
///
/// Inside a Bitbots session the daemon passes its address and capability in the
/// environment. `--outside <endpoint file>` is the Wave 13 path for Claude Code
/// started outside Bitbots: the file in Bitbots' data folder holds this run's
/// address and a hook-only token. A Claude Code that Bitbots started itself
/// carries `BITBOTS_MANAGED`, so the outside path ignores it.
fn target(args: &[String]) -> Option<(String, String, &'static str)> {
    if let Some(index) = args.iter().position(|arg| arg == "--outside") {
        if std::env::var_os("BITBOTS_MANAGED").is_some() {
            return None;
        }
        let file = args.get(index + 1)?;
        let text = std::fs::read_to_string(file).ok()?;
        let endpoint = serde_json::from_str::<Value>(&text).ok()?;
        let address = endpoint["address"].as_str()?.to_owned();
        let token = endpoint["token"].as_str()?.to_owned();
        // The daemon only ever listens on loopback.
        if !address.starts_with("127.0.0.1:") {
            return None;
        }
        return Some((address, token, "outside.hook"));
    }
    let address = std::env::var("BLOBLEX_DAEMON_ADDR").ok()?;
    let token = std::env::var("BLOBLEX_DAEMON_CAPABILITY").ok()?;
    Some((address, token, "hook.event"))
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
    let args = std::env::args().collect::<Vec<_>>();
    let Some((addr, token, method)) = target(&args) else {
        return Ok(());
    };
    let body =
        serde_json::json!({"v":1,"id":"hook","method":method,"params":{"event":value}})
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
