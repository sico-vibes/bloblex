//! Tailscale control for the remote gateway (FIX29 WP6b).
//!
//! Two rules shape this module:
//!
//! * **Tests never run the real `tailscale` binary.** Every CLI call goes
//!   through [`TailscaleCli`]; production uses [`RealTailscale`], tests use a
//!   fake that records its argv.
//! * **Bitbots never runs `tailscale funnel` and never runs
//!   `tailscale serve reset`.** Those would expose the gateway to the open
//!   internet or delete handlers the user set up for other services
//!   (`docs/remote/THREAT_MODEL.md`, T30 and T31). The gateway adds and removes
//!   only its own handler.
//!
//! `tailscale status --json` is parsed, never logged: it carries the tailnet
//! login, the owner's email address and every device name.

use serde_json::Value;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long one CLI call may take before it is killed.
pub const CLI_TIMEOUT: Duration = Duration::from_secs(5);

/// The port `tailscale serve` publishes first, then the fallback.
pub const PRIMARY_SERVE_PORT: u16 = 443;
pub const FALLBACK_SERVE_PORT: u16 = 8443;

/// Where the gateway must reach Bitbots on loopback.
pub fn target_for(remote_port: u16) -> String {
    format!("http://127.0.0.1:{remote_port}")
}

// ---------------------------------------------------------------------------
// The CLI seam

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CliOutput {
    /// True when the process exited with status 0.
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// One way to run `tailscale`. Production uses [`RealTailscale`]; tests use a
/// fake. There is deliberately no "run a shell" escape hatch.
pub trait TailscaleCli: Send + Sync + 'static {
    /// Run `tailscale <args>` and collect its output. `Err` means the process
    /// could not be started or did not finish within [`CLI_TIMEOUT`].
    fn run(&self, args: &[&str]) -> Result<CliOutput, String>;
}

/// The real binary: `std::process::Command`, no shell, a 5 s timeout and
/// `CREATE_NO_WINDOW` on Windows.
pub struct RealTailscale {    exe: PathBuf,
}

impl RealTailscale {
    /// `None` when no `tailscale.exe` is installed.
    pub fn discover() -> Option<Self> {
        find_tailscale().map(|exe| Self { exe })
    }

}

/// Used when no `tailscale.exe` exists: every call fails, so the state is
/// `not_installed` rather than a guess.
pub struct MissingCli;

impl TailscaleCli for MissingCli {
    fn run(&self, _args: &[&str]) -> Result<CliOutput, String> {
        Err("Tailscale is not installed on this computer.".to_string())
    }
}

/// PATH first, then the default Windows install location.
pub fn find_tailscale() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("tailscale.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let candidate = PathBuf::from(program_files).join("Tailscale").join("tailscale.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

impl TailscaleCli for RealTailscale {
    fn run(&self, args: &[&str]) -> Result<CliOutput, String> {
        let mut command = Command::new(&self.exe);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        // Read both pipes on their own threads: a full pipe buffer would
        // otherwise block the child and turn a slow answer into a timeout.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_reader = std::thread::spawn(move || read_pipe(stdout));
        let stderr_reader = std::thread::spawn(move || read_pipe(stderr));

        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() >= CLI_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error.to_string());
                }
            }
        };
        let stdout = stdout_reader.join().unwrap_or_default();
        let stderr = stderr_reader.join().unwrap_or_default();
        match status {
            Some(status) => Ok(CliOutput {
                success: status.success(),
                stdout,
                stderr,
            }),
            None => Err("tailscale did not answer within 5 seconds".to_string()),
        }
    }
}

fn read_pipe(pipe: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_string(&mut text);
    }
    text
}

// ---------------------------------------------------------------------------
// State

/// What the status chip shows. The wire spelling is used verbatim.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TailscaleState {
    NotInstalled,
    LoggedOut,
    Starting,
    NotRunning,
    HttpsDisabled,
    PortInUse,
    FunnelOn,
    Ready,
}

