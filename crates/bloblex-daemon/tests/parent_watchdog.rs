use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
#[allow(clippy::zombie_processes)]
fn parent_helper() {
    let Some(folder) = std::env::var_os("FIX39_PARENT_HELPER") else {
        return;
    };
    let folder = std::path::PathBuf::from(folder);
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_bitbotsd"))
        .env("BLOBLEX_PARENT_PID", std::process::id().to_string())
        .env("BLOBLEX_DB_PATH", folder.join("test.db"))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(daemon.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let ready: serde_json::Value = serde_json::from_str(&ready).unwrap();
    // Persist only a loopback address and our child's pid; never its capability.
    fs::write(
        folder.join("ready"),
        format!("{}\n{}", daemon.id(), ready["address"].as_str().unwrap()),
    )
    .unwrap();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    // Simulate an abrupt parent exit: no daemon.shutdown and no Child::kill.
}

#[test]
fn daemon_exits_when_its_parent_disappears() {
    let folder = std::env::temp_dir().join(format!("fix39-parent-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&folder).unwrap();
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "parent_helper", "--nocapture"])
        .env("FIX39_PARENT_HELPER", &folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !folder.join("ready").exists() {
        assert!(Instant::now() < deadline, "helper did not become ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    let ready = fs::read_to_string(folder.join("ready")).unwrap();
    let mut lines = ready.lines();
    let pid = lines.next().unwrap().to_string();
    let address = lines.next().unwrap();
    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    #[cfg(windows)]
    let process = unsafe { OpenProcess(0x0010_0000, 0, pid.parse().unwrap()) };
    #[cfg(windows)]
    assert!(!process.is_null());
    assert!(std::net::TcpStream::connect(address).is_ok());
    parent.stdin.take().unwrap().write_all(b"exit\n").unwrap();
    assert!(parent.wait().unwrap().success());
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::net::TcpStream::connect(address).is_ok() {
        if Instant::now() >= deadline {
            // Failure cleanup is restricted to the daemon this test created.
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid, "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = Command::new("kill").args(["-9", &pid]).status();
            }
            panic!("daemon survived its parent");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(windows)]
    {
        let exited = unsafe { WaitForSingleObject(process, 10_000) };
        unsafe {
            CloseHandle(process);
        }
        assert_eq!(exited, 0, "daemon closed its listener but did not exit");
    }
    let _ = fs::remove_dir_all(folder);
}
