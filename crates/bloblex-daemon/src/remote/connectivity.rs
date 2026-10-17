//! Native Remote connectivity (FIX35 C2): UPnP/IGD port mapping, the Windows
//! firewall rule, the external IP and the CGNAT classification.
//!
//! Native Remote binds the host's own interfaces, so a device outside the
//! network reaches it only when three things line up: the router forwards the
//! port, the Windows firewall allows it, and the address the owner shares is
//! not behind carrier NAT. This module learns and reports each of them.
//!
//! Rules that shape every line (see `AGENTS.md`, the Native Remote amendment):
//!
//! * no third-party service is contacted: the external IP comes from the router
//!   over UPnP or from a value the owner types, never from an IP-echo website;
//! * a port mapping happens only with the owner's consent and removes **only
//!   its own** mapping;
//! * the firewall rule is added only through an elevated prompt the owner
//!   accepts, never silently;
//! * the external IP appears only in the status field, never in a log;
//! * nothing here is fatal: a failure becomes a status the page explains.

use crate::{derr, AppState, DispatchError};
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use super::native;

/// The owner's consent to map the port (`remote.native.upnp`); off by default.
pub const UPNP_SETTING: &str = "remote.native.upnp";
/// The UPnP mapping's description, so it is recognisably Bitbots' own.
pub const MAPPING_DESCRIPTION: &str = "Bitbots Remote";
/// The mapping's lease in seconds; renewed well inside it.
pub const MAPPING_LEASE_SECS: u32 = 3600;
/// How often the lease is renewed.
pub const RENEW_SECS: u64 = 30 * 60;
/// How often the router's external address is re-read.
pub const RECHECK_SECS: u64 = 10 * 60;
/// How long the gateway search may take before Native gives up on it.
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(5);
/// The Windows firewall rule's name. No space: `Start-Process -ArgumentList
/// @(...)` joins its elements with spaces *without* quoting, so a name containing
/// a space reaches `netsh` as two words and the add/delete fails or targets the
/// wrong rule.
pub const FIREWALL_RULE_NAME: &str = "Bitbots-Remote";

/// The UPnP mapping's state (`remote.status.native.upnp.state`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UpnpState {
    /// Consent is off, so nothing was tried.
    #[default]
    Off,
    /// The mapping is in place.
    Mapped,
    /// No UPnP gateway answered.
    NoGateway,
    /// A gateway answered but the mapping failed.
    Failed,
}

impl UpnpState {
    pub fn as_str(self) -> &'static str {
        match self {
            UpnpState::Off => "off",
            UpnpState::Mapped => "mapped",
            UpnpState::NoGateway => "no_gateway",
            UpnpState::Failed => "failed",
        }
    }
}

/// Where the external IP came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalSource {
    Upnp,
    Manual,
}

impl ExternalSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ExternalSource::Upnp => "upnp",
            ExternalSource::Manual => "manual",
        }
    }
}

/// The Windows firewall's view of the rule (`remote.status.native.firewall`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FirewallState {
    #[default]
    Unknown,
    Allowed,
    Missing,
    Unsupported,
}

impl FirewallState {
    pub fn as_str(self) -> &'static str {
        match self {
            FirewallState::Unknown => "unknown",
            FirewallState::Allowed => "allowed",
            FirewallState::Missing => "missing",
            FirewallState::Unsupported => "unsupported",
        }
    }
}

/// A UPnP gateway as this module uses it. A trait so a test needs no router.
#[async_trait::async_trait]
pub trait UpnpGateway: Send + Sync {
    /// The router's public address.
    async fn external_ip(&self) -> Result<IpAddr, String>;
    /// Add or refresh the TCP mapping `external_port` → `local_addr`.
    async fn add_mapping(
        &self,
        external_port: u16,
        local_addr: SocketAddr,
        lease: u32,
        description: &str,
    ) -> Result<(), String>;
    /// Remove the mapping Bitbots added.
    async fn remove_mapping(&self, external_port: u16) -> Result<(), String>;
}

/// Everything connectivity owns, held inside `native::NativeState`.
#[derive(Default)]
pub struct ConnectivityState {
    /// The stored consent (`remote.native.upnp`).
    pub consent: bool,
    pub upnp: UpnpState,
    /// Why the mapping failed, if it did.
    pub upnp_error: Option<String>,
    /// The external port of Bitbots' own mapping, while one is in place.
    pub mapped_port: Option<u16>,
    pub external_ip: Option<IpAddr>,
    pub external_source: Option<ExternalSource>,
    pub cgnat: bool,
    pub cgnat_reason: Option<&'static str>,
    pub firewall: FirewallState,
    /// The live gateway while a mapping is up; not part of the status.
    pub gateway: Option<Arc<dyn UpnpGateway>>,
    /// The periodic renew/re-check task, so disable can stop it.
    pub task: Option<tokio::task::JoinHandle<()>>,
}

