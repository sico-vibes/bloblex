//! The ACP providers `bloblex-adapter-acp` serves, from one table.
//!
//! OpenCode is not a row here: it has its own discovery path (a stored
//! credential read, a sign-in probe against its background service) and its own
//! launch flags, and its behaviour must not change. A row is a provider that
//! works through the same adapter with nothing provider-specific left to do.
//!
//! Gemini CLI and Qwen Code both take `--acp`. Their own `config.ts` today still
//! accepts `--experimental-acp`, but prints "deprecated ... use --acp instead",
//! so the table names the flag they tell you to use.

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
}

pub const ACP_PROVIDERS: &[AcpProvider] = &[
    AcpProvider {
        provider: "gemini",
        display_name: "Gemini CLI",
        command: "gemini",
        args: &["--acp"],
        sign_in_command: "gemini",
        install_hint: "Install Gemini CLI with npm install -g @google/gemini-cli",
    },
    AcpProvider {
        provider: "qwen",
        display_name: "Qwen Code",
        command: "qwen",
        args: &["--acp"],
        sign_in_command: "qwen",
        install_hint: "Install Qwen Code with npm install -g @qwen-code/qwen-code",
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
pub fn discovery_ids() -> [&'static str; 5] {
    ["claude", "codex", "opencode", ACP_PROVIDERS[0].provider, ACP_PROVIDERS[1].provider]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_names_the_flags_the_clis_ask_you_to_use() {
        assert_eq!(acp_launch_args("gemini"), &["--acp"]);
        assert_eq!(acp_launch_args("qwen"), &["--acp"]);
        // OpenCode keeps the subcommand it has always used.
        assert_eq!(acp_launch_args("opencode"), &["acp"]);
        for row in ACP_PROVIDERS {
            assert!(!row.args.contains(&"acp"), "{} must take a flag, not the subcommand", row.provider);
            assert_eq!(row.args, &["--acp"]);
            assert!(!row.sign_in_command.contains(' '), "the sign-in command is one command, not a shell line");
            assert!(!row.display_name.is_empty() && !row.install_hint.is_empty());
        }
    }

    #[test]
    fn only_opencode_and_the_table_rows_speak_acp() {
        assert!(is_acp_provider("opencode"));
        assert!(is_acp_provider("gemini"));
        assert!(is_acp_provider("qwen"));
        for provider in ["claude", "codex", "", "gemini-cli"] {
            assert!(!is_acp_provider(provider), "{provider}");
            assert!(acp_provider(provider).is_none(), "{provider}");
        }
        assert_eq!(discovery_ids(), ["claude", "codex", "opencode", "gemini", "qwen"]);
    }
}