impl TailscaleState {
    pub fn as_str(self) -> &'static str {
        match self {
            TailscaleState::NotInstalled => "not_installed",
            TailscaleState::LoggedOut => "logged_out",
            TailscaleState::Starting => "starting",
            TailscaleState::NotRunning => "not_running",
            TailscaleState::HttpsDisabled => "https_disabled",
            TailscaleState::PortInUse => "port_in_use",
            TailscaleState::FunnelOn => "funnel_on",
            TailscaleState::Ready => "ready",
        }
    }
}

/// The parse of `tailscale status --json`. `funnel_on` is filled from
/// `serve status --json`, because the node status does not carry it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TailscaleStatus {
    pub backend_state: String,
    /// The MagicDNS name with its trailing dot removed.
    pub dns_name: Option<String>,
    pub cert_domains: Vec<String>,
    pub login_name: Option<String>,
    pub funnel_on: bool,
}

impl TailscaleStatus {
    pub fn is_running(&self) -> bool {
        self.backend_state == "Running"
    }

    /// The serve origin, for example `https://work-pc.example-tailnet.ts.net`.
    /// Port 8443 is carried explicitly; 443 is not.
    pub fn origin(&self, serve_port: u16) -> Option<String> {
        let dns = self.dns_name.as_deref()?;
        if serve_port == PRIMARY_SERVE_PORT {
            Some(format!("https://{dns}"))
        } else {
            Some(format!("https://{dns}:{serve_port}"))
        }
    }
}

/// The parse of `tailscale serve status --json`: which ports carry a handler
/// and which of those are ours.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServeStatus {
    /// Ports with any HTTPS handler.
    pub https_ports: BTreeSet<u16>,
    /// Ports whose `/` handler already proxies to our own loopback target.
    pub our_ports: BTreeSet<u16>,
    /// Ports with Funnel allowed.
    pub funnel_ports: BTreeSet<u16>,
}

impl ServeStatus {
    /// A port is "taken" only when someone else already serves HTTPS there.
    pub fn taken_by_other(&self, port: u16) -> bool {
        self.https_ports.contains(&port) && !self.our_ports.contains(&port)
    }

    /// True when Funnel is on for any port Bitbots would use.
    pub fn funnel_on(&self) -> bool {
        self.funnel_ports
            .iter()
            .any(|port| *port == PRIMARY_SERVE_PORT || *port == FALLBACK_SERVE_PORT)
    }
}

/// What a full probe found.
#[derive(Clone, Debug)]
pub enum Probe {
    Ready {
        status: TailscaleStatus,
        serve_port: u16,
    },
    Unavailable {
        state: TailscaleState,
        message: String,
    },
}

/// Ask Tailscale for its state and its serve handlers, then decide whether
/// Bitbots may start.
pub fn probe(cli: &dyn TailscaleCli, target: &str) -> Probe {
    let status_output = match cli.run(&["status", "--json"]) {
        Ok(output) => output,
        Err(message) => {
            return Probe::Unavailable {
                state: TailscaleState::NotInstalled,
                message,
            }
        }
    };
    if !status_output.success {
        // Some CLI versions return non-zero while still providing a useful
        // BackendState. Preserve sign-in/starting advice in that case.
        if let Ok(status) = parse_status_json(&status_output.stdout) {
            if !status.backend_state.is_empty() && !status.is_running() {
                return evaluate(&status, &ServeStatus::default());
            }
        }
        // Never echo stderr (it may include account or machine information).
        // A failed service connection or permission error is not a sign-out.
        return Probe::Unavailable {
            state: TailscaleState::NotRunning,
            message: "Bitbots could not reach the Tailscale service. Open Tailscale on this computer, then check again.".to_string(),
        };
    }
    let mut status = match parse_status_json(&status_output.stdout) {
        Ok(status) => status,
        Err(_) => {
            return Probe::Unavailable {
                state: TailscaleState::NotRunning,
                message: "Tailscale did not return a status Bitbots can read.".to_string(),
            }
        }
    };
    let serve = match cli.run(&["serve", "status", "--json"]) {
        Ok(output) if output.success => parse_serve_status_json(&output.stdout, target).unwrap_or_default(),
        // A node with no serve configuration answers `{}` or an empty body.
        _ => ServeStatus::default(),
    };
    status.funnel_on = serve.funnel_on();
    evaluate(&status, &serve)
}