/// Test-only seams: a fake gateway and a fixed firewall reading, so no test
/// touches a router, the network or `netsh`.
#[cfg(test)]
#[derive(Default)]
pub struct TestSeams {
    /// When true, discovery returns `gateway` and touches nothing else.
    pub upnp_active: bool,
    pub gateway: Option<Arc<dyn UpnpGateway>>,
    /// When set, `detect_firewall` returns this instead of running `netsh`.
    pub firewall: Option<FirewallState>,
}

// ---------------------------------------------------------------------------
// The real UPnP gateway

/// The real IGD client, over the `igd-next` crate.
struct IgdGateway {
    gateway: igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>,
}

#[async_trait::async_trait]
impl UpnpGateway for IgdGateway {
    async fn external_ip(&self) -> Result<IpAddr, String> {
        self.gateway.get_external_ip().await.map_err(|error| error.to_string())
    }

    async fn add_mapping(
        &self,
        external_port: u16,
        local_addr: SocketAddr,
        lease: u32,
        description: &str,
    ) -> Result<(), String> {
        self.gateway
            .add_port(igd_next::PortMappingProtocol::TCP, external_port, local_addr, lease, description)
            .await
            .map_err(|error| error.to_string())
    }

    async fn remove_mapping(&self, external_port: u16) -> Result<(), String> {
        self.gateway
            .remove_port(igd_next::PortMappingProtocol::TCP, external_port)
            .await
            .map_err(|error| error.to_string())
    }
}

/// Searches for the UPnP gateway, bounded by [`SEARCH_TIMEOUT`]. `None` means
/// there is no gateway to talk to, which is a normal outcome, not an error.
pub async fn real_discover() -> Option<Arc<dyn UpnpGateway>> {
    let mut options = igd_next::SearchOptions::default();
    options.timeout = Some(SEARCH_TIMEOUT);
    options.single_search_timeout = Some(SEARCH_TIMEOUT);
    let found = tokio::time::timeout(SEARCH_TIMEOUT + Duration::from_secs(1), igd_next::aio::tokio::search_gateway(options))
        .await
        .ok()?
        .ok()?;
    Some(Arc::new(IgdGateway { gateway: found }))
}

// ---------------------------------------------------------------------------
// Consent

/// The stored consent, defaulting to off.
pub fn consent(st: &AppState) -> bool {
    st.db
        .settings()
        .ok()
        .and_then(|settings| settings.get(UPNP_SETTING).and_then(Value::as_bool))
        .unwrap_or(false)
}

