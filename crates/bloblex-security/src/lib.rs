use rand::RngCore;
use subtle::ConstantTimeEq;

pub fn new_capability() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn capability_matches(expected: &str, supplied: &str) -> bool {
    expected.as_bytes().ct_eq(supplied.as_bytes()).into()
}
pub fn is_loopback(addr: std::net::SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// Credential markers shared by provider-error sanitising and memory-write
/// rails. `lower` markers are matched case-insensitively; token-shaped words
/// (`sk-...`) are only flagged when they also look like a real key, so ordinary
/// prose such as "task-run" is not mistaken for a secret.
fn looks_like_key(value: &str) -> bool {
    value.bytes().any(|byte| byte.is_ascii_digit()) && value.bytes().any(|byte| byte.is_ascii_alphabetic())
}

fn trim_token(part: &str) -> &str {
    part.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-' && ch != '.')
}

/// Whether `text` contains a credential marker. Used to refuse storing memory
/// bodies (and the `profile.about` note) that carry secrets, and by
/// `safe_provider_error_detail` so both paths share one list.
pub fn contains_secret_marker(text: &str) -> bool {
    if text.is_empty() { return false; }
    let lower = text.to_ascii_lowercase();
    let markers = [
        "sk-ant-",
        "ghp_",
        "gho_",
        "github_pat_",
        "xoxb-",
        "xapp-",
        "xox",
        "akia",
        "-----begin",
        "bearer ",
        "api_key",
        "api-key",
        "api key",
        "x-api-key",
        "authorization",
        "access_token",
        "refresh_token",
        "oauth token",
        "password=",
        "secret=",
        "claude_code_oauth_token",
        "anthropic_auth_token",
    ];
    if markers.iter().any(|marker| lower.contains(marker)) { return true; }
    text.split_whitespace().any(|part| {
        let value = trim_token(part);
        let keyed = value.starts_with("sk-") || value.starts_with("ghp_");
        (keyed && value.len() >= 24 && looks_like_key(value))
            || (value.len() >= 40 && looks_like_key(value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_is_256_bits_and_compared() {
        let t = new_capability();
        assert_eq!(t.len(), 64);
        assert!(capability_matches(&t, &t));
        assert!(!capability_matches(&t, "wrong"));
        assert!(is_loopback("127.0.0.1:1".parse().unwrap()));
        assert!(!is_loopback("192.168.1.4:1".parse().unwrap()));
    }
    #[test]
    fn secret_markers_cover_common_key_shapes_without_flagging_prose() {
        assert!(contains_secret_marker("Invalid API key sk-ant-test-secret"));
        assert!(contains_secret_marker("token ghp_abcdefghijklmnopqrstuvwxyz012345"));
        assert!(contains_secret_marker("AKIAIOSFODNN7EXAMPLE"));
        assert!(contains_secret_marker("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(contains_secret_marker("Authorization: xoxb-1234567890"));
        assert!(contains_secret_marker("please use Bearer abcdef"));
        assert!(contains_secret_marker(&format!("opaque {}", "a1".repeat(30))));
        assert!(!contains_secret_marker("429 rate limit exceeded; retry later"));
        assert!(!contains_secret_marker(&"x".repeat(500)));
        assert!(!contains_secret_marker("the task-run finished in 3 seconds"));
        assert!(!contains_secret_marker("a long ordinary sentence about project planning and reviews"));
    }
}
