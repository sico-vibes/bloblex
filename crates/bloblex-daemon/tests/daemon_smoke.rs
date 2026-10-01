#![cfg(windows)]
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::Command,
    time::timeout,
};

async fn rpc(address: &str, token: &str, method: &str, params: Value) -> Value {
    let body = json!({"v":1,"id":"smoke-1","method":method,"params":params}).to_string();
    let mut stream = TcpStream::connect(address).await.unwrap();
    let request=format!("POST /v1/rpc HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let (_, body) = text.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}

#[tokio::test]
async fn daemon_starts_with_authenticated_loopback_rpc_and_real_discovery() {
    if std::env::var("BLOBLEX_RUN_PROVIDER_SMOKE").as_deref() != Ok("1") {
        eprintln!("skipping installed-provider smoke; set BLOBLEX_RUN_PROVIDER_SMOKE=1 to run it");
        return;
    }
    let db: PathBuf =
        std::env::temp_dir().join(format!("bloblex-daemon-smoke-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&db);
    let mut child = Command::new(env!("CARGO_BIN_EXE_bloblexd"))
        .env("BLOBLEX_DB_PATH", &db)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let line = timeout(Duration::from_secs(45), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["type"], "bloblexd.ready");
    let address = ready["address"].as_str().unwrap();
    assert!(address.starts_with("127.0.0.1:"));
    let token = ready["capability"].as_str().unwrap();
    assert_eq!(token.len(), 64);
    let snapshot = rpc(address, token, "app.snapshot", json!({})).await;
    assert_eq!(snapshot["ok"], true);
    assert_eq!(snapshot["result"]["snapshotVersion"], 1);
    let runtimes = rpc(address, token, "runtime.list", json!({})).await;
    let listed = runtimes["result"]["runtimes"].as_array().unwrap();
    let mut failures = Vec::new();
    let only = std::env::var("BLOBLEX_PROVIDER_SMOKE_ONLY").ok();
    let smoke_timeout = std::env::var("BLOBLEX_PROVIDER_SMOKE_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(120);
    for provider in ["claude", "codex", "opencode"] {
        assert!(
            listed.iter().any(|r| r["provider"] == provider),
            "{provider} was not discovered: {listed:?}"
        );
        if only.as_deref().is_some_and(|selected| selected != provider) {
            eprintln!("skipping {provider} live smoke by BLOBLEX_PROVIDER_SMOKE_ONLY selection");
            continue;
        }
        let runtime = listed.iter().find(|r| r["provider"] == provider).unwrap();
        let project = std::env::current_dir().unwrap();
        let session = rpc(
            address,
            token,
            "session.new",
            json!({"runtimeId":runtime["id"],"projectPath":project,"title":"Bloblex provider smoke"}),
        )
        .await;
        assert_eq!(
            session["ok"], true,
            "{provider} session creation failed: {session}"
        );
        let sid = session["result"]["id"].as_str().unwrap();
        let prompt = rpc(
            address,
            token,
            "session.prompt",
            json!({"sessionId":sid,"text":"Reply with exactly BLOBLEX_SMOKE_OK. Do not use tools or read or modify files."}),
        )
        .await;
        assert_eq!(
            prompt["result"]["accepted"], true,
            "{provider} prompt was not accepted: {prompt}"
        );
        let turn = prompt["result"]["turnId"].as_str().unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(smoke_timeout);
        loop {
            let events = rpc(address, token, "events.replay", json!({"afterSequence":0})).await;
            let matching = events["result"]["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["payload"]["turnId"] == turn)
                .collect::<Vec<_>>();
            if let Some(failed) = matching.iter().find(|e| e["type"] == "turn.error") {
                failures.push(format!(
                    "{provider}: {}",
                    failed["payload"]["message"]
                        .as_str()
                        .unwrap_or("provider error")
                ));
                let _ = rpc(address, token, "session.close", json!({"sessionId":sid})).await;
                break;
            }
            if matching.iter().any(|e| e["type"] == "turn.completed") {
                let detail = rpc(address, token, "session.get", json!({"sessionId":sid})).await;
                let messages = detail["result"]["messages"].as_array().unwrap();
                assert!(
                    messages.iter().any(|m| {
                        m["role"] == "assistant"
                            && m["content"].as_str().unwrap_or("").trim() == "BLOBLEX_SMOKE_OK"
                    }),
                    "{provider} did not return the exact assistant smoke sentinel: {messages:?}"
                );
                let _ = rpc(address, token, "session.close", json!({"sessionId":sid})).await;
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                failures.push(format!("{provider}: turn timed out"));
                let _ = rpc(address, token, "session.cancel", json!({"sessionId":sid})).await;
                let _ = rpc(address, token, "session.close", json!({"sessionId":sid})).await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    assert!(
        failures.is_empty(),
        "installed provider smoke failures: {failures:?}"
    );
    let health = rpc(address, token, "daemon.health", json!({})).await;
    assert_eq!(health["result"]["state"], "ready");
    let stop = rpc(address, token, "daemon.shutdown", json!({})).await;
    assert_eq!(stop["result"]["stopping"], true);
    assert!(timeout(Duration::from_secs(10), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
    drop(lines);
    let _ = std::fs::remove_file(&db);
    let _ = std::fs::remove_file(db.with_extension("db-wal"));
    let _ = std::fs::remove_file(db.with_extension("db-shm"));
}
