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
}
