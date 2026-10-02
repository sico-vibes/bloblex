use serde_json::json;
use std::{io::Write, path::PathBuf};

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let target = args.first().map(PathBuf::from);
    let grant_ok = args.len() >= 4 && args[1] == "/inheritance:r" && args[2] == "/grant:r"
        && (args[3].ends_with(":F") || args[3].ends_with(":(OI)(CI)F"));
    let target_ok = target.as_ref().is_some_and(|path| path.exists());
    let accepted = grant_ok && target_ok;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent().and_then(|p| p.parent()) {
            if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(root.join("acl-audit.jsonl")) {
                let _ = writeln!(log, "{}", json!({"args":args,"accepted":accepted}));
            }
        }
    }
    if !accepted { std::process::exit(1); }
}
