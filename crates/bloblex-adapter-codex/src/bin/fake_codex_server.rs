use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::{self, BufRead, Write},
};
fn main() {
    let mut iter = std::env::args().skip(1);
    let mut record = None;
    let mut pidfile = None;
    let mut mode = String::new();
    while let Some(a) = iter.next() {
        match a.as_str() {
            "--record" => record = iter.next(),
            "--pidfile" => pidfile = iter.next(),
            "--mode" => mode = iter.next().unwrap_or_default(),
            _ => {}
        }
    }
    if let Some(path) = pidfile {
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
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(f) = log.as_mut() {
            writeln!(f, "{v}").unwrap();
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
            println!(
                "{}",
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"requested turn option rejected"}})
            );
            let _ = io::stdout().flush();
            continue;
        }
        let params = &v["params"];
        let (result, notes) = match method {
            "initialize" => (json!({"serverInfo":{"name":"fake","version":"1"}}), vec![]),
            "thread/start" => {
                let tier = match params["serviceTier"].as_str() {
                    Some("fast") => Some("priority"),
                    Some(v) => Some(v),
                    None => None,
                };
                (
                    json!({"thread":{"id":"thread-1"},"model":params["model"].as_str().unwrap_or("model-default"),"reasoningEffort":"low","serviceTier":tier}),
                    vec![],
                )
            }
            "thread/resume" => {
                let notes = vec![
                    json!({"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"stale-turn","tokenUsage":{"last":{"inputTokens":900,"outputTokens":99}}}}),
                ];
                (
                    json!({"thread":{"id":"thread-1"},"model":params["model"].as_str().unwrap_or("model-default"),"reasoningEffort":"low","serviceTier":params["serviceTier"]}),
                    notes,
                )
            }
            "turn/start" => {
                turn += 1;
                let tid = format!("turn-{turn}");
                let result = json!({"turn":{"id":tid}});
                let notes = if mode == "stall" {
                    Vec::new()
                } else {
                    vec![
                        json!({"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":tid,"tokenUsage":{"last":{"inputTokens":10,"cachedInputTokens":2,"cacheWriteInputTokens":1,"outputTokens":4,"reasoningOutputTokens":3,"totalTokens":17}}}}),
                        json!({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":tid,"status":if mode=="fail"{"failed"}else{"completed"},"error":if mode=="fail"{json!({"message":"fake failure"})}else{Value::Null}}}}),
                    ]
                };
                (result, notes)
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
            _ => (json!({}), vec![]),
        };
        if !id.is_null() {
            println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
            let _ = io::stdout().flush();
        }
        for note in notes {
            println!("{note}");
            let _ = io::stdout().flush();
        }
    }
}
