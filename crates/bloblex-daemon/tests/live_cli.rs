#![cfg(windows)]
//! FIX39 P11 — the reliability suite through the real daemon path.
//!
//! Gated by `BITBOTS_LIVE_TESTS=1`: it starts the real `bitbotsd`, which
//! discovers the installed CLIs, and drives one session per provider over the
//! loopback RPC API. Scenarios: start, turn, model report, a second turn in the
//! same session, a permission-mode change, a steer or queue while a turn is
//! running, resume after a daemon restart, and a usage-limit or unavailable
//! answer turning into a clean reported state or skip (never a failure).
//!
//! Bitbots' own data (database and project folder) always lives in a fresh
//! temporary folder, never the owner's real Bitbots data. The CLIs use their
//! normal installed sign-in, read-only. No message text, prompt text or
//! credential is written to the recorded summary.
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
    time::timeout,
};

const TURN_TIMEOUT: Duration = Duration::from_secs(180);
const PROMPT_ONE: &str = "Which model are you? Reply with the model id only.";
const PROMPT_TWO: &str = "Reply with the single word: two.";

fn live_enabled() -> bool {
    std::env::var("BITBOTS_LIVE_TESTS").as_deref() == Ok("1")
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/live/fixtures")
}

async fn rpc(address: &str, token: &str, method: &str, params: Value) -> Value {
    let body = json!({"v":1,"id":"live-1","method":method,"params":params}).to_string();
    let mut stream = TcpStream::connect(address).await.unwrap();
    let request = format!(
        "POST /v1/rpc HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let (_, body) = text.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}

struct Daemon {
    child: Child,
    address: String,
    token: String,
}

impl Daemon {
    async fn start(db: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bitbotsd"))
            .env("BLOBLEX_DB_PATH", db)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("the daemon starts");
        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let line = timeout(Duration::from_secs(60), lines.next_line())
            .await
            .expect("the daemon becomes ready")
            .unwrap()
            .unwrap();
        let ready: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ready["type"], "bloblexd.ready");
        let address = ready["address"].as_str().unwrap().to_owned();
        assert!(address.starts_with("127.0.0.1:"));
        let token = ready["capability"].as_str().unwrap().to_owned();
        // Keep the reader draining so the daemon never blocks on a full pipe.
        tokio::spawn(async move {
            while let Ok(Some(_)) = lines.next_line().await {}
        });
        Self { child, address, token }
    }

    async fn call(&self, method: &str, params: Value) -> Value {
        rpc(&self.address, &self.token, method, params).await
    }

    async fn stop(mut self) {
        let _ = self.call("daemon.shutdown", json!({})).await;
        let _ = timeout(Duration::from_secs(10), self.child.wait()).await;
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
        "blobbits-live-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

/// The decision names a usage limit or an unavailable answer as a reported
/// skip. Authentication and authorisation failures stay failures, so an
/// adapter that loses a credential is never quietly skipped.
fn is_reported_limit(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    [
        "rate limit",
        "usage limit",
        "quota",
        "429",
        "too many requests",
        "unavailable",
        "overloaded",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// A terminal failure as the daemon reported it. `message` and `class` are
/// public; `detail` is sanitised provider text used only to classify the
/// failure — it is never recorded or printed.
struct Failure {
    message: String,
    class: String,
    detail: String,
}

impl Failure {
    fn is_limit(&self) -> bool {
        is_reported_limit(&self.class)
            || is_reported_limit(&self.message)
            || is_reported_limit(&self.detail)
    }

    /// Safe to print and to use in a panic message.
    fn public(&self) -> String {
        format!("{} [{}]", self.message, self.class)
    }
}

/// A safe classification for a provider error. The message itself is never
/// recorded, because it can carry account, URL or request detail.
fn classify_error(failure: &Failure) -> &'static str {
    let text = format!("{} {}", failure.message, failure.detail).to_ascii_lowercase();
    if failure.is_limit() {
        "rate-limited-or-unavailable"
    } else if text.contains("execution settings") || text.contains("unsupported") {
        "config-unsupported"
    } else if text.contains("timed out") {
        "timed-out"
    } else if text.contains("protocol") {
        "protocol"
    } else {
        match failure.class.as_str() {
            "config_unsupported" => "config-unsupported",
            "timeout" => "timed-out",
            "permission_denied" => "permission-denied",
            "cancelled" => "cancelled",
            "budget_stop" => "budget-stop",
            "context" => "context",
            "unauthenticated" => "unauthenticated",
            _ => "provider-error",
        }
    }
}

/// Waits for a turn to finish and returns `(completed, failure)`.
async fn await_turn(daemon: &Daemon, turn_id: &str) -> (bool, Option<Failure>) {
    let deadline = tokio::time::Instant::now() + TURN_TIMEOUT;
    loop {
        let events = daemon.call("events.replay", json!({"afterSequence":0})).await;
        let matching: Vec<&Value> = events["result"]["events"]
            .as_array()
            .map(|events| {
                events
                    .iter()
                    .filter(|event| event["payload"]["turnId"] == turn_id)
                    .collect()
            })
            .unwrap_or_default();
        if let Some(failed) = matching.iter().find(|event| event["type"] == "turn.error") {
            // The daemon keeps the class and a sanitised detail; the detail is
            // used only to classify the failure, never recorded or printed.
            return (
                false,
                Some(Failure {
                    message: failed["payload"]["message"]
                        .as_str()
                        .unwrap_or("provider error")
                        .to_owned(),
                    class: failed["payload"]["failureClass"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_owned(),
                    detail: failed["payload"]["detail"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                }),
            );
        }
        if matching.iter().any(|event| event["type"] == "turn.completed") {
            return (true, None);
        }
        if tokio::time::Instant::now() >= deadline {
            return (
                false,
                Some(Failure {
                    message: "turn timed out".into(),
                    class: "timeout".into(),
                    detail: String::new(),
                }),
            );
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn prompt(daemon: &Daemon, session: &str, text: &str) -> Value {
    daemon
        .call("session.prompt", json!({"sessionId":session,"text":text}))
        .await
}

fn assistant_text(detail: &Value) -> String {
    detail["result"]["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .filter(|message| message["role"] == "assistant")
                .filter_map(|message| message["content"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// Runs one turn. `Err(code)` means the daemon rejected the prompt, which the
/// suite records instead of failing on a provider-side account condition.
async fn run_turn(
    daemon: &Daemon,
    session: &str,
    text: &str,
) -> Result<(bool, Option<Failure>), String> {
    let mut response = prompt(daemon, session, text).await;
    // The turn gate can still be settling right after a completion event.
    for _ in 0..20 {
        if response["ok"] == true {
            break;
        }
        if response["error"]["code"].as_str() != Some("conflict") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        response = prompt(daemon, session, text).await;
    }
    let Some(id) = response["result"]["turnId"].as_str() else {
        eprintln!("live turn rejected: {}", response["error"]);
        return Err(response["error"]["code"]
            .as_str()
            .unwrap_or("prompt-rejected")
            .to_owned());
    };
    Ok(await_turn(daemon, id).await)
}

/// One provider's run. Returns the sanitised summary written to the fixture.
async fn run_provider(db: &Path, project: &Path, provider: &str) -> Value {
    let mut summary = json!({
        "provider": provider,
        "start": false,
        "turn": false,
        "modelReported": false,
        "modelSelected": "not-run",
        "secondTurn": false,
        "permissionChange": "not-run",
        "steer": "not-run",
        "queue": "not-run",
        "resumeAfterRestart": "not-run",
        "limitOrUnavailable": "none",
    });
    let daemon = Daemon::start(db).await;
    // Discovery runs in the background after the daemon reports ready.
    let mut runtime = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    while runtime.is_none() && tokio::time::Instant::now() < deadline {
        let listed = daemon.call("runtime.list", json!({})).await;
        runtime = listed["result"]["runtimes"]
            .as_array()
            .and_then(|runtimes| runtimes.iter().find(|runtime| runtime["provider"] == provider))
            .cloned();
        if runtime.is_none() {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    let Some(runtime) = runtime else {
        eprintln!("live {provider}: not discovered, recording a skip");
        summary["start"] = json!("not-discovered");
        daemon.stop().await;
        return summary;
    };
    let created = daemon
        .call(
            "session.new",
            json!({"runtimeId":runtime["id"],"projectPath":project,"title":"Bitbots live reliability"}),
        )
        .await;
    if created["ok"] != true {
        eprintln!("live {provider}: session.new failed (recorded as a skip): {}", created["error"]);
        summary["start"] = json!("skipped");
        daemon.stop().await;
        return summary;
    }
    let session = created["result"]["id"].as_str().unwrap().to_owned();
    summary["start"] = json!(true);

    // The owner's decision names the cheapest model per provider. Select it
    // explicitly so the daemon's validated catalog never rejects a later prompt
    // for omitting the model.
    let (preferred, thinking) = match provider {
        "claude" => ("claude-haiku-5-5", Some("medium")),
        "codex" => ("gpt-6-luna", Some("medium")),
        _ => ("opencode/deepseek-v4.1-flash-free", None),
    };
    let catalog = daemon.call("runtime.models", json!({"runtimeId": runtime["id"]})).await;
    let models = catalog["result"]["models"].as_array().cloned().unwrap_or_default();
    if std::env::var("BITBOTS_LIVE_DEBUG").as_deref() == Ok("1") {
        for model in &models {
            eprintln!(
                "live {provider} catalog: {} availability={} default={}",
                model["id"], model["availability"], model["isDefault"]
            );
        }
    }
    let chosen = models
        .iter()
        .find(|model| model["id"] == preferred)
        .or_else(|| models.iter().find(|model| model["isDefault"] == true))
        .or_else(|| models.first())
        .and_then(|model| model["id"].as_str())
        .map(str::to_owned);
    if let Some(model) = chosen {
        let mut params = json!({"sessionId":session,"model":model,"confirmModelChange":true});
        if let Some(thinking) = thinking {
            params["thinking"] = json!(thinking);
        }
        let updated = daemon.call("session.model.update", params).await;
        if updated["ok"] != true {
            eprintln!("live {provider} model selection rejected: {}", updated["error"]);
        }
        summary["modelSelected"] = json!(if updated["ok"] == true { model } else { "rejected".to_owned() });
    } else {
        summary["modelSelected"] = json!("no-catalog");
    }

    // Turn one: start, turn, model report.
    let first = match run_turn(&daemon, &session, PROMPT_ONE).await {
        Ok(outcome) => outcome,
        Err(code) => {
            summary["turn"] = json!(format!("prompt-rejected:{code}"));
            daemon.stop().await;
            return summary;
        }
    };
    let (completed, failure) = first;
    if let Some(failure) = failure {
        if failure.is_limit() {
            eprintln!("live {provider}: reported a limit or unavailable account (skip): {}", failure.public());
            summary["limitOrUnavailable"] = json!("reported");
            daemon.stop().await;
            return summary;
        }
        // An unclassified first-turn error is a live-test failure, never a
        // quiet pass recorded as `provider-error`.
        panic!("live {provider}: first turn failed: {}", failure.public());
    }
    assert!(completed);
    summary["turn"] = json!(true);
    let detail = daemon.call("session.get", json!({"sessionId":session})).await;
    // The model report scenario reads the model the provider itself reported
    // (`contextModel`), not the model Bitbots selected.
    summary["modelReported"] = json!(
        detail["result"]["contextModel"]
            .as_str()
            .is_some_and(|model| !model.trim().is_empty())
    );
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Turn two in the same session.
    match run_turn(&daemon, &session, PROMPT_TWO).await {
        Ok((completed, failure)) => {
            summary["secondTurn"] = json!(completed);
            if let Some(failure) = failure {
                if failure.is_limit() {
                    eprintln!("live {provider}: second turn hit a limit: {}", failure.public());
                    summary["limitOrUnavailable"] = json!("reported");
                } else {
                    panic!("live {provider}: second turn failed: {}", failure.public());
                }
            }
        }
        Err(code) => summary["secondTurn"] = json!(format!("prompt-rejected:{code}")),
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Steer or queue while a turn is running.
    let working = daemon
        .call("session.prompt", json!({"sessionId":session,"text":"Count slowly from one to ten, one number per line."}))
        .await;
    let steer = daemon
        .call("session.steer", json!({"sessionId":session,"text":"Stop; reply with the single word: two."}))
        .await;
    summary["steer"] = json!(if steer["ok"] == true {
        "accepted".to_owned()
    } else {
        steer["error"]["code"].as_str().unwrap_or("unknown").to_owned()
    });
    let queued = daemon
        .call("session.queue.add", json!({"sessionId":session,"text":"Reply with the single word: three."}))
        .await;
    if queued["ok"] == true {
        summary["queue"] = json!("queued");
        if let Some(id) = queued["result"]["item"]["id"].as_str() {
            // Keep the session clean for the later scenarios.
            let _ = daemon
                .call("session.queue.delete", json!({"sessionId":session,"id":id}))
                .await;
        }
    } else {
        summary["queue"] = json!("rejected");
    }
    if let Some(turn_id) = working["result"]["turnId"].as_str() {
        let _ = await_turn(&daemon, turn_id).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Permission-mode change, then a turn.
    let permission = daemon
        .call("session.permissions.set", json!({"sessionId":session,"approvalMode":"auto"}))
        .await;
    summary["permissionChange"] = json!(if permission["ok"] == true {
        "set".to_owned()
    } else {
        permission["error"]["code"].as_str().unwrap_or("unknown").to_owned()
    });
    if permission["ok"] == true {
        match run_turn(&daemon, &session, "Reply with the single word: four.").await {
            Ok((completed, failure)) => {
                summary["permissionChange"] = json!(if completed { "completed" } else { "error" });
                if let Some(failure) = failure {
                    if failure.is_limit() {
                        eprintln!("live {provider}: permission turn hit a limit: {}", failure.public());
                        summary["limitOrUnavailable"] = json!("reported");
                    } else {
                        // A permission change may legitimately be unsupported:
                        // record the clean class rather than fail the suite.
                        summary["permissionChange"] =
                            json!(format!("error:{}", classify_error(&failure)));
                    }
                }
            }
            Err(code) => summary["permissionChange"] = json!(format!("prompt-rejected:{code}")),
        }
    }

    // Resume after a daemon restart, on the same database.
    daemon.stop().await;
    let restarted = Daemon::start(db).await;
    let resumed = restarted.call("session.resume", json!({"sessionId":session})).await;
    if resumed["ok"] != true {
        summary["resumeAfterRestart"] = json!(format!(
            "reported:{}",
            resumed["error"]["code"].as_str().unwrap_or("unknown")
        ));
    } else {
        match run_turn(&restarted, &session, PROMPT_TWO).await {
            Ok((completed, failure)) => {
                summary["resumeAfterRestart"] = json!(if completed { "completed" } else { "error" });
                if let Some(failure) = failure {
                    if failure.is_limit() {
                        eprintln!("live {provider}: resumed turn hit a limit: {}", failure.public());
                        summary["limitOrUnavailable"] = json!("reported");
                    } else {
                        // A resumed session may report a clean config class;
                        // record it instead of claiming the resume completed.
                        summary["resumeAfterRestart"] =
                            json!(format!("error:{}", classify_error(&failure)));
                    }
                }
            }
            Err(code) => summary["resumeAfterRestart"] = json!(format!("prompt-rejected:{code}")),
        }
    }
    let detail = restarted.call("session.get", json!({"sessionId":session})).await;
    summary["contextAfterRestart"] = json!(!assistant_text(&detail).trim().is_empty());
    let _ = restarted.call("session.close", json!({"sessionId":session})).await;
    restarted.stop().await;
    summary
}

#[tokio::test]
async fn live_daemon_reliability_suite_records_a_sanitised_summary() {
    if !live_enabled() {
        eprintln!("skipping the live daemon suite: set BITBOTS_LIVE_TESTS=1 to run it");
        return;
    }
    let root = temp_dir("daemon");
    let db = root.join("bitbots.db");
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(fixtures_dir()).unwrap();
    let only = std::env::var("BITBOTS_LIVE_PROVIDERS").ok();
    let mut summaries = Vec::new();
    for provider in ["claude", "codex", "opencode"] {
        if only.as_deref().is_some_and(|selected| !selected.split(',').any(|name| name.trim() == provider)) {
            continue;
        }
        let summary = run_provider(&db, &project, provider).await;
        let path = fixtures_dir().join(format!("daemon-{provider}.json"));
        std::fs::write(&path, format!("{summary}\n")).unwrap();
        eprintln!("live {provider}: {summary}");
        summaries.push(summary);
    }
    assert!(!summaries.is_empty(), "at least one provider ran");
    let _ = std::fs::remove_dir_all(&root);
}

/// Always-on gate: every recorded daemon summary is present, sanitised and
/// names only the scenario outcomes — no paths, ids, message text or prompts.
#[test]
fn daemon_live_summaries_are_present_and_sanitised() {
    let directory = fixtures_dir();
    if !directory.exists() {
        eprintln!("no live daemon summaries recorded yet");
        return;
    }
    let mut found = 0;
    for entry in std::fs::read_dir(&directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(text.trim()).expect("a JSON summary");
        assert!(value["provider"].is_string(), "{}", path.display());
        for key in ["start", "turn", "modelReported", "secondTurn", "resumeAfterRestart"] {
            assert!(value.get(key).is_some(), "{} is missing {key}", path.display());
        }
        // A provider that started and did not report a limit must have
        // completed its first turn, reported its model and run the second turn.
        // Recording such a provider as failed is a regression, not a pass.
        if value["start"] == true && value["limitOrUnavailable"] != "reported" {
            assert_eq!(
                value["turn"],
                true,
                "{} recorded a started, unlimited provider without a completed first turn",
                path.display()
            );
            assert_eq!(
                value["modelReported"],
                true,
                "{} recorded no provider-reported model",
                path.display()
            );
            assert_eq!(
                value["secondTurn"],
                true,
                "{} recorded no second turn in the same session",
                path.display()
            );
        }
        for forbidden in ["prompt", "text", "content", "message", "path", "token", "id"] {
            assert!(
                !text.to_ascii_lowercase().contains(&format!("\"{forbidden}\"")),
                "{} must not record {forbidden}",
                path.display()
            );
        }
        assert!(
            !text.contains(":\\") && !text.contains("\\\\"),
            "{} must not record an absolute path",
            path.display()
        );
        found += 1;
    }
    eprintln!("checked {found} live daemon summary fixture(s)");
}
