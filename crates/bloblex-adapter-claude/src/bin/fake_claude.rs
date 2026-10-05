use serde_json::{json, Value};
use std::{io::{self, BufRead, Write}, path::PathBuf};

fn emit(value: Value) {
    println!("{}", value);
    let _ = io::stdout().flush();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let audit = args.iter().find_map(|arg| arg.strip_prefix("--fake-audit=")).map(PathBuf::from);
    let model = args.windows(2).find(|pair| pair[0] == "--model").map(|pair| pair[1].clone());
    let instruction = args.windows(2).find(|pair| pair[0] == "--append-system-prompt-file").map(|pair| PathBuf::from(&pair[1]));
    let instruction_exists = instruction.as_ref().is_some_and(|path| path.is_file());
    let acl_restricted = instruction.as_ref().is_some_and(|path| {
        #[cfg(windows)]
        {
            let audit = args.iter().find_map(|arg| arg.strip_prefix("--fake-acl-audit=")).map(PathBuf::from);
            audit.and_then(|path| std::fs::read_to_string(path).ok()).is_some_and(|content| content.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).any(|row| {
                row["accepted"] == true && row["args"][0].as_str() == path.to_str() && row["args"][1] == "/inheritance:r" && row["args"][2] == "/grant:r" && row["args"][3].as_str().is_some_and(|grant| grant.ends_with(":F"))
            }))
        }
        #[cfg(not(windows))]
        {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path).map(|m| m.permissions().mode() & 0o077 == 0).unwrap_or(false)
        }
        #[cfg(not(any(windows, unix)))]
        { false }
        }
    });
    if let Some(path) = audit {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{}", json!({"args":args,"instructionPath":instruction,"instructionExists":instruction_exists,"aclRestricted":acl_restricted}));
            let _ = file.flush();
        }
    }
    let session_id = args.windows(2).find(|pair| pair[0] == "--session-id").map(|pair| pair[1].clone())
        .or_else(|| args.windows(2).find(|pair| pair[0] == "--resume").map(|pair| pair[1].clone())).unwrap_or_else(|| "fake-session".into());
    if args.iter().any(|arg| arg == "--fake-resume-reject")
        && args.iter().any(|arg| arg == "--resume")
    {
        emit(json!({"type":"result","subtype":"error_during_execution","duration_ms":0,"duration_api_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":session_id,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"errors":["No conversation found with session ID: 00000000-0000-4000-8000-000000000000"],"result_index":0}));
        return;
    }
    emit(json!({"type":"system","subtype":"init","session_id":session_id,"model":model.clone().unwrap_or_else(||"init-only-echo".into())}));
    if args.iter().any(|arg| arg == "--fake-startup-generic-error") {
        emit(json!({"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0},"errors":["Provider request failed"]}));
    }
    if args.iter().any(|arg| arg == "--fake-startup-phrase-error") {
        emit(json!({"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0},"errors":["prefix: No conversation found with session ID: elsewhere"]}));
    }
    let stdin = io::stdin();
    for line in stdin.lock().lines().flatten() {
        let Ok(input) = serde_json::from_str::<Value>(&line) else { continue };
        if input["type"] == "control_request" && input["request"]["subtype"] == "list_models" {
            emit(json!({"type":"control_response","response":{"subtype":"success","request_id":input["request_id"],"response":{"models":[{"value":"claude-sonnet-test","displayName":"Test Sonnet","providerId":"anthropic","supportedEffortLevels":["low","high"],"defaultEffort":"low","supportsFastMode":true}],"resolvedModel":"claude-sonnet-test"}}}));
        } else if input["type"] == "user" {
            if let Some(count) = args.iter().find_map(|arg| arg.strip_prefix("--fake-api-retry-count=")).and_then(|count| count.parse::<u32>().ok()) {
                for attempt in 1..=count {
                    emit(json!({"type":"system","subtype":"api_retry","attempt":attempt,"max_attempts":count,
                        "error":format!("API error (attempt {attempt}/{count}): undefined Connection error.")}));
                }
                continue;
            }
            if args.iter().any(|arg| arg == "--fake-permission-roundtrip") {
                emit(json!({"type":"control_request","request_id":17,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo safe"}}}));
                continue;
            }
            if args.iter().any(|arg| arg == "--fake-stderr-error") {
                eprintln!("HTTP 429 rate limit exceeded; retry after 30 seconds");
                return;
            }
            let fail = args.iter().any(|arg| arg == "--fake-error");
            let model_usage = if args.iter().any(|arg| arg == "--fake-no-model-usage") { json!({}) } else { model.as_ref().map(|model| json!({model:{"inputTokens":7}})).unwrap_or_else(|| json!({})) };
            emit(json!({"type":"result","is_error":fail,"session_id":session_id,
                "result":if fail {"fake provider error"} else {"fake response"},
                "usage":if fail {json!({"input_tokens":0,"output_tokens":0,"output_tokens_details":{"thinking_tokens":0}})} else {json!({"input_tokens":7,"output_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens_details":{"thinking_tokens":3}})},
                "modelUsage":if fail {json!({})} else {model_usage},"total_cost_usd":if fail {0.0} else {0.012}}));
        } else if input["type"] == "control_response"
            && args.iter().any(|arg| arg == "--fake-permission-roundtrip")
        {
            if input["response"]["subtype"] == "success"
                && input["response"]["request_id"] == 17
                && input["response"]["response"]["behavior"] == "allow"
            {
                emit(json!({"type":"result","is_error":false,"session_id":session_id,
                    "result":"fake response","usage":{"input_tokens":3,"output_tokens":2},
                    "modelUsage":{},"total_cost_usd":0.0}));
            }
        }
    }
}
