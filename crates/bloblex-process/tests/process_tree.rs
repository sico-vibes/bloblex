use bloblex_process::{prepare_command, ProcessTree};
use std::{fs, path::PathBuf, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::process::Command;

fn child_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output();
        return output.ok().is_some_and(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()));
    }
    #[cfg(unix)]
    {
        std::path::Path::new("/proc").join(pid.to_string()).exists()
    }
    #[cfg(not(any(windows, unix)))]
    { let _ = pid; false }
}

#[tokio::test]
async fn cancellation_terminates_the_parent_and_long_lived_grandchild() {
    let root = std::env::temp_dir().join(format!(
        "bloblex-process-tree-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
    ));
    fs::create_dir_all(&root).unwrap();
    let signal = root.join("spawn-grandchild");
    let pid_path = root.join("grandchild.pid");
    let mut command = Command::new(env!("CARGO_BIN_EXE_fake-process-tree"));
    command.arg(&signal).arg(&pid_path);
    prepare_command(&mut command);
    let mut child = command.spawn().unwrap();
    let owner = ProcessTree::attach(&mut child).unwrap();
    fs::write(&signal, "go").unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while !pid_path.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let grandchild_pid: u32 = fs::read_to_string(&pid_path).unwrap().parse().unwrap();
    owner.terminate().unwrap();
    tokio::time::timeout(Duration::from_secs(3), child.wait()).await.unwrap().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while child_is_alive(grandchild_pid) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!child_is_alive(grandchild_pid), "grandchild process {grandchild_pid} remained alive");
    drop(owner);
    let _ = fs::remove_dir_all(PathBuf::from(root));
}
