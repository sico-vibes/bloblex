use bloblex_adapter_claude::ClaudeAdapter;
use bloblex_agent_core::{AgentAdapter, AgentEvent, ExecOptions, ModelCatalog, NewSessionRequest, PromptRequest, RuntimeSpec};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tokio::sync::mpsc;
use uuid::Uuid;

fn paths() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("bloblex-claude-fake-{}", Uuid::new_v4()));
    let private = root.join("private-tmp");
    let audit = root.join("argv.jsonl");
    std::fs::create_dir_all(&root).unwrap();
    (root, private, audit)
}

fn runtime(audit: &std::path::Path, extra: &[&str]) -> RuntimeSpec {
    let mut args = vec![format!("--fake-audit={}", audit.display())];
    args.extend(extra.iter().map(|v| (*v).to_owned()));
    RuntimeSpec { runtime_id: "claude-test".into(), provider: "claude".into(), executable: PathBuf::from(env!("CARGO_BIN_EXE_fake-claude")), args, cwd: None }
}

fn setup_test_acl(root: &std::path::Path) -> PathBuf {
    let system_root = root.join("fake-system");
    let system32 = system_root.join("System32");
    std::fs::create_dir_all(&system32).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_fake-icacls"), system32.join("icacls.exe")).unwrap();
    system_root
}

async fn events_through_turn(rx: &mut mpsc::Receiver<AgentEvent>) -> Vec<AgentEvent> {
    let mut seen = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        let done = matches!(event, AgentEvent::TurnCompleted | AgentEvent::Error { .. });
        seen.push(event);
        if done { return seen; }
    }
}

async fn wait_session_start(rx: &mut mpsc::Receiver<AgentEvent>) {
    loop { if matches!(tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap(), AgentEvent::SessionStarted { .. }) { return; } }
}

