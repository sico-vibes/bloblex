use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{self, BufRead, Write},
};
fn main() {
    let mut iter = std::env::args().skip(1);
    let mut record = None;
    let mut pidfile = None;
    let mut wait_for = None;
    let mut mode = String::new();
    while let Some(a) = iter.next() {
        match a.as_str() {
            "--record" => record = iter.next(),
            "--pidfile" => pidfile = iter.next(),
            "--wait-for" => wait_for = iter.next(),
            "--mode" => mode = iter.next().unwrap_or_default(),
            _ => {}
        }
    }
    let crash_enabled = matches!(mode.as_str(), "crash" | "crash-reject")
        && pidfile.as_ref().is_some_and(|path| !std::path::Path::new(path).exists());
    if let Some(path) = pidfile.as_ref() {
        std::fs::write(path, std::process::id().to_string()).unwrap();
    }
    let mut log = record.map(|p| {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .unwrap()
    });
    let mut turn = 0;
    let mut thread = 0;
    let mut active_turns = HashMap::<String, String>::new();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(f) = log.as_mut() {
            let mut recorded = v.clone();
            if recorded["params"]["developerInstructions"].is_string() {
                let actual = v["params"]["developerInstructions"].as_str().unwrap();
                recorded["params"]["developerInstructionsSha256"] = json!(bloblex_agent_core::instruction_sha256(actual));
                recorded["params"]["developerInstructionsPresent"] = json!(true);
                recorded["params"]["developerInstructionsExact"] = json!(actual == "sentinel instruction");
                recorded["params"]["developerInstructions"] = json!("[redacted]");
            }
            if recorded["params"]["input"][0]["text"].is_string() {
                let actual = v["params"]["input"][0]["text"].as_str().unwrap();
                recorded["params"]["input"][0]["textSha256"] = json!(bloblex_agent_core::instruction_sha256(actual));
                recorded["params"]["input"][0]["textPresent"] = json!(true);
                recorded["params"]["input"][0]["textExact"] = json!(actual == "hello");
                recorded["params"]["input"][0]["text"] = json!("[redacted]");
            }
            writeln!(f, "{recorded}").unwrap();
            let _ = f.flush();
        }
        let method = v["method"].as_str().unwrap_or("");
        if method == "initialized" {
            continue;
        }
        let id = v["id"].clone();
        if (method == "turn/start" && mode == "reject")
            || (method == "thread/start" && mode == "reject-start")
        {
            if method == "thread/start" {
                if let Some(path) = wait_for.as_ref() {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                    while !std::path::Path::new(path).exists() && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
            }
            println!(
                "{}",
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"requested turn option rejected"}})
            );
            let _ = io::stdout().flush();
            continue;
        }
        if method == "thread/resume" && (mode.starts_with("resume-") || (mode == "crash-reject" && !crash_enabled)) {
            let message = if mode == "resume-reject" || mode == "crash-reject" {
                "thread not found"
            } else {
                "requested startup option rejected"
            };
            println!("{}", json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}}));
            let _ = io::stdout().flush();
            continue;
        }
        let params = &v["params"];
        let (result, notes) = match method {
            "initialize" => (json!({"serverInfo":{"name":"fake","version":"1"}}), vec![]),
            "thread/start" => {
                thread += 1;
                let thread_id = format!("thread-{thread}");
                let tier = match params["serviceTier"].as_str() {
                    Some("fast") => Some("priority"),
                    Some(v) => Some(v),
                    None => None,
                };
                (
                    json!({"thread":{"id":thread_id},"model":params["model"].as_str().unwrap_or("model-default"),"reasoningEffort":"low","serviceTier":tier}),
                    vec![],
                )
            }
            "thread/resume" => {
                let thread_id = params["threadId"].as_str().unwrap_or("thread-1");
                let mut notes = vec![
                    json!({"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":thread_id,"turnId":"stale-turn","tokenUsage":{"last":{"inputTokens":900,"outputTokens":99}}}}),
                ];
                if mode == "replay" {
                    notes.push(json!({"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":thread_id,"turnId":"old-turn","delta":"stale answer"}}));
                }
                (
                    json!({"thread":{"id":thread_id},"model":params["model"].as_str().unwrap_or("model-default"),"reasoningEffort":"low","serviceTier":params["serviceTier"]}),
                    notes,
                )
            }
            "turn/start" => {
                turn += 1;
                let tid = format!("turn-{turn}");
                let thread_id = params["threadId"].as_str().unwrap_or("thread-1");
                active_turns.insert(thread_id.to_owned(), tid.clone());
                let input_text = params["input"][0]["text"].as_str().unwrap_or("");
                if crash_enabled && input_text == "crash" {
                    std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_millis(100)); std::process::exit(23); });
                }
                let result = json!({"turn":{"id":tid}});
                let notes = if mode == "stall" {
                    Vec::new()
                } else if mode == "cancel-timeout" && input_text == "hold-a" {
                    vec![json!({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":thread_id,"turn":{"id":tid}}})]
                } else if mode == "replay" {
                    vec![
                        json!({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":thread_id,"turn":{"id":tid}}}),
                        json!({"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":thread_id,"turnId":tid,"delta":"new answer"}}),
                        json!({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":tid,"status":"completed"}}}),
                    ]
                } else {
                    vec![
                        json!({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":thread_id,"turn":{"id":tid}}}),
                        json!({"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":thread_id,"turnId":tid,"delta":format!("answer:{thread_id}")}}),
                        json!({"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":thread_id,"turnId":tid,"tokenUsage":{"last":{"inputTokens":10,"cachedInputTokens":2,"cacheWriteInputTokens":1,"outputTokens":4,"reasoningOutputTokens":3,"totalTokens":17}}}}),
                        json!({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":tid,"status":if mode=="fail"||mode=="context"{"failed"}else{"completed"},"error":if mode=="context"{json!({"message":"maximum context length exceeded"})}else if mode=="fail"{json!({"message":"fake failure"})}else{Value::Null}}}}),
                    ]
                };
                (result, notes)
            }
            "turn/interrupt" => {
                let thread_id = params["threadId"].as_str().unwrap_or("thread-1");
                if mode == "cancel-timeout" && thread_id == "thread-1" { continue; }
                let notes = active_turns.remove(thread_id).map(|tid| vec![
                    json!({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":tid,"status":"interrupted"}}}),
                ]).unwrap_or_default();
                (json!({}), notes)
            }
            "model/list" => {
                if mode == "stall" {
                    continue;
                }
                let page = if params["cursor"].is_null() {
                    json!({"data":[{"id":"m1","displayName":"Model One","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"defaultReasoningEffort":"low","serviceTiers":[{"id":"priority","name":"Fast"}],"defaultServiceTier":null}],"nextCursor":"page-2"})
                } else {
                    json!({"data":[{"id":"m2","displayName":"Model Two","supportedReasoningEfforts":[{"reasoningEffort":"high"}],"defaultReasoningEffort":"high","serviceTiers":[],"defaultServiceTier":null}],"nextCursor":null})
                };
                (page, vec![])
            }
            "account/rateLimits/read" => {
                if mode == "stall" { continue; }
                (json!({
                    "ordinaryUsageAllowed": true,
                    "rateLimitsByLimitId": {
                        "codex": {
                            "limitName": "Codex",
                            "primary": {"usedPercent": 42, "resetsAt": 1790000000, "windowDurationMins": 300},
                            "secondary": {"usedPercent": 12, "resetsAt": 1790300000, "windowDurationMins": 10080}
                        }
                    },
                    "rateLimits": {"primary":{"usedPercent":42},"secondary":{"usedPercent":12}}
                }), vec![])
            }
            _ => (json!({}), vec![]),
        };
        if !id.is_null() {
            println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
            let _ = io::stdout().flush();
        }
        if method == "turn/start"
            && ((mode == "interleave" && v["params"]["input"][0]["text"] == "slow")
                || (mode == "cancel-timeout" && v["params"]["input"][0]["text"] == "stream-b"))
        {
            let (immediate, delayed): (Vec<_>, Vec<_>) = notes.into_iter().partition(|note| {
                note["method"] == "turn/started"
                    || (mode == "cancel-timeout" && note["method"] == "item/agentMessage/delta")
            });
            for note in immediate { println!("{note}"); }
            let delay = if mode == "cancel-timeout" { 2500 } else { 5000 };
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                for note in delayed { println!("{note}"); }
            });
        } else if method == "turn/start" && matches!(mode.as_str(), "crash" | "crash-reject") && crash_enabled {
            for note in notes.into_iter().filter(|note| note["method"] == "turn/started") { println!("{note}"); }
        } else {
            for note in notes {
                println!("{note}");
                let _ = io::stdout().flush();
            }
        }
    }
}