/// `remote.native.upnp.set`: store the consent and act on it at once when
/// Native is serving.
pub async fn set_consent(st: &AppState, enabled: bool) -> Result<(), DispatchError> {
    st.db
        .set_setting(UPNP_SETTING, &json!(enabled))
        .map_err(|error| derr("internal", &error.to_string(), StatusCode::INTERNAL_SERVER_ERROR))?;
    st.remote.inner.lock().unwrap().native.connectivity.consent = enabled;
    if st.remote.native_listening() {
        if enabled {
            enable(st).await;
        } else {
            disable(st).await;
        }
    }
    super::emit_status(st).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Lifecycle

/// Called when Native turns on. With consent, find the gateway, map the port
/// and read the external IP; then keep the lease alive. Without consent, make
/// sure no mapping of ours is left and report `off`.
pub async fn enable(st: &AppState) {
    let consented = consent(st);
    st.remote.inner.lock().unwrap().native.connectivity.consent = consented;
    if !consented {
        stop_mapping(st).await;
        set_upnp(st, UpnpState::Off, None);
        refresh_firewall(st).await;
        super::emit_status(st).await;
        return;
    }
    let port = native::current_port(st);
    match st.remote.discover_gateway().await {
        Some(gateway) => match add_mapping(st, gateway.clone(), port).await {
            Ok(()) => {
                {
                    let mut inner = st.remote.inner.lock().unwrap();
                    let connectivity = &mut inner.native.connectivity;
                    connectivity.gateway = Some(gateway.clone());
                    connectivity.mapped_port = Some(port);
                }
                set_upnp(st, UpnpState::Mapped, None);
                learn_external_ip(st, &gateway).await;
                spawn_periodic(st);
            }
            Err(error) => set_upnp(st, UpnpState::Failed, Some(error)),
        },
        None => set_upnp(st, UpnpState::NoGateway, None),
    }
    refresh_firewall(st).await;
    super::emit_status(st).await;
}

/// Called when Native turns off or the daemon stops: remove only Bitbots' own
/// mapping and stop the periodic task. The certificate and the external IP stay.
pub async fn disable(st: &AppState) {
    stop_mapping(st).await;
    set_upnp(st, UpnpState::Off, None);
}

async fn stop_mapping(st: &AppState) {
    let (gateway, port, task) = {
        let mut inner = st.remote.inner.lock().unwrap();
        let connectivity = &mut inner.native.connectivity;
        let task = connectivity.task.take();
        (connectivity.gateway.take(), connectivity.mapped_port.take(), task)
    };
    if let Some(task) = task {
        task.abort();
    }
    if let (Some(gateway), Some(port)) = (gateway, port) {
        // Best effort: a router that has forgotten us is not an error.
        let _ = gateway.remove_mapping(port).await;
    }
}

fn set_upnp(st: &AppState, state: UpnpState, error: Option<String>) {
    let mut inner = st.remote.inner.lock().unwrap();
    let connectivity = &mut inner.native.connectivity;
    connectivity.upnp = state;
    connectivity.upnp_error = error;
}

/// This host's LAN IPv4 address: the first non-loopback, non-link-local IPv4
/// interface. `None` when there is none (no mapping can be described then).
pub fn local_ipv4(_st: &AppState) -> Option<Ipv4Addr> {
    let interfaces = if_addrs::get_if_addrs().ok()?;
    interfaces.into_iter().map(|interface| interface.addr.ip()).find_map(|ip| match ip {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => Some(v4),
        _ => None,
    })
}

async fn add_mapping(st: &AppState, gateway: Arc<dyn UpnpGateway>, port: u16) -> Result<(), String> {
    let Some(local) = local_ipv4(st) else {
        return Err("This computer has no network address to map.".to_string());
    };
    let local_addr = SocketAddr::new(IpAddr::V4(local), port);
    gateway
        .add_mapping(port, local_addr, MAPPING_LEASE_SECS, MAPPING_DESCRIPTION)
        .await
}

/// Re-adds the mapping so the lease does not expire. The periodic task calls
/// this; a test calls it directly, because it cannot wait thirty minutes.
pub async fn renew_mapping(st: &AppState) {
    let (gateway, port) = {
        let inner = st.remote.inner.lock().unwrap();
        let connectivity = &inner.native.connectivity;
        (connectivity.gateway.clone(), connectivity.mapped_port)
    };
    let (Some(gateway), Some(port)) = (gateway, port) else { return };
    match add_mapping(st, gateway, port).await {
        Ok(()) => set_upnp(st, UpnpState::Mapped, None),
        Err(error) => set_upnp(st, UpnpState::Failed, Some(error)),
    }
    super::emit_status(st).await;
}

async fn learn_external_ip(st: &AppState, gateway: &Arc<dyn UpnpGateway>) {
    if current_source(st) == Some(ExternalSource::Manual) {
        return;
    }
    if let Ok(ip) = gateway.external_ip().await {
        apply_external_ip(st, Some(ip), Some(ExternalSource::Upnp)).await;
    }
}

/// Re-reads the router's external address. A value the owner typed wins, so
/// this does nothing while the source is `manual`.
pub async fn recheck_external_ip(st: &AppState) {
    if current_source(st) == Some(ExternalSource::Manual) {
        return;
    }
    let gateway = { st.remote.inner.lock().unwrap().native.connectivity.gateway.clone() };
    let Some(gateway) = gateway else { return };
    if let Ok(ip) = gateway.external_ip().await {
        apply_external_ip(st, Some(ip), Some(ExternalSource::Upnp)).await;
    }
}

fn current_source(st: &AppState) -> Option<ExternalSource> {
    st.remote.inner.lock().unwrap().native.connectivity.external_source
}

fn spawn_periodic(st: &AppState) {
    let owned = st.clone();
    let handle = tokio::spawn(async move {
        let mut renew = tokio::time::interval(Duration::from_secs(RENEW_SECS));
        let mut recheck = tokio::time::interval(Duration::from_secs(RECHECK_SECS));
        // The first tick of each interval is immediate; skip it.
        renew.tick().await;
        recheck.tick().await;
        loop {
            tokio::select! {
                _ = renew.tick() => renew_mapping(&owned).await,
                _ = recheck.tick() => recheck_external_ip(&owned).await,
            }
        }
    });
    st.remote.inner.lock().unwrap().native.connectivity.task = Some(handle);
}

// ---------------------------------------------------------------------------
// The external IP and CGNAT

/// `remote.native.externalIp.set`: the owner types an address (or clears it).
pub async fn set_external_ip(st: &AppState, p: &Value) -> Result<Value, DispatchError> {
    let ip = match p.get("ip") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(
            text.trim()
                .parse::<IpAddr>()
                .map_err(|_| derr("invalid_argument", "ip must be an address, or null to clear it", StatusCode::BAD_REQUEST))?,
        ),
        Some(_) => return Err(derr("invalid_argument", "ip must be an address, or null to clear it", StatusCode::BAD_REQUEST)),
    };
    apply_external_ip(st, ip, ip.map(|_| ExternalSource::Manual)).await;
    Ok(native::status_block(st))
}

