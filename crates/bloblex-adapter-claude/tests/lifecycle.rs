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
async fn fake_process_launches_bypass_flags_only_for_bypass_mode(){
    for (mode,name) in [(bloblex_agent_core::ApprovalMode::Ask,"ask"),(bloblex_agent_core::ApprovalMode::Auto,"auto"),(bloblex_agent_core::ApprovalMode::Bypass,"bypass")]{
        let(root,_,audit_path)=paths();let system=setup_test_acl(&root);let adapter=ClaudeAdapter::with_test_acl_executable(root.join("private-tmp"),system);let rt=runtime(&audit_path,&[]);let(tx,mut rx)=mpsc::channel(32);
        let handle=adapter.new_session(&rt,NewSessionRequest{session_id:name.into(),project_path:root.clone(),exec_options:ExecOptions{approval_mode:mode,..ExecOptions::default()}},tx).await.unwrap();wait_session_start(&mut rx).await;adapter.close_session(&handle).await.unwrap();
        let rows=audit(&audit_path);assert_eq!(rows.len(),1);let args=rows[0]["args"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>();
        assert!(!args.contains(&"--permission-prompt-tool"), "the host control protocol does not require an MCP permission tool");
        if mode==bloblex_agent_core::ApprovalMode::Bypass{assert!(args.windows(2).any(|w|w==["--permission-mode","bypassPermissions"]));assert!(args.contains(&"--allow-dangerously-skip-permissions"));}
        else{assert!(args.windows(2).any(|w|w==["--permission-mode","default"]));assert!(!args.contains(&"bypassPermissions"));assert!(!args.contains(&"--allow-dangerously-skip-permissions"));}
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn default_permission_uses_the_stream_json_host_control_protocol() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let adapter = ClaudeAdapter::with_test_acl_executable(private, system_root);
    let rt = runtime(&audit_path, &["--fake-permission-roundtrip"]);
    let (tx, mut rx) = mpsc::channel(16);
    let handle = adapter
        .new_session(
            &rt,
            NewSessionRequest {
                session_id: "s-permission-roundtrip".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    wait_session_start(&mut rx).await;
    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-permission-roundtrip".into(),
                text: "hello".into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();

    let permission_id = loop {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap() {
            AgentEvent::PermissionRequested { provider_request_id, .. } => break provider_request_id,
            _ => {}
        }
    };
    assert_eq!(permission_id, "s-permission-roundtrip:17");
    adapter.reply_permission(&permission_id, "allow").await.unwrap();
    let completed = events_through_turn(&mut rx).await;
    assert!(completed.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    let rows = audit(&audit_path);
    let args = rows[0]["args"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>();
    assert!(!args.contains(&"--permission-prompt-tool"));
    adapter.close_session(&handle).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn stderr_only_turn_exit_is_forwarded_as_actionable_error() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let adapter = ClaudeAdapter::with_test_acl_executable(private, system_root);
    let rt = runtime(&audit_path, &["--fake-stderr-error"]);
    let (tx, mut rx) = mpsc::channel(16);
    let handle = adapter
        .new_session(
            &rt,
            NewSessionRequest {
                session_id: "s-stderr-error".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    wait_session_start(&mut rx).await;
    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-stderr-error".into(),
                text: "hello".into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();

    let seen = events_through_turn(&mut rx).await;
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::Error { message } if message.contains("429 rate limit exceeded"))));
    assert!(!seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    let diagnostic = adapter.diagnostic("s-stderr-error").await.unwrap();
    assert!(diagnostic.process_running.is_some());
    assert!(diagnostic.stderr_tail.unwrap().contains("429 rate limit exceeded"));
    adapter.close_session(&handle).await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn system_api_retry_updates_only_safe_diagnostic_summary() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let adapter = ClaudeAdapter::with_test_acl_executable(private, system_root);
    let rt = runtime(&audit_path, &["--fake-api-retry-count=11"]);
    let (tx, mut rx) = mpsc::channel(16);
    let handle = adapter
        .new_session(
            &rt,
            NewSessionRequest {
                session_id: "s-api-retry".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    wait_session_start(&mut rx).await;
    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-api-retry".into(),
                text: "harmless test prompt".into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();
    let diagnostic = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let diagnostic = adapter.diagnostic("s-api-retry").await.unwrap();
            if diagnostic.api_retry_count == Some(11) { break diagnostic; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    assert_eq!(diagnostic.api_retry_count, Some(11));
    assert!(!diagnostic.api_retry_http_status_seen);
    assert!(diagnostic.api_retry_connection_failure);
    assert!(diagnostic.stderr_tail.is_none(), "raw retry JSON is not stored as stderr");

    adapter.close_session(&handle).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    std::fs::remove_dir_all(root).unwrap();
}

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
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-1".into(), text: "hello".into(), exec_options: requested.clone() }).await.unwrap();
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
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-2".into(), text: "again".into(), exec_options: changed.clone() }).await.unwrap();
    let _ = events_through_turn(&mut rx).await;
    adapter.set_instruction_hash_context("s-fake", Some("hash-two".into()), Some("hash-one".into())).await;
    let changed_instruction = ExecOptions { instructions: Some("PRIVATE_SENTINEL_CHANGED".into()), ..changed };
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-3".into(), text: "third".into(), exec_options: changed_instruction }).await.unwrap();
    let _ = events_through_turn(&mut rx).await;

    let rows = audit(&audit_path);
    assert_eq!(rows.len(), 4, "session launch plus each changed option set must start a provider process");
    let first_turn = rows.iter().find(|row| row["instructionExists"] == true).unwrap();
    assert_eq!(first_turn["aclRestricted"], true, "instruction file permissions must be restrictive while the provider runs");
    let args = first_turn["args"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let model_at = index(&args, "--model");
    let effort_at = index(&args, "--effort");
    let file_at = index(&args, "--append-system-prompt-file");
    let session_at = index(&args, "--session-id");
    assert!(model_at < effort_at && effort_at < file_at && file_at < session_at);
    assert!(!args.iter().any(|arg| arg == "--resume"), "option changes before the first prompt start a fresh provider session");
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
    let second_turn = rows.iter().find(|row| row["args"].as_array().unwrap().windows(2).any(|pair| pair[0] == "--model" && pair[1] == "claude-opus-test")).unwrap();
    assert!(second_turn["args"].as_array().unwrap().iter().any(|arg| arg == "--resume"), "option changes after a completed provider turn resume the saved session");
    assert_eq!(std::fs::read_to_string(&rows.last().unwrap()["instructionPath"].as_str().map(PathBuf::from).unwrap()).unwrap(), "PRIVATE_SENTINEL_CHANGED");

    let catalog: ModelCatalog = adapter.model_catalog(&rt).await.unwrap();
    assert!(!catalog.fallback);
    assert_eq!(catalog.source, "live_query");
    assert!(catalog.validated);
    assert_eq!(catalog.models[0].id, "claude-sonnet-test");
    let audit_rows = audit(&audit_path);
    let catalog_args = audit_rows.last().unwrap()["args"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>();
    assert!(!catalog_args.contains(&"--permission-prompt-tool"));
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
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-error".into(), text: "hello".into(), exec_options: options }).await.unwrap();
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
async fn failed_option_resume_reports_changed_names_and_provider_reason_without_values() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let adapter = ClaudeAdapter::with_test_acl_executable(private, system_root);
    let rt = runtime(&audit_path, &["--fake-resume-reject"]);
    let (tx, mut rx) = mpsc::channel(16);
    let handle = adapter
        .new_session(
            &rt,
            NewSessionRequest {
                session_id: "s-option-resume-reject".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    wait_session_start(&mut rx).await;

    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-before-option-change".into(),
                text: "hello".into(),
                exec_options: ExecOptions::default(),
            },
        )
        .await
        .unwrap();
    assert!(events_through_turn(&mut rx)
        .await
        .iter()
        .any(|event| matches!(event, AgentEvent::TurnCompleted)));

    let instructions = "PRIVATE_BLOB_INSTRUCTIONS_SHOULD_NOT_LEAK";
    let options = ExecOptions {
        model: Some("private-model-value".into()),
        instructions: Some(instructions.into()),
        env: std::collections::BTreeMap::from([("LANG".into(), "PRIVATE_ENV_VALUE".into())]),
        ..ExecOptions::default()
    };
    adapter
        .set_instruction_hash_context(
            "s-option-resume-reject",
            bloblex_agent_core::instruction_sha256(instructions),
            Some("prior-instruction-hash".into()),
        )
        .await;
    let error = adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-option-resume-reject".into(),
                text: "hello".into(),
                exec_options: options,
            },
        )
        .await
        .unwrap_err();

    let detail = error.to_string();
    for field in ["model", "instructions", "customEnv", "instruction hash"] {
        assert!(detail.contains(field), "missing changed field {field}: {detail}");
    }
    assert!(detail.contains("provider rejected the stored session id"), "underlying resume reason is retained: {detail}");
    for private_value in [instructions, "private-model-value", "PRIVATE_ENV_VALUE", "hello"] {
        assert!(!detail.contains(private_value), "private value leaked in resume diagnostic: {private_value}");
    }
    let rows = audit(&audit_path);
    assert_eq!(rows.len(), 2);
    assert!(rows[1]["args"].as_array().unwrap().iter().any(|arg| arg == "--resume"));
    adapter.close_session(&handle).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn model_change_before_first_prompt_starts_fresh_when_resume_is_rejected() {
    let (root, private, audit_path) = paths();
    let system_root = setup_test_acl(&root);
    let adapter = ClaudeAdapter::with_test_acl_executable(private, system_root);
    let rt = runtime(&audit_path, &["--fake-resume-reject"]);
    let (tx, mut rx) = mpsc::channel(32);
    let handle = adapter
        .new_session(
            &rt,
            NewSessionRequest {
                session_id: "s-first-model-change".into(),
                project_path: root.clone(),
                exec_options: ExecOptions::default(),
            },
            tx,
        )
        .await
        .unwrap();
    wait_session_start(&mut rx).await;
    let instructions = "fresh session instructions";
    adapter
        .set_instruction_hash_context(
            "s-first-model-change",
            bloblex_agent_core::instruction_sha256(instructions),
            Some("previous-session-instruction-hash".into()),
        )
        .await;
    let changed_options = ExecOptions {
        model: Some("claude-sonnet-test".into()),
        instructions: Some(instructions.into()),
        ..ExecOptions::default()
    };
    adapter
        .prompt(
            &handle,
            PromptRequest { attachments: Vec::new(),
                turn_id: "turn-first-model-change".into(),
                text: "hello".into(),
                exec_options: changed_options,
            },
        )
        .await
        .unwrap();

    let seen = events_through_turn(&mut rx).await;
    assert!(seen.iter().any(|event| matches!(event, AgentEvent::TurnCompleted)));
    assert!(!seen.iter().any(|event| matches!(event, AgentEvent::Error { .. })));
    let fresh_provider_id = seen.iter().find_map(|event| match event {
        AgentEvent::SessionStarted { provider_session_id } => Some(provider_session_id),
        _ => None,
    }).expect("fresh process announces its provider session ID");
    let rows = audit(&audit_path);
    assert_eq!(rows.len(), 2, "model changes before the first prompt restart once");
    let first_id = rows[0]["args"].as_array().unwrap().windows(2).find(|pair| pair[0] == "--session-id").unwrap()[1].as_str().unwrap();
    let fresh_args = rows[1]["args"].as_array().unwrap();
    let fresh_id = fresh_args.windows(2).find(|pair| pair[0] == "--session-id").unwrap()[1].as_str().unwrap();
    assert_ne!(first_id, fresh_id);
    assert_eq!(fresh_provider_id.as_str(), fresh_id);
    assert!(!fresh_args.iter().any(|arg| arg == "--resume"));
    assert!(fresh_args.windows(2).any(|pair| pair[0] == "--model" && pair[1] == "claude-sonnet-test"));
    assert!(!fresh_args.iter().any(|arg| arg == "--system-prompt-snapshot"));
    adapter.close_session(&handle).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
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
    adapter.prompt(&handle, PromptRequest { attachments: Vec::new(), turn_id: "turn-init-only".into(), text: "hello".into(), exec_options: options }).await.unwrap();
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
    assert_eq!(catalog.source, "fallback");
    assert!(!catalog.validated);
    assert_eq!(catalog.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["sonnet", "opus", "fable", "haiku"]);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn resume_rejection_requires_the_observed_zero_turn_session_error_shape() {
    for (mode, rejected) in [
        ("--fake-resume-reject", true),
        ("--fake-startup-generic-error", false),
        ("--fake-startup-phrase-error", false),
    ] {
        let (root, private, audit_path) = paths();
        let system_root = setup_test_acl(&root);
        let adapter = ClaudeAdapter::with_test_acl_executable(private, system_root);
        let rt = runtime(&audit_path, &[mode]);
        let (tx, mut rx) = mpsc::channel(16);
        let result = adapter
            .resume_session(
                &rt,
                bloblex_agent_core::ResumeSessionRequest {
                    session_id: format!("resume-{mode}"),
                    provider_session_id: "00000000-0000-4000-8000-000000000000".into(),
                    project_path: root.clone(),
                    exec_options: ExecOptions::default(),
                },
                tx,
            )
            .await;
        if rejected {
            assert!(matches!(result, Err(bloblex_agent_core::AdapterError::ResumeRejected)));
            while let Ok(event) = rx.try_recv() {
                assert!(
                    !matches!(event, AgentEvent::UsageReport { .. }),
                    "rejection zeros must not be emitted as usage"
                );
            }
        } else {
            let handle = result.expect("a generic or embedded phrase error is not resume rejection");
            adapter.close_session(&handle).await.unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
