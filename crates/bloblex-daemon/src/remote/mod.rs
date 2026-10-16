//! Remote mode (P1): the host-side gateway and its shared policy.
//!
//! WP6a (this work package) adds [`policy`], the Rust port of the remote method
//! and redaction policy in `apps/desktop/src/remote/tiers.json`. WP6b adds
//! `tailscale`, `pairing` and `web` here and is the first production caller of
//! [`policy`]; until then nothing in the daemon calls into this module, and
//! `mod remote;` in `main.rs` carries the `dead_code` allowance.

pub mod policy;