/// Map a parsed status onto the state the UI shows.
pub fn evaluate(status: &TailscaleStatus, serve: &ServeStatus) -> Probe {
    if !status.is_running() {
        let (state, message) = match status.backend_state.as_str() {
            "Starting" | "NoState" => (TailscaleState::Starting, "Tailscale is starting. Wait a moment, then check again."),
            "NeedsLogin" => (TailscaleState::LoggedOut, "Tailscale is signed out. Open Tailscale and sign in."),
            _ => (TailscaleState::NotRunning, "Tailscale is not running. Open Tailscale on this computer, then check again."),
        };
        return Probe::Unavailable { state, message: message.to_string() };
    }
    if status.cert_domains.is_empty() || status.dns_name.as_deref().is_none_or(str::is_empty) {
        return Probe::Unavailable {
            state: TailscaleState::HttpsDisabled,
            message: "HTTPS certificates are turned off for this tailnet. Turn them on in the Tailscale admin console, then try again.".to_string(),
        };
    }
    if status.funnel_on {
        return Probe::Unavailable {
            state: TailscaleState::FunnelOn,
            message: "Funnel is on for a port Bitbots needs. Turn Funnel off in Tailscale, then try again.".to_string(),
        };
    }
    match choose_serve_port(serve) {
        Some(serve_port) => Probe::Ready {
            status: status.clone(),
            serve_port,
        },
        None => Probe::Unavailable {
            state: TailscaleState::PortInUse,
            message: "Tailscale is already serving HTTPS on 443 and 8443. Bitbots will not replace another service.".to_string(),
        },
    }
}

/// 443 when free or already ours, else 8443, else none.
pub fn choose_serve_port(serve: &ServeStatus) -> Option<u16> {
    if !serve.taken_by_other(PRIMARY_SERVE_PORT) {
        return Some(PRIMARY_SERVE_PORT);
    }
    if !serve.taken_by_other(FALLBACK_SERVE_PORT) {
        return Some(FALLBACK_SERVE_PORT);
    }
    None
}

// ---------------------------------------------------------------------------
// Parsing

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Parse `tailscale status --json`.
pub fn parse_status_json(text: &str) -> Result<TailscaleStatus, String> {
    let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    if !value.is_object() {
        return Err("status is not an object".to_string());
    }
    let dns_name = string_field(&value, "DNSName")
        .or_else(|| value.get("Self").and_then(|self_node| string_field(self_node, "DNSName")))
        .map(|name| name.trim_end_matches('.').to_string());
    let cert_domains = value
        .get("CertDomains")
        .or_else(|| value.get("Self").and_then(|self_node| self_node.get("CertDomains")))
        .and_then(Value::as_array)
        .map(|domains| domains.iter().filter_map(Value::as_str).map(|domain| domain.trim_end_matches('.').to_string()).collect())
        .unwrap_or_default();
    let login_name = value
        .get("User")
        .and_then(|user| {
            if let Some(id) = value.get("Self").and_then(|self_node| self_node.get("UserID")).and_then(Value::as_u64) {
                user.get(id.to_string()).and_then(|entry| string_field(entry, "LoginName"))
            } else {
                None
            }
        })
        .or_else(|| value.get("Self").and_then(|self_node| string_field(self_node, "LoginName")));
    Ok(TailscaleStatus {
        backend_state: string_field(&value, "BackendState").unwrap_or_default(),
        dns_name,
        cert_domains,
        login_name,
        funnel_on: false,
    })
}

