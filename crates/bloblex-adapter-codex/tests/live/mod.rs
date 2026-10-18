//! FIX39 P11 — Codex reliability suite: gated live runs against the real
//! `codex` CLI, and offline replay of the transcripts they record.
//!
//! The live tests run only when `BITBOTS_LIVE_TESTS=1`. They point the real
//! adapter at `codex-cli-recorder`, which proxies the installed `codex` CLI
//! (normal installed sign-in, read-only) and writes a sanitised wire transcript
//! to `tests/live/fixtures/`. The offline tests replay each recorded transcript
//! through the real adapter via `fake_codex_server --replay`.
//!
//! Bitbots' own data (the project path and the temporary database) always lives
//! in a fresh temporary folder; no credentials are printed or stored.
use bloblex_adapter_codex::CodexAdapter;
use bloblex_agent_core::{
    AdapterError, AgentAdapter, AgentEvent, ExecOptions, NewSessionRequest, PromptRequest,
    RuntimeSpec, SteerRequest,
};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio::sync::mpsc;

const PROVIDER: &str = "codex";
const CLI: &str = "codex";
/// The cheapest Codex model, fixed by `docs/FIX39_DECISIONS.md` so a live run
/// never spends on the installed default.
const MODEL: &str = "gpt-6-luna";
const THINKING: &str = "medium";
const LIVE_FIXTURES: &[&str] = &["codex-two-turn.ndjson"];
const TWO_TURN_FIXTURE: &str = "codex-two-turn.ndjson";
/// A run that ends on a provider usage limit or unavailable account is kept as
/// its own transcript, so the offline gate can replay the clean reported state.
const LIMIT_FIXTURE: &str = "codex-usage-limit.ndjson";

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/live/fixtures")
}

fn live_enabled() -> bool {
    std::env::var("BITBOTS_LIVE_TESTS").as_deref() == Ok("1")
}

/// The installed CLI: its resolved path (npm installs a `.cmd` shim on Windows,
/// which a bare name does not reach) and its version line.
struct Live {
    cli: PathBuf,
    version: String,
}

fn resolve_cli(name: &str) -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from(name)];
    #[cfg(windows)]
    if let Ok(output) = Command::new("where.exe").arg(name).output() {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let line = line.trim();
                if !line.is_empty() {
                    candidates.push(PathBuf::from(line));
                }
            }
        }
    }
    candidates.into_iter().find(|candidate| {
        Command::new(candidate)
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    })
}

fn detect_cli() -> Option<Live> {
    let cli = resolve_cli(CLI)?;
    let output = Command::new(&cli).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim().to_owned();
    (!line.is_empty()).then(|| Live { cli, version: version_number(&line) })
}

fn version_number(line: &str) -> String {
    line.split_whitespace()
        .map(|part| part.strip_prefix('v').unwrap_or(part))
        .find(|part| {
            part.chars().next().is_some_and(|c| c.is_ascii_digit()) && part.contains('.')
        })
        .unwrap_or(line)
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect()
}

/// A live recording is written here first. It is promoted to its real fixture
/// name only after `assert_two_turn` passes, so a failed run never replaces a
/// good fixture.
fn recording_path(scenario: &str) -> PathBuf {
    fixtures_dir().join(format!("codex-{scenario}.recording.ndjson"))
}

fn promote_recording(scenario: &str, fixture: &str) {
    let scratch = recording_path(scenario);
    assert!(scratch.exists(), "the recorder wrote {}", scratch.display());
    std::fs::rename(&scratch, fixtures_dir().join(fixture)).expect("promote the recording");
}

/// The cheapest model at the decided effort, for every live request.
fn options() -> ExecOptions {
    ExecOptions {
        model: Some(MODEL.into()),
        thinking: Some(THINKING.into()),
        ..ExecOptions::default()
    }
}

fn live_runtime_with(live: &Live, root: &Path, scenario: Option<&str>) -> RuntimeSpec {
    let mut args: Vec<String> = vec![
        "--provider".into(),
        PROVIDER.into(),
        "--version".into(),
        live.version.clone(),
        "--real".into(),
        live.cli.to_string_lossy().into_owned(),
    ];
    if let Some(scenario) = scenario {
        std::fs::create_dir_all(fixtures_dir()).unwrap();
        let record = recording_path(scenario);
        args.extend([
            "--record".into(),
            record.to_string_lossy().into_owned(),
            "--scenario".into(),
            format!("codex-{scenario}"),
        ]);
    }
    args.push("--".into());
    RuntimeSpec {
        runtime_id: "codex-live".into(),
        provider: PROVIDER.into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_codex-cli-recorder")),
        args,
        cwd: Some(root.to_path_buf()),
    }
}

