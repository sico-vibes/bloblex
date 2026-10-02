//! Test-only ACP peer and `models --verbose` stub. Not a production entrypoint.
use bloblex_adapter_acp::sha256_hex;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    env, fs,
    io::{BufRead, Write},
    path::PathBuf,
    thread,
    time::Duration,
};

const FIXTURE: &str = include_str!("../../tests/fixtures/models-verbose.txt");
const ISOLATION_MARKER: &str = "bloblex-oc-catalog";

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let flags = Flags::parse(&args);
    if args.iter().any(|arg| arg == "models") {
        catalog_main(&flags);
        return;
    }
    acp_main(&args, &flags);
}

struct Flags {
    record: Option<PathBuf>,
    models: Vec<String>,
    variant_models: BTreeSet<String>,
    efforts: Vec<String>,
    usage: String,
}

impl Flags {
    fn parse(args: &[String]) -> Self {
        let mut record = None;
        let mut models = "opencode/big-pickle,opencode-go/deepseek-v4.1-flash".to_owned();
        let mut variant_models = "opencode-go/deepseek-v4.1-flash".to_owned();
        let mut efforts = "low,high,max,default".to_owned();
        let mut usage = "sequence".to_owned();
        let mut index = 0;
        while index < args.len() {
            let arg = &args[index];
            let next = args.get(index + 1).map(String::as_str);
            match arg.as_str() {
                "--record" => record = next.map(PathBuf::from),
                "--models" => models = next.unwrap_or("").to_owned(),
                "--variant-models" => variant_models = next.unwrap_or("").to_owned(),
                "--efforts" => efforts = next.unwrap_or("").to_owned(),
                "--usage" => usage = next.unwrap_or("sequence").to_owned(),
                _ => {}
            }
            index += if matches!(arg.as_str(), "--record" | "--models" | "--variant-models" | "--efforts" | "--usage") {
                2
            } else {
                1
            };
        }
        Self {
            record,
            models: csv(&models),
            variant_models: csv(&variant_models).into_iter().collect(),
            efforts: csv(&efforts),
            usage,
        }
    }
}

fn csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

fn catalog_main(flags: &Flags) {
    write_record(flags, &[], None);
    if env::args().any(|arg| arg == "--hang") {
        thread::sleep(Duration::from_secs(30));
        return;
    }
    if env::args().any(|arg| arg == "--fail") {
        std::process::exit(2);
    }
    println!("{FIXTURE}");
    let _ = std::io::stdout().flush();
}

struct Session {
    model: String,
    models: Vec<String>,
    mode: String,
    modes: Vec<String>,
    effort: Option<String>,
    efforts: Vec<String>,
    variant_models: BTreeSet<String>,
    prompt_id: Option<Value>,
    turns: u32,
}

impl Session {
    fn from_flags(flags: &Flags) -> Self {
        let modes = mode_list();
        Self {
            model: flags.models.first().cloned().unwrap_or_else(|| "opencode/big-pickle".into()),
            models: flags.models.clone(),
            mode: "build".into(),
            modes,
            effort: None,
            efforts: flags.efforts.clone(),
            variant_models: flags.variant_models.clone(),
            prompt_id: None,
            turns: 0,
        }
    }

    fn options(&self) -> Value {
        let mut options = vec![select("model", &self.model, &self.models), select("mode", &self.mode, &self.modes)];
        if let Some(effort) = &self.effort {
            options.push(select("effort", effort, &self.efforts));
        }
        Value::Array(options)
    }
}

fn mode_list() -> Vec<String> {
    let mut modes = vec!["build".into(), "plan".into()];
    if config_has_bloblex_agent() {
        modes.push("bloblex".into());
    }
    modes
}

fn config_has_bloblex_agent() -> bool {
    let Ok(raw) = env::var("OPENCODE_CONFIG_CONTENT") else {
        return false;
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value["agent"]["bloblex"].as_object().map(|_| ()))
        .is_some()
}

