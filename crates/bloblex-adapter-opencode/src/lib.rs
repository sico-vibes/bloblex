//! OpenCode uses the provider-neutral ACP adapter. Its launcher adds `acp` and
//! `--cwd` directly to the resolved executable, matching the official CLI.
pub use bloblex_adapter_acp::AcpAdapter as OpenCodeAdapter;
pub const PROVIDER: &str = "opencode";
pub const PROTOCOL: &str = "acp-v1";