/// Parse `tailscale serve status --json`. `target` is our own proxy target,
/// for example `http://127.0.0.1:48620`.
pub fn parse_serve_status_json(text: &str, target: &str) -> Result<ServeStatus, String> {
    let value: Value = serde_json::from_str(text.trim()).map_err(|error| error.to_string())?;
    let mut serve = ServeStatus::default();
    if let Some(tcp) = value.get("TCP").and_then(Value::as_object) {
        for (port, config) in tcp {
            if let Ok(port) = port.parse::<u16>() {
                if config.get("HTTPS").and_then(Value::as_bool).unwrap_or(false) {
                    serve.https_ports.insert(port);
                }
            }
        }
    }
    if let Some(web) = value.get("Web").and_then(Value::as_object) {
        for (host_port, config) in web {
            let Some(port) = port_of_host_key(host_port) else { continue };
            serve.https_ports.insert(port);
            let proxies = config
                .get("Handlers")
                .and_then(Value::as_object)
                .map(|handlers| {
                    handlers
                        .values()
                        .filter_map(|handler| handler.get("Proxy").and_then(Value::as_str))
                        .any(|proxy| normalize_target(proxy) == normalize_target(target))
                })
                .unwrap_or(false);
            if proxies {
                serve.our_ports.insert(port);
            }
        }
    }
    if let Some(funnel) = value.get("AllowFunnel").and_then(Value::as_object) {
        for (host_port, allowed) in funnel {
            if allowed.as_bool().unwrap_or(false) {
                if let Some(port) = port_of_host_key(host_port) {
                    serve.funnel_ports.insert(port);
                }
            }
        }
    }
    Ok(serve)
}

/// `host.tailnet.ts.net:443`, `:443` and a bare `443` all yield 443.
fn port_of_host_key(key: &str) -> Option<u16> {
    let port = key.rsplit(':').next().unwrap_or(key);
    port.parse::<u16>().ok()
}

