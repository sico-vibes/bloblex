//! Pairing (FIX29 WP6b): the eight-character code, the one live offer, the
//! lock, the pending request and the device token.
//!
//! The rules come from `docs/remote/PROTOCOL.md` §4.3:
//!
//! * one offer at a time, eight characters in two groups, five minutes;
//! * five wrong attempts burn the code;
//! * the first correct code **locks** the offer to that request — every later
//!   submission, right or wrong, is refused;
//! * the owner approves with a tier or rejects;
//! * every failure answers the same `pairing_invalid`, so a guesser cannot tell
//!   a wrong code from an expired or burned one;
//! * the device token is 256 random bits, and the host keeps only
//!   `sha256(token)`.
//!
//! All state is in memory: an offer that dies with the daemon is exactly an
//! offer that expired, and the owner simply starts a new one.

use crate::remote::policy::Tier;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use rand::{Rng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// 32 symbols, no `0`/`O` and no `1`/`I`: an eight-character code is then 40
/// bits and cannot be misread out loud.
pub const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// How long a code lives.
pub const OFFER_TTL_MINUTES: i64 = 5;
/// Wrong attempts before the code burns.
pub const MAX_WRONG_ATTEMPTS: u32 = 5;
/// The cookie that names the pending request.
pub const PAIR_COOKIE: &str = "__Host-bitbots_pair";
/// The cookie that carries the device token.
pub const DEVICE_COOKIE: &str = "__Host-bitbots_remote";

/// The one sentence every pairing failure returns.
pub const PAIRING_INVALID_MESSAGE: &str =
    "That pairing code is not valid. It may be wrong, used, or out of time; start a new one on the computer.";
pub const PAIRING_INVALID_CODE: &str = "pairing_invalid";

/// A code such as `K7QM-4XPD`.
pub fn generate_code() -> String {
    let mut rng = rand::rng();
    let mut code = String::with_capacity(9);
    for index in 0..8 {
        if index == 4 {
            code.push('-');
        }
        let symbol = CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())];
        code.push(symbol as char);
    }
    code
}

/// A 256-bit device token, base64url without padding.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The only form of the token the host keeps.
pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Constant-time comparison of a stored digest with a presented token.
pub fn token_matches(stored_hex: &str, token: &str) -> bool {
    let candidate = hash_token(token);
    if stored_hex.len() != candidate.len() {
        return false;
    }
    stored_hex.as_bytes().ct_eq(candidate.as_bytes()).into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Approved,
    Rejected,
    Expired,
    Cancelled,
    Burned,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Pending => "pending",
            Outcome::Approved => "approved",
            Outcome::Rejected => "rejected",
            Outcome::Expired => "expired",
            Outcome::Cancelled => "cancelled",
            Outcome::Burned => "burned",
        }
    }
}

/// What the phone observes when it polls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Poll {
    Pending,
    /// The owner approved; the token is issued exactly here, with the device
    /// record the host should store.
    Approved { token: String, device: Value },
    Rejected,
    Expired,
}

/// The request that locked the offer.
#[derive(Clone, Debug)]
pub struct Pending {
    pub name: String,
    pub kind: String,
    pub platform: String,
    pub login: Option<String>,
    pub outcome: Outcome,
    pub tier: Option<Tier>,
    pub token: Option<String>,
    /// The device record minted at approval, waiting to be stored when the
    /// phone collects its cookie.
    pub device: Option<Value>,
    /// How the request arrived: `tailscale` (a pairing code) or `native` (a
    /// password sign-in). The desktop approval dialog and the event carry it.
    pub method: String,
}

/// The one live offer.
#[derive(Clone, Debug)]
pub struct Offer {
    pub pairing_id: String,
    pub code: String,
    pub expires_at: DateTime<Utc>,
    pub attempts_left: u32,
    pub burned: bool,
    pub cancelled: bool,
    pub pending: Option<Pending>,
}

impl Offer {
    pub fn attempts_left(&self) -> u32 {
        if self.burned {
            0
        } else {
            self.attempts_left
        }
    }