/// Stores a new external IP (or clears it), updates the status, and asks the
/// certificate to cover the new name. The setting key is C1's
/// `remote.native.externalIp`, so the SAN regeneration sees it.
pub async fn apply_external_ip(st: &AppState, ip: Option<IpAddr>, source: Option<ExternalSource>) {
    let value = ip.map(|ip| json!(ip.to_string())).unwrap_or(Value::Null);
    let _ = st.db.set_setting(native::EXTERNAL_IP_SETTING, &value);
    let (cgnat, reason) = classify(ip);
    let changed = {
        let mut inner = st.remote.inner.lock().unwrap();
        let connectivity = &mut inner.native.connectivity;
        let changed = connectivity.external_ip != ip;
        connectivity.external_ip = ip;
        connectivity.external_source = source;
        connectivity.cgnat = cgnat;
        connectivity.cgnat_reason = reason;
        changed
    };
    if changed && st.remote.native_listening() && native::refresh_cert(st).await.is_err() {
        // Content-free: the address never appears in a log.
        tracing::warn!("the Native certificate could not be refreshed after an address change");
    }
    super::emit_status(st).await;
}

/// The CGNAT / "not reachable" classification: `(cgnat, reason)`. A public
/// address returns `(false, None)`.
pub fn classify(ip: Option<IpAddr>) -> (bool, Option<&'static str>) {
    match ip {
        None => (false, None),
        Some(ip) if is_carrier_grade_nat(ip) => (true, Some("carrier_nat")),
        Some(ip) if !is_public(ip) => (true, Some("private")),
        Some(_) => (false, None),
    }
}

/// Whether an address is one a device elsewhere could plausibly reach. RFC
/// 1918, loopback, link-local, carrier NAT and IPv6 ULA/link-local are not.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || is_carrier_grade_nat_v4(v4))
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            let unique_local = segments[0] & 0xfe00 == 0xfc00;
            let link_local = segments[0] & 0xffc0 == 0xfe80;
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || unique_local || link_local)
        }
    }
}

fn is_carrier_grade_nat(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_carrier_grade_nat_v4(v4),
        IpAddr::V6(_) => false,
    }
}

/// `100.64.0.0/10`, the shared address space a carrier NAT uses.
fn is_carrier_grade_nat_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0xc0) == 64
}

// ---------------------------------------------------------------------------
// The Windows firewall

/// `netsh advfirewall firewall show rule name=…`. `None` means the command did
/// not finish inside the timeout.
#[cfg(not(test))]
async fn show_rule(name: &str) -> Option<String> {
    let args = show_rule_args(name);
    tokio::task::spawn_blocking(move || run_with_timeout("netsh", &args, Duration::from_secs(5)))
        .await
        .ok()
        .flatten()
}

