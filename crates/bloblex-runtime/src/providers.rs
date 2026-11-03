//! The ACP providers `bloblex-adapter-acp` serves, from one table.
//!
//! OpenCode is not a row here: it has its own discovery path (a stored
//! credential read, a sign-in probe against its background service) and its own
//! launch flags, and its behaviour must not change. A row is a provider that
//! works through the same adapter with nothing provider-specific left to do.
//!
//! Qwen Code takes `--acp`. Its own `config.ts` today still accepts
//! `--experimental-acp`, but prints "deprecated ... use --acp instead", so the
//! table names the flag it tells you to use. Gemini CLI was removed on
//! 3 November 2026 (owner decision); Bitbots no longer looks for it.

/// One provider the ACP adapter runs.
#[derive(Debug, Clone, Copy)]
pub struct AcpProvider {
    /// The provider id stored on runtimes, bots and sessions.
    pub provider: &'static str,
    pub display_name: &'static str,
    /// The executable name looked up on `PATH`.
    pub command: &'static str,
    /// The arguments that put the CLI into ACP mode, after the adapter's own.
    pub args: &'static [&'static str],
    /// What the owner runs in a terminal to sign in. It holds no secret.
    pub sign_in_command: &'static str,
    pub install_hint: &'static str,
    /// Text that the CLI's `--help` prints when it can run in ACP mode: the proof discovery looks for.
    pub probe_token: &'static str,
}

pub const ACP_PROVIDERS: &[AcpProvider] = &[
    AcpProvider {
        provider: "qwen",
        display_name: "Qwen Code",
        command: "qwen",
        args: &["--acp"],
        sign_in_command: "qwen",
        install_hint: "Install Qwen Code with npm install -g @qwen-code/qwen-code",
        probe_token: "acp",
    },
    // Cursor's CLI is called `agent`; its docs start the ACP server with `agent acp`.
    AcpProvider {
        provider: "cursor",
        display_name: "Cursor CLI",
        command: "agent",
        args: &["acp"],
        sign_in_command: "agent login",
        install_hint: "Install the Cursor CLI from cursor.com/cli",
        probe_token: "acp",
    },
    // xAI's Grok Build CLI runs as an ACP agent with `grok agent stdio`.
    AcpProvider {
        provider: "grok",
        display_name: "Grok CLI",
        command: "grok",
        args: &["agent", "stdio"],
        sign_in_command: "grok login",
        install_hint: "Install the Grok CLI from x.ai/cli",
        probe_token: "agent",
    },
];

/// The row for a table provider.
pub fn acp_provider(provider: &str) -> Option<&'static AcpProvider> {
    ACP_PROVIDERS.iter().find(|row| row.provider == provider)
}

/// Whether a provider is served by `bloblex-adapter-acp`: OpenCode, or a table
/// row. This is the single answer for "does this provider speak ACP", used by
/// discovery, capabilities, attachments and images.
pub fn is_acp_provider(provider: &str) -> bool {
    provider == "opencode" || acp_provider(provider).is_some()
}

/// The arguments that put a provider's CLI into ACP mode. OpenCode 1.x and 2.x
/// take the `acp` subcommand; a table row names its own flag.
pub fn acp_launch_args(provider: &str) -> &'static [&'static str] {
    match acp_provider(provider) {
        Some(row) => row.args,
        // OpenCode, and the adapter's own default: the `acp` subcommand.
        None => &["acp"],
    }
}

/// Every provider Bitbots looks for on `PATH`, in display order.
pub fn discovery_ids() -> [&'static str; 6] {
    ["claude", "codex", "opencode", ACP_PROVIDERS[0].provider, ACP_PROVIDERS[1].provider, ACP_PROVIDERS[2].provider]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_names_the_flags_the_clis_ask_you_to_use() {
        assert_eq!(acp_launch_args("qwen"), &["--acp"]);
        assert_eq!(acp_launch_args("cursor"), &["acp"]);
        assert_eq!(acp_launch_args("grok"), &["agent", "stdio"]);
        // OpenCode keeps the subcommand it has always used.
        assert_eq!(acp_launch_args("opencode"), &["acp"]);
        for row in ACP_PROVIDERS {
            assert!(!row.args.is_empty() && !row.probe_token.is_empty());
            assert!(row.sign_in_command.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-'), "the sign-in command has no shell syntax");
            assert!(!row.display_name.is_empty() && !row.install_hint.is_empty());
        }
    }

    #[test]
    fn only_opencode_and_the_table_rows_speak_acp() {
        assert!(is_acp_provider("opencode"));
        assert!(is_acp_provider("qwen") && is_acp_provider("cursor") && is_acp_provider("grok"));
        for provider in ["claude", "codex", "", "gemini", "gemini-cli"] {
            assert!(!is_acp_provider(provider), "{provider}");
            assert!(acp_provider(provider).is_none(), "{provider}");
        }
        assert_eq!(discovery_ids(), ["claude", "codex", "opencode", "qwen", "cursor", "grok"]);
    }
}