fn normalize_target(target: &str) -> String {
    target.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Whether a failed `tailscale serve --https=<port> off` really means there was
/// nothing to remove. The installed CLI answers
/// `error: failed to remove web serve: handler does not exist` when the port
/// carries no handler, which is the outcome we wanted, not a failure.
pub fn serve_already_absent(output: &CliOutput) -> bool {
    let text = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    text.contains("handler does not exist") || text.contains("no serve config")
}

// ---------------------------------------------------------------------------
// The exact argv Bitbots issues. Nothing else is ever run.

/// `tailscale serve --bg --https=<port> http://127.0.0.1:<remote_port>`
pub fn serve_on_args(serve_port: u16, remote_port: u16) -> Vec<String> {
    vec![
        "serve".to_string(),
        "--bg".to_string(),
        format!("--https={serve_port}"),
        target_for(remote_port),
    ]
}

/// `tailscale serve --https=<port> off` — removes only our handler on that
/// port. Never `serve reset`, which would remove the user's other handlers.
///
/// Tailscale 1.104 accepts this form even though `serve --help` no longer lists
/// the `off` token (it lists only `status`, `reset`, `drain`, `clear`, ...), so
/// the gateway runs it and reads the result rather than gating on the help text.
pub fn serve_off_args(serve_port: u16) -> Vec<String> {
    vec!["serve".to_string(), format!("--https={serve_port}"), "off".to_string()]
}

/// The argv as `&str` slices, for [`TailscaleCli::run`].
pub fn argv(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

/// Runs one argv, refusing anything on the forbidden list first. The invariant
/// is executable, not just documented.
pub fn run_checked(cli: &dyn TailscaleCli, args: &[String]) -> Result<CliOutput, String> {
    let argv = argv(args);
    if is_forbidden_argv(&argv) {
        return Err("Bitbots never runs that Tailscale command.".to_string());
    }
    cli.run(&argv)
}

/// True when an argv is one Bitbots must never issue.
pub fn is_forbidden_argv(args: &[&str]) -> bool {
    if args.first() == Some(&"funnel") {
        return true;
    }
    args.first() == Some(&"serve") && args.get(1) == Some(&"reset")
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Records every argv; answers with canned output. No process is started.
    pub struct FakeCli {
        pub calls: StdMutex<Vec<Vec<String>>>,
        pub status_json: StdMutex<String>,
        pub serve_json: StdMutex<String>,
        pub help_text: StdMutex<String>,
        pub serve_ok: StdMutex<bool>,
    }

    impl FakeCli {
        pub fn new(status_json: &str, serve_json: &str) -> Self {
            Self {
                calls: StdMutex::new(Vec::new()),
                status_json: StdMutex::new(status_json.to_string()),
                serve_json: StdMutex::new(serve_json.to_string()),
                help_text: StdMutex::new("Usage: tailscale serve [flags] <target> [off]\n".to_string()),
                serve_ok: StdMutex::new(true),
            }
        }

        pub fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl TailscaleCli for FakeCli {
        fn run(&self, args: &[&str]) -> Result<CliOutput, String> {
            self.calls.lock().unwrap().push(args.iter().map(|arg| (*arg).to_string()).collect());
            match args.first().copied() {
                Some("status") => Ok(CliOutput {
                    success: true,
                    stdout: self.status_json.lock().unwrap().clone(),
                    stderr: String::new(),
                }),
                Some("serve") if args.get(1) == Some(&"--help") => Ok(CliOutput {
                    success: true,
                    stdout: self.help_text.lock().unwrap().clone(),
                    stderr: String::new(),
                }),
                Some("serve") if args.get(1) == Some(&"status") => Ok(CliOutput {
                    success: true,
                    stdout: self.serve_json.lock().unwrap().clone(),
                    stderr: String::new(),
                }),
                Some(_) => {
                    let ok = *self.serve_ok.lock().unwrap();
                    Ok(CliOutput {
                        success: ok,
                        stdout: String::new(),
                        stderr: if ok { String::new() } else { "error: refused".to_string() },
                    })
                }
                None => Err("no args".to_string()),
            }
        }
    }

    pub const RUNNING_STATUS: &str = r#"{
        "BackendState": "Running",
        "DNSName": "work-pc.example-tailnet.ts.net.",
        "CertDomains": ["work-pc.example-tailnet.ts.net"],
        "Self": {"DNSName": "work-pc.example-tailnet.ts.net.", "UserID": 7},
        "User": {"7": {"LoginName": "sam@example.com"}}
    }"#;

    pub const EMPTY_SERVE: &str = r#"{"TCP":{},"Web":{},"AllowFunnel":{}}"#;

    fn ready_status() -> TailscaleStatus {
        parse_status_json(RUNNING_STATUS).unwrap()
    }

    #[test]
    fn fix39_starting_and_stopped_are_not_logged_out() {
        for (backend, expected) in [("Starting", "starting"), ("NoState", "starting"), ("Stopped", "not_running"), ("NeedsLogin", "logged_out")] {
            let status = parse_status_json(&format!(r#"{{"BackendState":"{backend}"}}"#)).unwrap();
            match evaluate(&status, &ServeStatus::default()) {
                Probe::Unavailable { state, .. } => assert_eq!(state.as_str(), expected),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn fix39_nonzero_status_keeps_a_reported_login_state() {
        struct SignedOut;
        impl TailscaleCli for SignedOut {
            fn run(&self, _: &[&str]) -> Result<CliOutput, String> {
                Ok(CliOutput { success: false, stdout: r#"{"BackendState":"NeedsLogin"}"#.to_string(), stderr: String::new() })
            }
        }
        match probe(&SignedOut, "http://127.0.0.1:48620") {
            Probe::Unavailable { state, .. } => assert_eq!(state.as_str(), "logged_out"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn fix39_daemon_connection_failure_is_not_running() {
        struct Stopped;
        impl TailscaleCli for Stopped {
            fn run(&self, _: &[&str]) -> Result<CliOutput, String> {
                Ok(CliOutput { success: false, stdout: String::new(), stderr: "failed to connect to local tailscaled".to_string() })
            }
        }
        match probe(&Stopped, "http://127.0.0.1:48620") {
            Probe::Unavailable { state, .. } => assert_eq!(state.as_str(), "not_running"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_a_running_node_and_drops_the_trailing_dot() {
        let status = ready_status();
        assert_eq!(status.backend_state, "Running");
        assert_eq!(status.dns_name.as_deref(), Some("work-pc.example-tailnet.ts.net"));
        assert_eq!(status.cert_domains, vec!["work-pc.example-tailnet.ts.net"]);
        assert_eq!(status.login_name.as_deref(), Some("sam@example.com"));
        assert!(status.is_running());
    }

    #[test]
    fn reads_cert_domains_from_the_self_node_when_absent_at_the_top() {
        let status = parse_status_json(
            r#"{"BackendState":"Running","Self":{"DNSName":"a.ts.net.","CertDomains":["a.ts.net"],"LoginName":"a@b.c"}}"#,
        )
        .unwrap();
        assert_eq!(status.dns_name.as_deref(), Some("a.ts.net"));
        assert_eq!(status.cert_domains, vec!["a.ts.net"]);
        assert_eq!(status.login_name.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn a_logged_out_node_is_not_ready() {
        let status = parse_status_json(r#"{"BackendState":"NeedsLogin","DNSName":"a.ts.net."}"#).unwrap();
        assert!(!status.is_running());
        match evaluate(&status, &ServeStatus::default()) {
            Probe::Unavailable { state, .. } => assert_eq!(state, TailscaleState::LoggedOut),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_cert_domains_means_https_is_off() {
        let status = parse_status_json(r#"{"BackendState":"Running","DNSName":"a.ts.net.","CertDomains":[]}"#).unwrap();
        match evaluate(&status, &ServeStatus::default()) {
            Probe::Unavailable { state, .. } => assert_eq!(state, TailscaleState::HttpsDisabled),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn funnel_on_refuses_to_start() {
        let serve = parse_serve_status_json(
            r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"a.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:48620"}}}},"AllowFunnel":{"a.ts.net:443":true}}"#,
            "http://127.0.0.1:48620",
        )
        .unwrap();
        assert!(serve.funnel_on());
        let mut status = ready_status();
        status.funnel_on = serve.funnel_on();
        match evaluate(&status, &serve) {
            Probe::Unavailable { state, .. } => assert_eq!(state, TailscaleState::FunnelOn),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_foreign_handler_on_443_falls_back_to_8443() {
        let serve = parse_serve_status_json(
            r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"a.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}},"AllowFunnel":{}}"#,
            "http://127.0.0.1:48620",
        )
        .unwrap();
        assert!(serve.taken_by_other(443));
        assert_eq!(choose_serve_port(&serve), Some(8443));
        match probe(&FakeCli::new(RUNNING_STATUS, r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"a.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#), "http://127.0.0.1:48620") {
            Probe::Ready { serve_port, status } => {
                assert_eq!(serve_port, 8443);
                assert_eq!(status.origin(8443).as_deref(), Some("https://work-pc.example-tailnet.ts.net:8443"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn our_own_handler_on_443_is_not_taken() {
        let serve = parse_serve_status_json(
            r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"a.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:48620/"}}}}}"#,
            "http://127.0.0.1:48620",
        )
        .unwrap();
        assert!(!serve.taken_by_other(443));
        assert_eq!(choose_serve_port(&serve), Some(443));
    }

    #[test]
    fn both_ports_taken_reports_port_in_use() {
        let serve = parse_serve_status_json(
            r#"{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true}},"Web":{"a.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}},"a.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3001"}}}}}"#,
            "http://127.0.0.1:48620",
        )
        .unwrap();
        assert_eq!(choose_serve_port(&serve), None);
        match evaluate(&ready_status(), &serve) {
            Probe::Unavailable { state, .. } => assert_eq!(state, TailscaleState::PortInUse),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_empty_serve_config_has_no_handlers() {
        assert_eq!(parse_serve_status_json("{}", "http://127.0.0.1:48620").unwrap(), ServeStatus::default());
        assert_eq!(parse_serve_status_json(EMPTY_SERVE, "http://127.0.0.1:48620").unwrap(), ServeStatus::default());
    }

    #[test]
    fn the_argv_matches_the_documented_cli_and_never_forbidden() {
        assert_eq!(serve_on_args(443, 48620), vec!["serve", "--bg", "--https=443", "http://127.0.0.1:48620"]);
        assert_eq!(serve_off_args(8443), vec!["serve", "--https=8443", "off"]);
        for args in [serve_on_args(443, 48620), serve_off_args(443)] {
            let argv = argv(&args);
            assert!(!is_forbidden_argv(&argv), "{argv:?}");
        }
        assert!(is_forbidden_argv(&["funnel", "--bg", "443"]));
        assert!(is_forbidden_argv(&["serve", "reset"]));
    }

    #[test]
    fn enable_and_disable_issue_only_safe_argv() {
        let fake = FakeCli::new(RUNNING_STATUS, EMPTY_SERVE);
        let target = target_for(48620);
        match probe(&fake, &target) {
            Probe::Ready { serve_port, .. } => {
                let on_args = serve_on_args(serve_port, 48620);
                assert!(!is_forbidden_argv(&argv(&on_args)));
                assert!(run_checked(&fake, &on_args).unwrap().success);
                let off_args = serve_off_args(serve_port);
                assert!(!is_forbidden_argv(&argv(&off_args)));
                assert!(run_checked(&fake, &off_args).unwrap().success);
            }
            other => panic!("{other:?}"),
        }
        for call in fake.calls() {
            let argv: Vec<&str> = call.iter().map(String::as_str).collect();
            assert!(!is_forbidden_argv(&argv), "{argv:?}");
        }
    }

    #[test]
    fn run_checked_refuses_the_two_forbidden_commands() {
        let fake = FakeCli::new(RUNNING_STATUS, EMPTY_SERVE);
        assert!(run_checked(&fake, &["funnel".to_string(), "443".to_string()]).is_err());
        assert!(run_checked(&fake, &["serve".to_string(), "reset".to_string()]).is_err());
        assert!(fake.calls().is_empty(), "a forbidden command must never reach the CLI");
    }

    #[test]
    fn a_failed_serve_enable_leaves_no_forbidden_argv() {
        let fake = FakeCli::new(RUNNING_STATUS, EMPTY_SERVE);
        *fake.serve_ok.lock().unwrap() = false;
        let on_args = serve_on_args(443, 48620);
        let output = run_checked(&fake, &on_args).unwrap();
        assert!(!output.success);
        for call in fake.calls() {
            let argv: Vec<&str> = call.iter().map(String::as_str).collect();
            assert!(!is_forbidden_argv(&argv), "{argv:?}");
        }
    }

    #[test]
    fn a_missing_handler_is_not_a_removal_failure() {
        // The installed CLI (1.104.1) answers this when the port is free; the
        // off command was still accepted, so turning Remote off is complete.
        let absent = CliOutput {
            success: false,
            stdout: String::new(),
            stderr: "error: failed to remove web serve: handler does not exist".to_string(),
        };
        assert!(serve_already_absent(&absent));
        // A genuine refusal still warns.
        let refused = CliOutput {
            success: false,
            stdout: String::new(),
            stderr: "error: access denied".to_string(),
        };
        assert!(!serve_already_absent(&refused));
        // A success is never treated as "already absent".
        assert!(!serve_already_absent(&CliOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        }));
    }

    #[test]
    fn help_without_the_off_token_does_not_stop_removal() {
        // Tailscale 1.104 lists only status/reset/drain/clear in `serve --help`
        // yet still accepts `--https=<port> off`; the removal must not be gated
        // on the help text. The exact help output of the installed CLI:
        let fake = FakeCli::new(RUNNING_STATUS, EMPTY_SERVE);
        *fake.help_text.lock().unwrap() =
            "USAGE\n  tailscale serve <target>\n  tailscale serve status [--json]\n  tailscale serve reset\n".to_string();
        // The off argv is still what Bitbots issues and the fake accepts.
        let off_args = serve_off_args(443);
        assert_eq!(off_args, vec!["serve", "--https=443", "off"]);
        assert!(!is_forbidden_argv(&argv(&off_args)));
        assert!(run_checked(&fake, &off_args).unwrap().success);
    }
}
