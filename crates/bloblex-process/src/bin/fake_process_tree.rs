use std::{fs, process::Command, thread, time::Duration};

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("worker") {
        loop { thread::sleep(Duration::from_secs(60)); }
    }
    let signal = args.get(1).expect("signal path");
    let pid_path = args.get(2).expect("pid path");
    while !std::path::Path::new(signal).exists() { thread::sleep(Duration::from_millis(10)); }
    let worker = Command::new(std::env::current_exe().unwrap()).arg("worker").spawn().unwrap();
    fs::write(pid_path, worker.id().to_string()).unwrap();
    loop { thread::sleep(Duration::from_secs(60)); }
}
