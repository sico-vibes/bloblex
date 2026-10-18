//! Test-only live-CLI recorder (FIX39 P11).
//!
//! This binary sits between a production adapter and the real provider CLI.
//! The adapter is pointed at this recorder instead of the CLI; the recorder
//! spawns the real CLI, forwards every line in both directions unchanged, and
//! records a sanitised NDJSON transcript in the shared wire-fixture format
//! (`src/bin/wire_support/wire_replay.rs`). The recorded transcript is then
//! replayed offline by the provider's own fake binary via `--replay`, so a real
//! CLI session can be exercised on every gate without spending tokens.
//!
//! Invocation (the adapter appends its own protocol arguments after `--`):
//!
//! ```text
//! <recorder> --provider claude --version 2.1.302 --real <claude>
//!            --record <fixture> --scenario <name> -- <protocol args...>
//! ```
//!
//! Without `--record` it is a plain pass-through. It is never compiled into a
//! production adapter and never reads or writes provider credentials: the real
//! CLI uses its own installed sign-in, read-only.
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    thread,
};

#[path = "wire_support/wire_replay.rs"]
#[allow(dead_code)]
mod wire_replay;

struct Args {
    provider: String,
    version: String,
    real: Option<String>,
    record: Option<String>,
    scenario: Option<String>,
    passthrough: Vec<String>,
}

fn parse() -> Args {
    let mut args = Args {
        provider: String::new(),
        version: String::new(),
        real: None,
        record: None,
        scenario: None,
        passthrough: Vec::new(),
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--provider" => args.provider = iter.next().unwrap_or_default(),
            "--version" => args.version = iter.next().unwrap_or_default(),
            "--real" => args.real = iter.next(),
            "--record" => args.record = iter.next(),
            "--scenario" => args.scenario = iter.next(),
            "--" => {
                args.passthrough.extend(iter);
                break;
            }
            other => args.passthrough.push(other.to_owned()),
        }
    }
    args
}

fn main() {
    let args = parse();
    // The recorder is a separate process, so setting the shared recorder's
    // environment here cannot leak into the test process or a sibling run.
    if let Some(record) = args.record.as_deref() {
        std::env::set_var("BLOBLEX_WIRE_RECORD", record);
        std::env::set_var(
            "BLOBLEX_WIRE_SCENARIO",
            args.scenario.as_deref().unwrap_or("live"),
        );
    }
    wire_replay::init_live(&args.provider, &args.version);
    let Some(real) = args.real else {
        eprintln!("cli recorder: --real <provider executable> is required");
        std::process::exit(64);
    };
    let mut child = match Command::new(&real)
        .args(&args.passthrough)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("cli recorder: could not start the provider: {error}");
            std::process::exit(65);
        }
    };
    let mut child_stdin = child.stdin.take().expect("piped stdin");
    let child_stdout = child.stdout.take().expect("piped stdout");
    // adapter -> provider
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();
        while let Ok(Some(line)) = lines.next().transpose() {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                wire_replay::input(&value);
            }
            if child_stdin.write_all(line.as_bytes()).is_err()
                || child_stdin.write_all(b"\n").is_err()
            {
                break;
            }
            let _ = child_stdin.flush();
        }
        // Dropping `child_stdin` closes the provider's stdin so it can exit.
    });
    // provider -> adapter
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in BufReader::new(child_stdout).lines() {
        let Ok(line) = line else { break };
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            wire_replay::out(&value);
        }
        if out.write_all(line.as_bytes()).is_err() || out.write_all(b"\n").is_err() {
            break;
        }
        let _ = out.flush();
    }
    let code = child.wait().ok().and_then(|status| status.code()).unwrap_or(0);
    std::process::exit(code);
}