    /// A live offer still accepts a code.
    pub fn is_open(&self) -> bool {
        !self.burned && !self.cancelled && self.pending.is_none()
    }

    pub fn expired_at(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }
}

#[derive(Default)]
pub struct PairingState {
    offer: Option<Offer>,
}

impl PairingState {
    #[cfg(test)]
    pub fn offer(&self) -> Option<&Offer> {
        self.offer.as_ref()
    }

    /// Start a new offer; any previous offer is cancelled.
    pub fn begin(&mut self, now: DateTime<Utc>) -> Offer {
        if let Some(previous) = self.offer.as_mut() {
            if previous.pending.as_ref().map(|pending| pending.outcome) == Some(Outcome::Pending) {
                previous.pending.as_mut().unwrap().outcome = Outcome::Cancelled;
            }
        }
        let offer = Offer {
            pairing_id: uuid::Uuid::new_v4().to_string(),
            code: generate_code(),
            expires_at: now + Duration::minutes(OFFER_TTL_MINUTES),
            attempts_left: MAX_WRONG_ATTEMPTS,
            burned: false,
            cancelled: false,
            pending: None,
        };
        self.offer = Some(offer.clone());
        offer
    }

    /// Throw the live offer away. `None` when there was nothing to cancel.
    pub fn cancel(&mut self, now: DateTime<Utc>) -> Option<Outcome> {
        let offer = self.offer.as_mut()?;
        if offer.expired_at(now) {
            return Some(Outcome::Expired);
        }
        let outcome = if offer.burned {
            Outcome::Burned
        } else if offer.pending.as_ref().map(|pending| pending.outcome) == Some(Outcome::Pending) {
            offer.pending.as_mut().unwrap().outcome = Outcome::Cancelled;
            Outcome::Cancelled
        } else {
            offer.cancelled = true;
            Outcome::Cancelled
        };
        Some(outcome)
    }

    /// A device submits a code. `Ok(pairing_id)` locks the offer to it; `Err`
    /// is always the same `pairing_invalid`.
    pub fn submit(&mut self, code: &str, name: &str, kind: &str, platform: &str, login: Option<String>, now: DateTime<Utc>) -> Result<String, String> {
        let Some(offer) = self.offer.as_mut() else {
            return Err(PAIRING_INVALID_CODE.to_string());
        };
        if !offer.is_open() || offer.expired_at(now) {
            return Err(PAIRING_INVALID_CODE.to_string());
        }
        if !constant_eq(offer.code.as_bytes(), code.trim().as_bytes()) {
            offer.attempts_left = offer.attempts_left.saturating_sub(1);
            if offer.attempts_left == 0 {
                offer.burned = true;
            }
            return Err(PAIRING_INVALID_CODE.to_string());
        }
        let name = truncate(name, 80);
        offer.pending = Some(Pending {
            name: if name.is_empty() { "A device".to_string() } else { name },
            kind: kind_of(kind),
            platform: truncate(platform, 80),
            login,
            outcome: Outcome::Pending,
            tier: None,
            token: None,
            device: None,
            method: "tailscale".to_string(),
        });
        Ok(offer.pairing_id.clone())
    }

    /// A Native sign-in creates a pending request directly: there is no code,
    /// because the device proved itself with the account password. Everything
    /// after this is the pairing path unchanged (owner approval, poll, cookie).
    pub fn begin_native(&mut self, name: &str, kind: &str, platform: &str, now: DateTime<Utc>) -> String {
        if let Some(previous) = self.offer.as_mut() {
            if previous.pending.as_ref().map(|pending| pending.outcome) == Some(Outcome::Pending) {
                previous.pending.as_mut().unwrap().outcome = Outcome::Cancelled;
            }
        }
        let pairing_id = uuid::Uuid::new_v4().to_string();
        let name = truncate(name, 80);
        self.offer = Some(Offer {
            pairing_id: pairing_id.clone(),
            code: String::new(),
            expires_at: now + Duration::minutes(OFFER_TTL_MINUTES),
            attempts_left: 0,
            burned: false,
            cancelled: false,
            pending: Some(Pending {
                name: if name.is_empty() { "A device".to_string() } else { name },
                kind: kind_of(kind),
                platform: truncate(platform, 80),
                login: None,
                outcome: Outcome::Pending,
                tier: None,
                token: None,
                device: None,
                method: "native".to_string(),
            }),
        });
        pairing_id
    }

