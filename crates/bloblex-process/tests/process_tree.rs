use bloblex_process::{prepare_command, ProcessTree, StdinWriter};
use std::{fs, path::PathBuf, time::{Duration, SystemTime, UNIX_EPOCH}};

const NONREADING_CHILD_IO_TIMEOUT: Duration = Duration::from_secs(15);
use tokio::{io::AsyncReadExt, process::Command};

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

#[tokio::test]
async fn stdin_writer_and_stderr_drain_bound_a_nonreading_child() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fake_pipe_child"));
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    prepare_command(&mut command);
    let mut child = command.spawn().unwrap();
    let tree = ProcessTree::attach(&mut child).unwrap();
    let stderr = child.stderr.take().unwrap();
    let drain = tokio::spawn(async move {
        let mut stderr = stderr;
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.unwrap();
        bytes
    });
    let stdin = child.stdin.take().unwrap();
    let mut writer = StdinWriter::new(stdin);
    let payload = vec![b'p'; 1024 * 1024];
    writer.write(&payload).await.unwrap();
    tokio::time::timeout(NONREADING_CHILD_IO_TIMEOUT, writer.close(&mut child, &tree))
        .await
        .expect("close must finish within the bounded grace and kill window");
    tokio::time::timeout(NONREADING_CHILD_IO_TIMEOUT, child.wait())
        .await
        .unwrap()
        .unwrap();
    let drained = tokio::time::timeout(NONREADING_CHILD_IO_TIMEOUT, drain)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(drained.len(), 8 * 1024 * 1024);
}
