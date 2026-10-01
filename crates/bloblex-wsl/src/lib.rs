use std::path::Path;
use tokio::process::Command;

pub async fn distributions() -> Result<Vec<String>, String> {
    let out = Command::new("wsl.exe")
        .args(["-l", "-q"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    let words = out
        .stdout
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect::<Vec<_>>();
    let text = String::from_utf16_lossy(&words);
    Ok(text
        .lines()
        .map(|l| l.trim().trim_matches('\0').to_owned())
        .filter(|l| !l.is_empty())
        .collect())
}

pub fn windows_to_wsl(path: &str) -> Option<String> {
    let p = path.trim();
    if let Some(rest) = p
        .strip_prefix(r"\\wsl.localhost\")
        .or_else(|| p.strip_prefix(r"\\wsl$\"))
    {
        let mut parts = rest.splitn(2, '\\');
        let _distro = parts.next()?;
        return Some(format!("/{}", parts.next()?.replace('\\', "/")));
    }
    let bytes = p.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
        Some(format!(
            "/mnt/{}/{}",
            (bytes[0] as char).to_ascii_lowercase(),
            p[3..].replace('\\', "/")
        ))
    } else {
        None
    }
}

pub fn wsl_to_windows_unc(distro: &str, path: &str) -> String {
    format!(
        r"\\wsl.localhost\{}\{}",
        distro,
        path.trim_start_matches('/').replace('/', "\\")
    )
}
pub fn path_exists(path: &Path) -> bool {
    path.is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_windows_spaces_and_unicode() {
        assert_eq!(
            windows_to_wsl(r"C:\Users\Ada Lovelace\資料\repo").as_deref(),
            Some("/mnt/c/Users/Ada Lovelace/資料/repo")
        );
    }
    #[test]
    fn maps_wsl_unc() {
        assert_eq!(
            windows_to_wsl(r"\\wsl.localhost\Ubuntu\home\me\repo").as_deref(),
            Some("/home/me/repo")
        );
        assert_eq!(
            wsl_to_windows_unc("Ubuntu", "/home/me/repo"),
            r"\\wsl.localhost\Ubuntu\home\me\repo"
        );
    }
}