    /// The pending request for the desktop's approval dialog.
    pub fn pending(&self, pairing_id: &str, _now: DateTime<Utc>) -> Option<Value> {
        let offer = self.offer.as_ref()?;
        if offer.pairing_id != pairing_id {
            return None;
        }
        let pending = offer.pending.as_ref()?;
        Some(json!({
            "pairingId": offer.pairing_id,
            "name": pending.name,
            "kind": pending.kind,
            "platform": pending.platform,
            "login": pending.login,
            "method": pending.method,
            "expiresAt": offer.expires_at.to_rfc3339(),
        }))
    }

    /// The owner decides. Approving mints the token and freezes the tier.
    pub fn confirm(&mut self, pairing_id: &str, approve: bool, tier: Option<Tier>, now: DateTime<Utc>) -> Result<Option<Value>, String> {
        let Some(offer) = self.offer.as_mut() else {
            return Err("There is no pending pairing request.".to_string());
        };
        if offer.pairing_id != pairing_id {
            return Err("There is no pending pairing request.".to_string());
        }
        if offer.expired_at(now) {
            if let Some(pending) = offer.pending.as_mut() {
                if pending.outcome == Outcome::Pending {
                    pending.outcome = Outcome::Expired;
                }
            }
            return Err("That pairing request has expired. Start a new one.".to_string());
        }
        let Some(pending) = offer.pending.as_mut() else {
            return Err("There is no pending pairing request.".to_string());
        };
        if pending.outcome != Outcome::Pending {
            return Err("That pairing request was already decided.".to_string());
        }
        if !approve {
            pending.outcome = Outcome::Rejected;
            return Ok(None);
        }
        let Some(tier) = tier else {
            return Err("Choose what this device may do.".to_string());
        };
        let token = generate_token();
        let device = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "name": pending.name,
            "kind": pending.kind,
            "platform": pending.platform,
            "tier": tier.as_str(),
            "login": pending.login,
            "pairedAt": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        pending.outcome = Outcome::Approved;
        pending.tier = Some(tier);
        pending.token = Some(token.clone());
        pending.device = Some(device.clone());
        Ok(Some(json!({
            "pairingId": offer.pairing_id,
            "device": device,
            "token": token,
        })))
    }

    /// The phone polls. An approval hands over the token exactly once per
    /// pending request; later polls keep answering `approved` with the same
    /// token until the offer is replaced, so a lost response is not fatal.
    pub fn poll(&mut self, pairing_id: &str, now: DateTime<Utc>) -> Poll {
        let Some(offer) = self.offer.as_mut() else {
            return Poll::Expired;
        };
        if offer.pairing_id != pairing_id {
            return Poll::Expired;
        }
        let Some(pending) = offer.pending.as_mut() else {
            // The code was submitted, then the offer expired before the lock.
            return Poll::Expired;
        };
        match pending.outcome {
            Outcome::Pending => {
                let expired = offer.expired_at(now);
                if expired {
                    if let Some(pending) = offer.pending.as_mut() {
                        pending.outcome = Outcome::Expired;
                    }
                    Poll::Expired
                } else {
                    Poll::Pending
                }
            }
            Outcome::Approved => {
                let token = pending.token.clone();
                let device = pending.device.clone();
                match (token, device) {
                    (Some(token), Some(device)) => Poll::Approved { token, device },
                    _ => Poll::Expired,
                }
            }
            Outcome::Rejected => Poll::Rejected,
            Outcome::Expired | Outcome::Cancelled | Outcome::Burned => Poll::Expired,
        }
    }