/// The `netsh` arguments that show one rule by name. Passed straight to the
/// process (`Command::args`), so the name is a single argument even with a space.
pub fn show_rule_args(name: &str) -> Vec<String> {
    [
        "advfirewall",
        "firewall",
        "show",
        "rule",
        &format!("name={name}"),
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Runs a command and returns its stdout, killing it after `timeout`.
#[cfg(not(test))]
fn run_with_timeout(program: &str, args: &[String], timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::time::Instant;
    let mut command = std::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let mut text = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut text);
                }
                return Some(text);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// Reads the firewall rule's state. On an OS without `netsh` this is
/// `unsupported`; a test supplies a fixed answer instead of running anything.
#[cfg(test)]
pub async fn detect_firewall(st: &AppState) -> FirewallState {
    st.remote.seams.lock().unwrap().firewall.unwrap_or(FirewallState::Unknown)
}

#[cfg(not(test))]
pub async fn detect_firewall(st: &AppState) -> FirewallState {
    if !cfg!(windows) {
        return FirewallState::Unsupported;
    }
    let output = show_rule(FIREWALL_RULE_NAME).await;
    // `netsh` exits non-zero when no rule matches; an empty answer is Missing.
    let text = output.unwrap_or_default();
    if text.trim().is_empty() {
        return FirewallState::Missing;
    }
    firewall_state_from(true, Some(&text), native::current_port(st))
}

/// The whole detection decision, separated from the process so it can be tested
/// against recorded text on any platform.
pub fn firewall_state_from(is_windows: bool, output: Option<&str>, port: u16) -> FirewallState {
    if !is_windows {
        return FirewallState::Unsupported;
    }
    match output {
        None => FirewallState::Unknown,
        Some(text) => parse_firewall(text, port),
    }
}

/// Parses `netsh advfirewall firewall show rule` output for a rule that allows
/// this port. Recorded text only, so it never depends on the machine.
pub fn parse_firewall(output: &str, port: u16) -> FirewallState {
    let lower = output.to_lowercase();
    if lower.contains("no rules match") {
        return FirewallState::Missing;
    }
    let wanted = port.to_string();
    let allows_port = output.lines().any(|line| {
        let line = line.to_lowercase();
        line.contains("localport")
            && line
                .split_whitespace()
                .any(|word| word.trim_matches(|c: char| !c.is_ascii_digit()) == wanted)
    });
    if allows_port {
        FirewallState::Allowed
    } else {
        FirewallState::Missing
    }
}

/// The `netsh` arguments that add the inbound allow rule for `port`.
pub fn add_rule_args(port: u16) -> Vec<String> {
    [
        "advfirewall",
        "firewall",
        "add",
        "rule",
        &format!("name={FIREWALL_RULE_NAME}"),
        "dir=in",
        "action=allow",
        "protocol=TCP",
        &format!("localport={port}"),
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// The `netsh` arguments that delete the rule by name.
pub fn remove_rule_args() -> Vec<String> {
    ["advfirewall", "firewall", "delete", "rule", &format!("name={FIREWALL_RULE_NAME}")]
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// The exact `powershell` argv that raises the UAC prompt and runs `netsh` with
/// `args`. `Start-Process -Verb RunAs` shows the owner the prompt; `-Wait`
/// waits for the accepted prompt to finish. `-WindowStyle Hidden` keeps the
/// elevated `netsh` from flashing a console.
pub fn elevated_command(args: &[String]) -> Vec<String> {
    let mut list = String::from("Start-Process -FilePath netsh -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @(");
    for (index, arg) in args.iter().enumerate() {
        if index > 0 {
            list.push(',');
        }
        list.push('\'');
        for character in arg.chars() {
            if character == '\'' {
                list.push_str("''");
            } else {
                list.push(character);
            }
        }
        list.push('\'');
    }
    list.push(')');
    vec![
        "powershell".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        list,
    ]
}

async fn run_process(argv: Vec<String>) -> Option<i32> {
    tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&argv[0]);
        command.args(&argv[1..]).stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command.status().ok().and_then(|status| status.code())
    })
    .await
    .ok()
    .flatten()
}

/// `remote.native.firewall.add`: the elevated prompt, then a fresh reading.
/// `added | declined | failed` (or `unsupported` off Windows).
pub async fn add_rule(st: &AppState) -> &'static str {
    if !cfg!(windows) {
        return "unsupported";
    }
    let argv = elevated_command(&add_rule_args(native::current_port(st)));
    let status = run_process(argv).await;
    refresh_firewall(st).await;
    if firewall_state(st) == FirewallState::Allowed {
        "added"
    } else if status == Some(0) {
        "failed"
    } else {
        "declined"
    }
}

/// `remote.native.firewall.remove`: the elevated prompt, then a fresh reading.
/// `removed | declined | failed` (or `unsupported` off Windows). A rule that is
/// already gone is not an error, so the outcome is read from the status
/// afterwards.
pub async fn remove_rule(st: &AppState) -> &'static str {
    if !cfg!(windows) {
        return "unsupported";
    }
    let argv = elevated_command(&remove_rule_args());
    let any_ran = run_process(argv).await == Some(0);
    refresh_firewall(st).await;
    if firewall_state(st) == FirewallState::Missing {
        "removed"
    } else if any_ran {
        "failed"
    } else {
        "declined"
    }
}

/// Records the firewall rule's current state in the status.
pub async fn refresh_firewall(st: &AppState) {
    let state = detect_firewall(st).await;
    st.remote.inner.lock().unwrap().native.connectivity.firewall = state;
}

/// The firewall reading held in the status.
pub fn firewall_state(st: &AppState) -> FirewallState {
    st.remote.inner.lock().unwrap().native.connectivity.firewall
}