fn select(id: &str, current: &str, values: &[String]) -> Value {
    json!({
        "id": id,
        "currentValue": current,
        "options": values.iter().map(|value| json!({"value": value, "name": value})).collect::<Vec<_>>()
    })
}

fn acp_main(_args: &[String], flags: &Flags) {
    let mut session = Session::from_flags(flags);
    let mut rpc = Vec::new();
    write_record(flags, &rpc, Some(&session));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        if method.is_empty() {
            continue;
        }
        let mut entry = json!({"method": method});
        if method == "session/set_config_option" {
            entry["configId"] = message["params"]["configId"].clone();
            entry["value"] = message["params"]["value"].clone();
        }
        rpc.push(entry);
        write_record(flags, &rpc, Some(&session));
        if method == "initialized" {
            let _ = writeln!(std::io::stderr(), "Method not found");
            continue;
        }
        if method == "session/cancel" {
            if let Some(id) = session.prompt_id.take() {
                finish_prompt(&mut stdout, &id, "cancelled", true);
            }
            continue;
        }
        let Some(id) = message.get("id").cloned() else { continue };
        match method {
            "initialize" => {
                respond(
                    &mut stdout,
                    &id,
                    json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": true}, "agentInfo": {"name": "fake-opencode", "version": "test"}}),
                );
            }
            "session/new" | "session/load" => {
                let session_id = message["params"]["sessionId"].as_str().unwrap_or("native-session");
                respond(&mut stdout, &id, json!({"sessionId": session_id, "configOptions": session.options()}));
            }
            "session/set_config_option" => {
                let config_id = message["params"]["configId"].as_str().unwrap_or("");
                let value = message["params"]["value"].as_str().unwrap_or("");
                if !apply_option(&mut session, config_id, value) {
                    error(&mut stdout, &id, -32602, "option value is not offered");
                } else {
                    respond(&mut stdout, &id, json!({"configOptions": session.options()}));
                }
                write_record(flags, &rpc, Some(&session));
            }
            "session/prompt" => handle_prompt(&mut stdout, flags, &mut session, &id),
            "session/close" => respond(&mut stdout, &id, json!({})),
            _ => error(&mut stdout, &id, -32601, "method not found"),
        }
    }
}

fn apply_option(session: &mut Session, config_id: &str, value: &str) -> bool {
    match config_id {
        "model" if session.models.iter().any(|model| model == value) => {
            session.model = value.to_owned();
            session.effort = if session.variant_models.contains(value) {
                Some(session.effort.clone().unwrap_or_else(|| session.efforts.first().cloned().unwrap_or_else(|| "low".into())))
            } else {
                None
            };
            true
        }
        "mode" if session.modes.iter().any(|mode| mode == value) => {
            session.mode = value.to_owned();
            true
        }
        "effort" if session.effort.is_some() && session.efforts.iter().any(|effort| effort == value) => {
            session.effort = Some(value.to_owned());
            true
        }
        _ => false,
    }
}