    /// Records the event outcome of an offer that has finished.
    pub fn take_outcome(&self, pairing_id: &str) -> Option<Outcome> {
        let offer = self.offer.as_ref()?;
        if offer.pairing_id != pairing_id {
            return None;
        }
        if let Some(pending) = offer.pending.as_ref() {
            return Some(pending.outcome);
        }
        if offer.burned {
            return Some(Outcome::Burned);
        }
        if offer.cancelled {
            return Some(Outcome::Cancelled);
        }
        None
    }
}

fn kind_of(kind: &str) -> String {
    match kind {
        "phone" | "tablet" | "browser" | "computer" | "machine" => kind.to_string(),
        _ => "browser".to_string(),
    }
}

fn truncate(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

/// Same-length, constant-time comparison, for the pairing code.
fn constant_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.ct_eq(right).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn the_alphabet_is_thirty_two_symbols_without_look_alikes() {
        assert_eq!(CODE_ALPHABET.len(), 32);
        for look_alike in [b'0', b'O', b'1', b'I'] {
            assert!(!CODE_ALPHABET.contains(&look_alike), "{}", look_alike as char);
        }
        let mut seen = std::collections::HashSet::new();
        for symbol in CODE_ALPHABET {
            assert!(seen.insert(*symbol));
        }
    }

    #[test]
    fn a_code_is_eight_characters_in_two_groups() {
        for _ in 0..50 {
            let code = generate_code();
            assert_eq!(code.len(), 9, "{code}");
            assert_eq!(code.as_bytes()[4], b'-');
            for (index, symbol) in code.chars().enumerate() {
                if index == 4 {
                    continue;
                }
                assert!(CODE_ALPHABET.contains(&(symbol as u8)), "{code}");
            }
        }
    }

    #[test]
    fn a_token_is_256_bits_and_only_its_hash_is_compared() {
        let token = generate_token();
        assert_eq!(token.len(), 43, "{token}");
        let hash = hash_token(&token);
        assert_eq!(hash.len(), 64);
        assert!(token_matches(&hash, &token));
        assert!(!token_matches(&hash, "not-the-token"));
        assert!(!token_matches(&hash, ""));
        // Two tokens never collide in practice, and the hash hides the token.
        assert_ne!(hash, generate_token());
        assert!(!hash.contains(&token));
    }

    #[test]
    fn one_live_offer_and_a_new_one_cancels_the_old() {
        let mut state = PairingState::default();
        let first = state.begin(now());
        let second = state.begin(now());
        assert_ne!(first.pairing_id, second.pairing_id);
        assert_eq!(state.offer().unwrap().pairing_id, second.pairing_id);
    }

    #[test]
    fn a_wrong_code_counts_and_five_wrong_attempts_burn_it() {
        let mut state = PairingState::default();
        let offer = state.begin(now());
        for attempt in 1..=MAX_WRONG_ATTEMPTS {
            let wrong = if offer.code == "AAAA-AAAA" { "BBBB-BBBB" } else { "AAAA-AAAA" };
            assert_eq!(state.submit(wrong, "phone", "phone", "iOS", None, now()), Err(PAIRING_INVALID_CODE.to_string()));
            assert_eq!(state.offer().unwrap().attempts_left(), MAX_WRONG_ATTEMPTS - attempt);
        }
        assert!(state.offer().unwrap().burned);
        // Even the right code is refused once burned, and the answer is the same.
        assert_eq!(state.submit(&offer.code, "phone", "phone", "iOS", None, now()), Err(PAIRING_INVALID_CODE.to_string()));
    }

    #[test]
    fn the_first_correct_code_locks_the_offer() {
        let mut state = PairingState::default();
        let offer = state.begin(now());
        let pairing_id = state.submit(&offer.code, "Sam's phone", "phone", "iOS 19", Some("sam@example.com".into()), now()).unwrap();
        assert_eq!(pairing_id, offer.pairing_id);
        // A later correct code is refused too.
        assert_eq!(state.submit(&offer.code, "attacker", "browser", "Chrome", None, now()), Err(PAIRING_INVALID_CODE.to_string()));
        assert_eq!(state.submit("AAAA-AAAA", "attacker", "browser", "Chrome", None, now()), Err(PAIRING_INVALID_CODE.to_string()));
        let pending = state.pending(&offer.pairing_id, now()).unwrap();
        assert_eq!(pending["name"], "Sam's phone");
        assert_eq!(pending["login"], "sam@example.com");
    }

    #[test]
    fn an_expired_offer_refuses_even_the_right_code() {
        let mut state = PairingState::default();
        let start = now();
        let offer = state.begin(start);
        let later = start + Duration::minutes(OFFER_TTL_MINUTES) + Duration::seconds(1);
        assert_eq!(state.submit(&offer.code, "phone", "phone", "iOS", None, later), Err(PAIRING_INVALID_CODE.to_string()));
    }

    #[test]
    fn an_expired_pending_request_polls_as_expired() {
        let mut state = PairingState::default();
        let start = now();
        let offer = state.begin(start);
        state.submit(&offer.code, "phone", "phone", "iOS", None, start).unwrap();
        let later = start + Duration::minutes(OFFER_TTL_MINUTES) + Duration::seconds(1);
        assert_eq!(state.poll(&offer.pairing_id, later), Poll::Expired);
    }

    #[test]
    fn approval_issues_a_token_at_the_chosen_tier() {
        let mut state = PairingState::default();
        let offer = state.begin(now());
        let pairing_id = state.submit(&offer.code, "phone", "phone", "iOS", None, now()).unwrap();
        let approved = state.confirm(&pairing_id, true, Some(Tier::Chat), now()).unwrap().unwrap();
        assert_eq!(approved["device"]["tier"], "chat");
        let token = approved["token"].as_str().unwrap().to_string();
        assert_eq!(hash_token(&token).len(), 64);
        match state.poll(&pairing_id, now()) {
            Poll::Approved { token: polled, device } => {
                assert_eq!(polled, token);
                assert_eq!(device["tier"], "chat");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rejection_burns_the_offer() {
        let mut state = PairingState::default();
        let offer = state.begin(now());
        let pairing_id = state.submit(&offer.code, "phone", "phone", "iOS", None, now()).unwrap();
        assert!(state.confirm(&pairing_id, false, None, now()).unwrap().is_none());
        assert_eq!(state.poll(&pairing_id, now()), Poll::Rejected);
        assert!(state.offer().unwrap().pending.is_some());
        // The offer is not open for a new submission.
        assert!(!state.offer().unwrap().is_open());
        assert_eq!(state.submit(&offer.code, "other", "phone", "iOS", None, now()), Err(PAIRING_INVALID_CODE.to_string()));
    }

    #[test]
    fn approving_without_a_tier_is_refused() {
        let mut state = PairingState::default();
        let offer = state.begin(now());
        let pairing_id = state.submit(&offer.code, "phone", "phone", "iOS", None, now()).unwrap();
        assert!(state.confirm(&pairing_id, true, None, now()).is_err());
        assert_eq!(state.poll(&pairing_id, now()), Poll::Pending);
    }

    #[test]
    fn cancel_and_take_outcome_report_what_happened() {
        let mut state = PairingState::default();
        let offer = state.begin(now());
        assert_eq!(state.cancel(now()), Some(Outcome::Cancelled));
        assert_eq!(state.take_outcome(&offer.pairing_id), Some(Outcome::Cancelled));
        assert!(state.offer().unwrap().cancelled);
    }

    #[test]
    fn cancel_reports_the_pending_request_as_cancelled() {
        let mut state = PairingState::default();
        let offer = state.begin(now());
        let pairing_id = state.submit(&offer.code, "phone", "phone", "iOS", None, now()).unwrap();
        assert_eq!(state.cancel(now()), Some(Outcome::Cancelled));
        assert_eq!(state.poll(&pairing_id, now()), Poll::Expired);
    }
}
