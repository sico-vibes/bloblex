use std::{io::Write, thread, time::Duration};

fn main() {
    let block = vec![b'x'; 16 * 1024];
    for _ in 0..512 {
        if std::io::stderr().write_all(&block).is_err() {
            return;
        }
    }
    let _ = std::io::stderr().flush();
    if let Some(marker) = std::env::args_os().nth(1) {
        let _ = std::fs::write(marker, b"complete");
    }
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}