fn replay_runtime(root: &Path, name: &str) -> RuntimeSpec {
    RuntimeSpec {
        runtime_id: "codex-replay".into(),
        provider: PROVIDER.into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fake_codex_server")),
        args: vec![
            "--replay".into(),
            fixtures_dir().join(name).to_string_lossy().into_owned(),
        ],
        cwd: Some(root.to_path_buf()),
    }
}

struct Root(PathBuf);

impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn root() -> Root {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
        "bloblex-live-codex-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).unwrap();
    Root(path)
}

#[derive(Debug, Default)]
struct Turn {
    completed: bool,
    text: String,
    model: Option<String>,
    error: Option<String>,
    hints: Vec<String>,
}

#[derive(Debug, Default)]
struct Outcome {
    started: bool,
    turns: Vec<Turn>,
}

impl Outcome {
    fn reported_skip(&self) -> Option<&str> {
        self.turns
            .iter()
            .find_map(|turn| turn.error.as_deref())
            .filter(|message| is_reported_limit(message))
    }
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

async fn next_event(rx: &mut mpsc::Receiver<AgentEvent>) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(120), rx.recv())
        .await
        .expect("an adapter event arrives within two minutes")
        .expect("the adapter event channel stays open")
}

async fn two_turn(runtime: &RuntimeSpec, project: &Path) -> Outcome {
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = mpsc::channel(256);
    let mut outcome = Outcome::default();
    // The session is proven started by the adapter's successful `new_session`
    // and the first completed turn; an eager start event is not required.
    let handle = match adapter
        .new_session(
            runtime,
            NewSessionRequest {
                session_id: "live-two-turn".into(),
                project_path: project.to_path_buf(),
                exec_options: options(),
            },
            tx,
        )
        .await
    {
        Ok(handle) => handle,
        Err(error) => {
            outcome.turns.push(Turn { error: Some(error.to_string()), ..Turn::default() });
            return outcome;
        }
    };
    outcome.started = true;
    for (index, text) in [
        "Which model are you? Reply with the model id only.",
        "Reply with the single word: two.",
    ]
    .iter()
    .enumerate()
    {
        let admitted = adapter
            .prompt(
                &handle,
                PromptRequest {
                    attachments: Vec::new(),
                    turn_id: format!("live-turn-{}", index + 1),
                    text: (*text).into(),
                    exec_options: options(),
                },
            )
            .await;
        if let Err(error) = admitted {
            outcome.turns.push(Turn { error: Some(error.to_string()), ..Turn::default() });
            break;
        }
        outcome.turns.push(collect_turn(&mut rx).await);
        if outcome.turns[index].error.is_some() {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = adapter.close_session(&handle).await;
    outcome
}

async fn collect_turn(rx: &mut mpsc::Receiver<AgentEvent>) -> Turn {
    let mut turn = Turn::default();
    loop {
        let event = next_event(rx).await;
        match event {
            AgentEvent::AssistantDelta { text } => turn.text.push_str(&text),
            AgentEvent::AssistantMessage { text } => turn.text = text,
            AgentEvent::UsageReport { report, .. } => {
                if report.model.is_some() {
                    turn.model = report.model.clone();
                }
            }
            AgentEvent::ContextUpdated { model, .. } => {
                if turn.model.is_none() {
                    turn.model = model;
                }
            }
            AgentEvent::RecoveryHint { kind, .. } => turn.hints.push(format!("{kind:?}")),
            AgentEvent::Error { message, .. } => {
                turn.error = Some(message);
                return turn;
            }
            AgentEvent::TurnCompleted => {
                turn.completed = true;
                return turn;
            }
            _ => {}
        }
    }
}

fn assert_two_turn(outcome: &Outcome) {
    assert!(outcome.started, "the session reported a start: {outcome:?}");
    assert_eq!(outcome.turns.len(), 2, "two turns ran: {outcome:?}");
    // The decision's "model report" scenario: the provider must tell Bitbots
    // which model answered. A provider that reports nothing on the wire would
    // need its own explicit assertion here, never a silent skip.
    let model = outcome.turns[0].model.as_deref().unwrap_or_default();
    assert!(
        !model.trim().is_empty(),
        "the first turn reported the model on the wire: {outcome:?}"
    );
    for (index, turn) in outcome.turns.iter().enumerate() {
        assert!(
            turn.completed,
            "turn {} completed (error: {:?}, hints: {:?})",
            index + 1,
            turn.error,
            turn.hints
        );
        assert!(
            !turn.text.trim().is_empty(),
            "turn {} returned assistant text",
            index + 1
        );
    }
}

#[tokio::test]
async fn codex_replays_recorded_live_transcripts() {
    let root = root();
    let mut replayed = 0;
    for name in LIVE_FIXTURES {
        if !fixtures_dir().join(name).exists() {
            eprintln!(
                "skipping {name}: not recorded yet (run the live suite with BITBOTS_LIVE_TESTS=1)"
            );
            continue;
        }
        let outcome = two_turn(&replay_runtime(&root.0, name), &root.0).await;
        assert_two_turn(&outcome);
        replayed += 1;
    }
    if fixtures_dir().join(LIMIT_FIXTURE).exists() {
        let outcome = two_turn(&replay_runtime(&root.0, LIMIT_FIXTURE), &root.0).await;
        let first = outcome.turns.first().expect("the limit transcript reaches a turn");
        assert!(
            first.error.is_some(),
            "a recorded limit replays as a clean, reported terminal state: {outcome:?}"
        );
        replayed += 1;
    }
    eprintln!("replayed {replayed} recorded codex transcript(s)");
}

#[tokio::test]
async fn codex_live_records_a_two_turn_transcript() {
    if !live_enabled() {
        eprintln!("skipping live codex run: set BITBOTS_LIVE_TESTS=1 to run it");
        return;
    }
    let Some(live) = detect_cli() else {
        eprintln!("skipping live codex run: the codex CLI is not installed");
        return;
    };
    let root = root();
    let outcome = two_turn(&live_runtime_with(&live, &root.0, Some("two-turn")), &root.0).await;
    let scratch = recording_path("two-turn");
    if let Some(reason) = outcome.reported_skip() {
        // Keep a limited run as its own transcript and never leave a partial
        // two-turn fixture behind for the offline gate to replay.
        if scratch.exists() {
            let _ = std::fs::rename(&scratch, fixtures_dir().join(LIMIT_FIXTURE));
        }
        eprintln!("live codex reported a limit or unavailable account (skip): {reason}");
        return;
    }
    // Any other first-turn error fails here, not a quiet pass.
    assert_two_turn(&outcome);
    promote_recording("two-turn", TWO_TURN_FIXTURE);
}

#[tokio::test]
async fn codex_live_steer_is_accepted_or_cleanly_reported() {
    if !live_enabled() {
        eprintln!("skipping live codex steer run: set BITBOTS_LIVE_TESTS=1");
        return;
    }
    let Some(live) = detect_cli() else {
        eprintln!("skipping live codex steer run: the codex CLI is not installed");
        return;
    };
    let root = root();
    let adapter = CodexAdapter::default();
    let (tx, mut rx) = mpsc::channel(256);
    let handle = adapter
        .new_session(
            &live_runtime_with(&live, &root.0, None),
            NewSessionRequest {
                session_id: "live-steer".into(),
                project_path: root.0.clone(),
                exec_options: options(),
            },
            tx,
        )
        .await
        .expect("the session starts");
    adapter
        .prompt(
            &handle,
            PromptRequest {
                attachments: Vec::new(),
                turn_id: "live-steer-1".into(),
                text: "Count slowly from one to twenty, one word per line.".into(),
                exec_options: options(),
            },
        )
        .await
        .expect("the prompt is admitted");
    // A steer must return a typed result: `Accepted`, `Stale` or a clean
    // `Unsupported`. Anything else is a transport failure and fails the test.
    match adapter
        .steer(
            &handle,
            SteerRequest {
                turn_id: "live-steer-1".into(),
                text: "Stop; reply with the single word: two.".into(),
            },
        )
        .await
    {
        Ok(outcome) => eprintln!("codex steer outcome: {outcome:?}"),
        Err(AdapterError::Unsupported(message)) => {
            assert!(!message.trim().is_empty(), "an unsupported steer explains itself");
            eprintln!("codex steer reported as unsupported: {message}");
        }
        Err(error) => panic!("codex steer returned a transport failure: {error:?}"),
    }
    let turn = collect_turn(&mut rx).await;
    if let Some(message) = turn.error.as_deref().filter(|m| is_reported_limit(m)) {
        eprintln!("live codex reported a limit or unavailable account (skip): {message}");
    } else if let Some(message) = turn.error.as_deref() {
        panic!("the steered turn failed for a non-limit reason: {message}");
    } else {
        assert!(turn.completed, "the steered turn completed: {turn:?}");
        assert!(!turn.text.trim().is_empty(), "the steered turn returned assistant text");
    }
    let _ = adapter.close_session(&handle).await;
}