fn audit(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn index(args: &[String], flag: &str) -> usize { args.iter().position(|arg| arg == flag).unwrap() }

#[tokio::test]
async fn fake_provider_proves_argv_order_hash_restart_secure_file_lifecycle_and_catalog() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let acl_audit = system_root.join("acl-audit.jsonl"); let acl_arg = format!("--fake-acl-audit={}", acl_audit.display());
    let adapter = ClaudeAdapter::with_test_acl_executable(private.clone(), system_root.clone());
    let rt = runtime(&audit_path, &[acl_arg.as_str()]);
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter.new_session(&rt, NewSessionRequest { session_id: "s-fake".into(), project_path: root.clone(), exec_options: ExecOptions::default() }, tx).await.unwrap();
    wait_session_start(&mut rx).await;
    let requested = ExecOptions { model: Some("claude-sonnet-test".into()), thinking: Some("high".into()), instructions: Some("PRIVATE_SENTINEL_NEVER_IN_ARGS".into()), ..ExecOptions::default() };
    adapter.set_instruction_hash_context("s-fake", Some("hash-one".into()), None).await;
    adapter.prompt(&handle, PromptRequest { turn_id: "turn-1".into(), text: "hello".into(), exec_options: requested.clone() }).await.unwrap();
    let first = events_through_turn(&mut rx).await;
    let applied = first.iter().find_map(|e| if let AgentEvent::ExecApplied { outcomes, .. } = e { Some(outcomes) } else { None }).unwrap();
    assert_eq!(applied["model"].applied, Some(true));
    assert_eq!(applied["model"].evidence_kind, bloblex_agent_core::EvidenceKind::ProviderEcho);
    assert_eq!(applied["thinking"].applied, Some(true));
    assert_eq!(applied["thinking"].evidence_kind, bloblex_agent_core::EvidenceKind::UsageEffect);
    assert_eq!(applied["thinking"].evidence_value, Some(serde_json::json!(3)));
    assert_eq!(applied["instructions"].evidence_value, Some(serde_json::json!("hash-one")));

    let changed = ExecOptions { model: Some("claude-opus-test".into()), ..requested.clone() };
    adapter.set_instruction_hash_context("s-fake", Some("hash-one".into()), Some("hash-one".into())).await;
    adapter.prompt(&handle, PromptRequest { turn_id: "turn-2".into(), text: "again".into(), exec_options: changed.clone() }).await.unwrap();
    let _ = events_through_turn(&mut rx).await;
    adapter.set_instruction_hash_context("s-fake", Some("hash-two".into()), Some("hash-one".into())).await;
    let changed_instruction = ExecOptions { instructions: Some("PRIVATE_SENTINEL_CHANGED".into()), ..changed };
    adapter.prompt(&handle, PromptRequest { turn_id: "turn-3".into(), text: "third".into(), exec_options: changed_instruction }).await.unwrap();
    let _ = events_through_turn(&mut rx).await;

    let rows = audit(&audit_path);
    assert_eq!(rows.len(), 4, "session launch plus each changed option set must start a provider process");
    let first_turn = rows.iter().find(|row| row["instructionExists"] == true).unwrap();
    assert_eq!(first_turn["aclRestricted"], true, "instruction file permissions must be restrictive while the provider runs");
    let args = first_turn["args"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let model_at = index(&args, "--model");
    let effort_at = index(&args, "--effort");
    let file_at = index(&args, "--append-system-prompt-file");
    let resume_at = index(&args, "--resume");
    assert!(model_at < effort_at && effort_at < file_at && file_at < resume_at);
    assert_eq!(&args[model_at..model_at + 2], &["--model", "claude-sonnet-test"]);
    assert_eq!(&args[effort_at..effort_at + 2], &["--effort", "high"]);
    assert!(!args.iter().any(|arg| arg.contains("PRIVATE_SENTINEL")));
    assert_eq!(args.iter().filter(|arg| arg.as_str() == "--system-prompt-snapshot").count(), 0, "unchanged baseline keeps the default prompt snapshot");
    let changed_hash = rows.iter().find(|row| row["args"].as_array().unwrap().iter().any(|v| v == "hash-two"));
    assert!(changed_hash.is_none(), "hashes must not be passed on argv");
    let changed_args = rows.last().unwrap()["args"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>();
    let off = changed_args.iter().position(|arg| *arg == "--system-prompt-snapshot").unwrap();
    let resume = changed_args.iter().position(|arg| *arg == "--resume").unwrap();
    assert_eq!(&changed_args[off..off + 2], &["--system-prompt-snapshot", "off"]);
    let changed_model = changed_args.iter().position(|arg| *arg == "--model").unwrap();
    let changed_effort = changed_args.iter().position(|arg| *arg == "--effort").unwrap();
    let changed_file = changed_args.iter().position(|arg| *arg == "--append-system-prompt-file").unwrap();
    assert!(changed_model < changed_effort && changed_effort < changed_file && changed_file < off && off < resume);
    assert_eq!(std::fs::read_to_string(&rows.last().unwrap()["instructionPath"].as_str().map(PathBuf::from).unwrap()).unwrap(), "PRIVATE_SENTINEL_CHANGED");

    let catalog: ModelCatalog = adapter.model_catalog(&rt).await.unwrap();
    assert!(!catalog.fallback);
    assert_eq!(catalog.source, "control_request");
    assert_eq!(catalog.models[0].id, "claude-sonnet-test");
    adapter.close_session(&handle).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(std::fs::read_dir(&private).map(|rows| rows.count()).unwrap_or(0), 0, "child shutdown removes instruction and lock files");
    assert!(audit_path.exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn fake_provider_error_keeps_usage_and_applied_outcomes_unreported() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let acl_audit = system_root.join("acl-audit.jsonl"); let acl_arg = format!("--fake-acl-audit={}", acl_audit.display());
    let adapter = ClaudeAdapter::with_test_acl_executable(private.clone(), system_root.clone());
    let rt = runtime(&audit_path, &["--fake-error", acl_arg.as_str()]);
    let (tx, mut rx) = mpsc::channel(64);
    let handle = adapter.new_session(&rt, NewSessionRequest { session_id: "s-error".into(), project_path: root.clone(), exec_options: ExecOptions::default() }, tx).await.unwrap();
    wait_session_start(&mut rx).await;
    let options = ExecOptions { model: Some("requested-model".into()), thinking: Some("high".into()), instructions: Some("never-persist-this".into()), ..ExecOptions::default() };
    adapter.set_instruction_hash_context("s-error", Some("desired-hash".into()), None).await;
    adapter.prompt(&handle, PromptRequest { turn_id: "turn-error".into(), text: "hello".into(), exec_options: options }).await.unwrap();
    let seen = events_through_turn(&mut rx).await;
    let usage = seen.iter().find_map(|e| if let AgentEvent::UsageReport { report, .. } = e { Some(report) } else { None }).unwrap();
    assert_eq!(usage.usage_status, "unreported");
    assert_eq!(usage.input_tokens, None);
    assert_eq!(usage.output_tokens, None);
    let outcomes = seen.iter().find_map(|e| if let AgentEvent::ExecApplied { outcomes, .. } = e { Some(outcomes) } else { None }).unwrap();
    assert!(outcomes.values().all(|outcome| outcome.applied.is_none()));
    assert_eq!(audit(&audit_path).iter().filter(|row| row["instructionExists"] == true).count(), 1);
    adapter.close_session(&handle).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(std::fs::read_dir(&private).map(|rows| rows.count()).unwrap_or(0), 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn init_model_echo_alone_is_not_model_application_evidence() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let acl_audit = system_root.join("acl-audit.jsonl"); let acl_arg = format!("--fake-acl-audit={}", acl_audit.display());
    let adapter = ClaudeAdapter::with_test_acl_executable(private, system_root.clone());
    let rt = runtime(&audit_path, &["--fake-no-model-usage", acl_arg.as_str()]);
    let (tx, mut rx) = mpsc::channel(32);
    let handle = adapter.new_session(&rt, NewSessionRequest { session_id: "s-init-echo".into(), project_path: root.clone(), exec_options: ExecOptions::default() }, tx).await.unwrap();
    wait_session_start(&mut rx).await;
    let options = ExecOptions { model: Some("echoed-request-model".into()), ..ExecOptions::default() };
    adapter.set_instruction_hash_context("s-init-echo", None, None).await;
    adapter.prompt(&handle, PromptRequest { turn_id: "turn-init-only".into(), text: "hello".into(), exec_options: options }).await.unwrap();
    let seen = events_through_turn(&mut rx).await;
    let outcomes = seen.iter().find_map(|event| if let AgentEvent::ExecApplied { outcomes, .. } = event { Some(outcomes) } else { None }).unwrap();
    assert_eq!(outcomes["model"].applied, Some(false));
    adapter.close_session(&handle).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn fake_provider_catalog_failure_returns_static_suggestions() {
    let (root, _private, _audit) = paths();
    let adapter = ClaudeAdapter::with_private_tmp_dir(root.join("private"));
    let missing = RuntimeSpec { runtime_id: "missing".into(), provider: "claude".into(), executable: root.join("absent.exe"), args: vec![], cwd: None };
    let catalog = adapter.model_catalog(&missing).await.unwrap();
    assert!(catalog.fallback);
    assert_eq!(catalog.source, "static");
    assert_eq!(catalog.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["sonnet", "opus", "fable", "haiku"]);
    std::fs::remove_dir_all(root).unwrap();
}
