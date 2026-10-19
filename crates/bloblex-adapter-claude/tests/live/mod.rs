//! FIX39 P11 — Claude reliability suite: gated live runs against the real
//! `claude` CLI, and offline replay of the transcripts they record.
//!
//! The live tests run only when `BITBOTS_LIVE_TESTS=1`. They point the real
//! adapter at `claude-cli-recorder`, which proxies the installed `claude` CLI
//! (normal installed sign-in, read-only) and writes a sanitised wire transcript
//! to `tests/live/fixtures/`. The offline tests replay each recorded transcript
//! through the real adapter via `fake-claude --replay`, so the gate exercises a
//! real CLI session without spending tokens.
//!
//! Bitbots' own data (the private instruction directory and the project path)
//! always lives in a fresh temporary folder; nothing here reads or writes the
//! owner's real Bitbots data, and no credentials are printed or stored.
use bloblex_adapter_claude::ClaudeAdapter;
use bloblex_agent_core::{
    AdapterError, AgentAdapter, AgentEvent, ApprovalMode, ExecOptions, NewSessionRequest,
    PromptRequest, RuntimeSpec, SteerRequest,
};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio::sync::mpsc;
use uuid::Uuid;

const PROVIDER: &str = "claude";
const CLI: &str = "claude";
/// The cheapest Claude model, fixed by `docs/history/fix-39/decisions.md` so a live run
/// never spends on the installed default.
const MODEL: &str = "claude-haiku-5-5";
const THINKING: &str = "medium";
/// Fixtures recorded by the live run and replayed offline.
const LIVE_FIXTURES: &[&str] = &["claude-two-turn.ndjson"];
const TWO_TURN_FIXTURE: &str = "claude-two-turn.ndjson";
/// A run that ends on a provider usage limit or unavailable account is kept as
/// its own transcript, so the offline gate can replay the clean reported state.
const LIMIT_FIXTURE: &str = "claude-usage-limit.ndjson";

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
    fixtures_dir().join(format!("claude-{scenario}.recording.ndjson"))
}

fn promote_recording(scenario: &str, fixture: &str) {
    let scratch = recording_path(scenario);
    assert!(scratch.exists(), "the recorder wrote {}", scratch.display());
    std::fs::rename(&scratch, fixtures_dir().join(fixture)).expect("promote the recording");
}

/// The recorder runtime. `scenario` `Some(name)` records a transcript to a
/// scratch path; `None` is a plain pass-through.
fn live_runtime_with(live: &Live, scenario: Option<&str>) -> RuntimeSpec {
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
            format!("claude-{scenario}"),
        ]);
    }
    args.push("--".into());
    RuntimeSpec {
        runtime_id: "claude-live".into(),
        provider: PROVIDER.into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_claude-cli-recorder")),
        args,
        cwd: None,
    }
}

fn replay_runtime(name: &str) -> RuntimeSpec {
    RuntimeSpec {
        runtime_id: "claude-replay".into(),
        provider: PROVIDER.into(),
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fake-claude")),
        args: vec![
            "--replay".into(),
            fixtures_dir().join(name).to_string_lossy().into_owned(),
        ],
        cwd: None,
    }
}

struct Root(PathBuf);

impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn root() -> Root {
    let path = std::env::temp_dir().join(format!("bloblex-live-claude-{}", Uuid::new_v4()));
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
    /// True when the first failure names a usage limit or an unavailable
    /// account, which the suite records as a reported skip rather than a bug.
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

/// The cheapest model at the decided effort, for every live request.
fn options() -> ExecOptions {
    ExecOptions {
        model: Some(MODEL.into()),
        thinking: Some(THINKING.into()),
        ..ExecOptions::default()
    }
}

/// Drives `start + turn 1 + turn 2` through the real adapter. This is the
/// scenario both the live recorder and the offline replay assert.
async fn two_turn(runtime: &RuntimeSpec) -> Outcome {
    let root = root();
    let adapter = ClaudeAdapter::with_private_tmp_dir(root.0.join("private"));
    let (tx, mut rx) = mpsc::channel(256);
    let mut outcome = Outcome::default();
    // Claude emits `system/init` only once a turn begins in some versions, so
    // the session is proven started by the adapter's successful `new_session`
    // and the first completed turn, not by an eager init frame.
    let handle = match adapter
        .new_session(
            runtime,
            NewSessionRequest {
                session_id: "live-two-turn".into(),
                project_path: root.0.clone(),
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
    // Let any final housekeeping frame land before the provider is torn down.
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

/// Offline: replay every recorded real-CLI transcript through the real adapter.
#[tokio::test]
async fn claude_replays_recorded_live_transcripts() {
    let mut replayed = 0;
    for name in LIVE_FIXTURES {
        if !fixtures_dir().join(name).exists() {
            eprintln!(
                "skipping {name}: not recorded yet (run the live suite with BITBOTS_LIVE_TESTS=1)"
            );
            continue;
        }
        let outcome = two_turn(&replay_runtime(name)).await;
        assert_two_turn(&outcome);
        replayed += 1;
    }
    if fixtures_dir().join(LIMIT_FIXTURE).exists() {
        let outcome = two_turn(&replay_runtime(LIMIT_FIXTURE)).await;
        let first = outcome.turns.first().expect("the limit transcript reaches a turn");
        assert!(
            first.error.is_some(),
            "a recorded limit replays as a clean, reported terminal state: {outcome:?}"
        );
        replayed += 1;
    }
    eprintln!("replayed {replayed} recorded claude transcript(s)");
}

/// Live: record the two-turn transcript from the installed CLI.
#[tokio::test]
async fn claude_live_records_a_two_turn_transcript() {
    if !live_enabled() {
        eprintln!("skipping live claude run: set BITBOTS_LIVE_TESTS=1 to run it");
        return;
    }
    let Some(live) = detect_cli() else {
        eprintln!("skipping live claude run: the claude CLI is not installed");
        return;
    };
    let outcome = two_turn(&live_runtime_with(&live, Some("two-turn"))).await;
    let scratch = recording_path("two-turn");
    if let Some(reason) = outcome.reported_skip() {
        // Keep a limited run as its own transcript and never leave a partial
        // two-turn fixture behind for the offline gate to replay.
        if scratch.exists() {
            let _ = std::fs::rename(&scratch, fixtures_dir().join(LIMIT_FIXTURE));
        }
        eprintln!("live claude reported a limit or unavailable account (skip): {reason}");
        return;
    }
    // Any other first-turn error fails here, not a quiet pass.
    assert_two_turn(&outcome);
    promote_recording("two-turn", TWO_TURN_FIXTURE);
}

/// Live: a permission-mode change between turns and a steer attempt must either
/// work or be cleanly reported, never fail the suite.
#[tokio::test]
async fn claude_live_permission_change_and_steer_are_reported() {
    if !live_enabled() {
        eprintln!("skipping live claude permission/steer run: set BITBOTS_LIVE_TESTS=1");
        return;
    }
    let Some(live) = detect_cli() else {
        eprintln!("skipping live claude permission/steer run: the claude CLI is not installed");
        return;
    };
    let root = root();
    let adapter = ClaudeAdapter::with_private_tmp_dir(root.0.join("private"));
    let runtime = live_runtime_with(&live, None);
    let (tx, mut rx) = mpsc::channel(256);
    let handle = adapter
        .new_session(
            &runtime,
            NewSessionRequest {
                session_id: "live-permission".into(),
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
                turn_id: "live-permission-1".into(),
                text: "Reply with the single word: one.".into(),
                exec_options: options(),
            },
        )
        .await
        .expect("the first prompt is admitted");
    let first = collect_turn(&mut rx).await;
    if let Some(message) = first.error.as_deref().filter(|m| is_reported_limit(m)) {
        eprintln!("live claude reported a limit or unavailable account (skip): {message}");
        let _ = adapter.close_session(&handle).await;
        return;
    }
    // The decision's first-turn rule: an error that is not a recognised limit
    // fails the live test instead of passing quietly.
    assert!(
        first.completed,
        "the first turn completed (error: {:?})",
        first.error
    );

    // Change the permission mode **between** turns and prove the next turn is
    // either completed or cleanly reported, never a protocol failure.
    let second = adapter
        .prompt(
            &handle,
            PromptRequest {
                attachments: Vec::new(),
                turn_id: "live-permission-2".into(),
                text: "Reply with the single word: two.".into(),
                exec_options: ExecOptions { approval_mode: ApprovalMode::Auto, ..options() },
            },
        )
        .await;
    // Steer while that turn is active. Claude does not support steer, so a
    // typed `Unsupported` is the clean report; a transport error is not.
    match adapter
        .steer(
            &handle,
            SteerRequest {
                turn_id: "live-permission-2".into(),
                text: "Stop; reply with the single word: two.".into(),
            },
        )
        .await
    {
        Ok(outcome) => eprintln!("claude steer outcome: {outcome:?}"),
        Err(AdapterError::Unsupported(message)) => {
            assert!(!message.trim().is_empty(), "an unsupported steer explains itself");
            eprintln!("claude steer reported as unsupported: {message}");
        }
        Err(error) => panic!("claude steer returned a transport failure: {error:?}"),
    }
    match second {
        Ok(()) => {
            let turn = collect_turn(&mut rx).await;
            if let Some(message) = turn.error.as_deref().filter(|m| is_reported_limit(m)) {
                eprintln!("live claude reported a limit or unavailable account (skip): {message}");
            } else if let Some(message) = turn.error.as_deref() {
                assert!(
                    !message.trim().is_empty(),
                    "a failed permission turn still reports a reason"
                );
                assert!(
                    !message.to_ascii_lowercase().contains("protocol"),
                    "the permission change was cleanly reported, not a protocol failure: {message}"
                );
                eprintln!("claude permission change reported: {message}");
            } else {
                assert!(turn.completed, "the turn after the permission change completed: {turn:?}");
            }
        }
        Err(AdapterError::Protocol(message)) => {
            panic!("the permission change failed at the protocol level: {message}")
        }
        Err(error) => {
            let message = error.to_string();
            assert!(!message.trim().is_empty(), "a rejected permission change explains itself");
            eprintln!("claude permission change reported: {message}");
        }
    }
    let _ = adapter.close_session(&handle).await;
}