fn handle_prompt(stdout: &mut impl Write, flags: &Flags, session: &mut Session, id: &Value) {
    session.turns += 1;
    let turn = session.turns;
    if flags.usage == "cancel" {
        session.prompt_id = Some(id.clone());
        notify(stdout, &chunk("fixture response"));
        return;
    }
    match flags.usage.as_str() {
        "partial" => notify(stdout, &usage_line(4000, 200000, "0.0015894")),
        "none" => {}
        "failed" => notify(stdout, &usage_line(0, 200000, "0")),
        "error" => {
            error(stdout, id, -32000, "provider failed");
            return;
        }
        _ => {
            if turn == 1 {
                notify(stdout, &usage_line(4000, 200000, "0.0015894"));
            } else {
                notify(stdout, &usage_line(4030, 200000, "0.001637988"));
            }
        }
    }
    notify(stdout, &chunk("fixture response"));
    let result = match flags.usage.as_str() {
        "partial" | "none" => json!({"stopReason": "end_turn"}),
        "failed" => json!({"stopReason": "error", "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "thoughtTokens": 0, "cachedReadTokens": 0}}),
        _ if turn >= 2 => json!({"stopReason": "end_turn", "usage": {"inputTokens": 30, "outputTokens": 12, "totalTokens": 132, "thoughtTokens": 2, "cachedReadTokens": 90}}),
        _ => json!({"stopReason": "end_turn", "usage": {"inputTokens": 120, "outputTokens": 30, "totalTokens": 150, "thoughtTokens": 23}}),
    };
    respond(stdout, id, result);
}

fn finish_prompt(stdout: &mut impl Write, id: &Value, stop_reason: &str, zeros: bool) {
    if zeros {
        notify(stdout, &usage_line(0, 200000, "0"));
    }
    let result = if zeros {
        json!({"stopReason": stop_reason, "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "thoughtTokens": 0, "cachedReadTokens": 0}})
    } else {
        json!({"stopReason": stop_reason})
    };
    respond(stdout, id, result);
}

fn usage_line(used: u64, size: u64, amount: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"native-session","update":{{"sessionUpdate":"usage_update","used":{used},"size":{size},"cost":{{"amount":{amount},"currency":"USD"}}}}}}}}"#
    )
}

fn chunk(text: &str) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": "native-session", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}
    }))
    .unwrap_or_default()
}

fn respond(stdout: &mut impl Write, id: &Value, result: Value) {
    write_json(stdout, &json!({"jsonrpc": "2.0", "id": id, "result": result}));
}

fn error(stdout: &mut impl Write, id: &Value, code: i64, message: &str) {
    write_json(stdout, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
}

fn notify(stdout: &mut impl Write, line: &str) {
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

fn write_json(stdout: &mut impl Write, value: &Value) {
    if let Ok(line) = serde_json::to_string(value) {
        notify(stdout, &line);
    }
}

fn write_record(flags: &Flags, rpc: &[Value], _session: Option<&Session>) {
    let Some(path) = &flags.record else { return };
    let mut keys = env::vars().map(|(key, _)| key).collect::<Vec<_>>();
    keys.sort();
    let mut allow = serde_json::Map::new();
    for key in ["LANG", "LC_ALL", "TZ", "NO_COLOR", "TERM"] {
        if let Ok(value) = env::var(key) {
            allow.insert(key.into(), json!(value));
        }
    }
    let isolated = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_DATA_DIR", "OPENCODE_CACHE_DIR", "OPENCODE_STATE_DIR"]
        .into_iter()
        .filter(|key| env::var(key).ok().is_some_and(|value| value.contains(ISOLATION_MARKER)))
        .collect::<Vec<_>>();
    let config = config_shape();
    let body = json!({
        "pid": std::process::id(),
        "argv": env::args().skip(1).collect::<Vec<_>>(),
        "env_keys": keys,
        "allow": allow,
        "config": config,
        "isolated_dirs": isolated,
        "rpc": rpc,
    });
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("tmp");
    if fs::write(&tmp, serde_json::to_vec_pretty(&body).unwrap_or_default()).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

fn config_shape() -> Value {
    let Ok(raw) = env::var("OPENCODE_CONFIG_CONTENT") else {
        return json!({"ok": false});
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return json!({"ok": false});
    };
    let keys = value.as_object().map(|map| map.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
    let agent = &value["agent"]["bloblex"];
    let prompt = agent["prompt"].as_str().unwrap_or("");
    json!({
        "ok": true,
        "keys": keys,
        "schema": value["$schema"],
        "model": value.get("model").cloned().unwrap_or(Value::Null),
        "agent_ids": value["agent"].as_object().map(|map| map.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        "bloblex_mode": agent["mode"],
        "bloblex_model": agent.get("model").cloned().unwrap_or(Value::Null),
        "prompt_present": !prompt.is_empty(),
        "prompt_sha256": if prompt.is_empty() { Value::Null } else { json!(sha256_hex(prompt.as_bytes())) },
    })
}
