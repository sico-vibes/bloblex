//! Native frosted-glass backdrop for the main window (Windows).
//!
//! The owner's Haze look asks for real frosted glass: the desktop behind the
//! window, blurred by the window's own pane rather than by a CSS effect. CSS
//! `backdrop-filter` cannot do that, because WebView2 composites only its own
//! page, so the blur has to come from the OS compositor. On Windows that is DWM
//! acrylic — the system backdrop (`DWMWA_SYSTEMBACKDROP_TYPE`) on Windows 11
//! 22H2 and later, the accent acrylic on Windows 10 1809 and later. The
//! `window-vibrancy` crate picks the right call for the build and says whether
//! it worked; `WebviewWindow::set_effects` swallows that answer, which is why
//! this module calls the crate directly.
//!
//! The main window is already `transparent: true`, so tao has enabled blur
//! behind an empty region and WebView2 paints no background: any page pixel
//! with alpha below one shows the backdrop. The UI decides when the effect is
//! wanted; this module owns the native request, remembers what it applied, and
//! reports honestly when Windows refuses to draw it (transparency effects off,
//! or a build too old for either call). Only the main window may carry an
//! effect: the companion and dictation windows are shaped cut-outs, and an
//! accent behind them would smear the desktop into their art.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::log_shell;

/// The settings file that carries the last request into the next launch.
const BACKDROP_FILE: &str = "backdrop.json";

/// Transparency effects are off, so DWM paints acrylic as a solid colour.
const TRANSPARENCY_OFF_REASON: &str = "Windows transparency effects are off.";
/// Neither acrylic nor blur applied on this build of Windows.
const NO_BACKDROP_REASON: &str = "This version of Windows has no backdrop blur.";
/// Not a Windows build at all.
const UNSUPPORTED_REASON: &str = "Backdrop blur is only built for Windows.";

/// Which native effect the main window currently carries.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Effect {
    None,
    Acrylic,
    Blur,
}

/// What was applied last time, so a repeat request costs nothing.
struct Applied {
    /// Whether the UI last asked for an effect (not whether one applied).
    enabled: bool,
    effect: Effect,
    dark: bool,
}

/// Shared state behind the two backdrop commands.
pub struct BackdropState {
    inner: Mutex<Applied>,
}

impl Default for BackdropState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Applied {
                enabled: false,
                effect: Effect::None,
                dark: false,
            }),
        }
    }
}

/// What the UI is told about the backdrop.
///
/// `active` is true only when an effect is applied *and* Windows transparency
/// effects are on, because DWM silently draws acrylic as a flat colour
/// otherwise. The reason is a plain sentence the UI can show; it never carries
/// anything private.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackdropReport {
    pub effect: &'static str,
    pub active: bool,
    pub transparency_off: bool,
    pub reason: Option<String>,
}

/// The last request, kept for first paint (the window is created visible
/// before any JavaScript runs).
#[derive(Serialize, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct BackdropFile {
    enabled: bool,
    dark: bool,
}

fn effect_name(effect: Effect) -> &'static str {
    match effect {
        Effect::Acrylic => "acrylic",
        Effect::Blur => "blur",
        Effect::None => "none",
    }
}

/// The tint handed to the pre-22H2 acrylic path. The system backdrop ignores it.
#[cfg(windows)]
fn tint_for(dark: bool) -> window_vibrancy::Color {
    if dark {
        (18, 18, 20, 120)
    } else {
        (244, 242, 238, 120)
    }
}

fn report_for(effect: Effect, transparency_off: bool) -> BackdropReport {
    let reason = if effect == Effect::None {
        Some(NO_BACKDROP_REASON.to_string())
    } else if transparency_off {
        Some(TRANSPARENCY_OFF_REASON.to_string())
    } else {
        None
    };
    BackdropReport {
        effect: effect_name(effect),
        active: effect != Effect::None && !transparency_off,
        transparency_off,
        reason,
    }
}

/// The report for an explicit "off" request: no effect, and nothing to explain.
fn disabled_report(transparency_off: bool) -> BackdropReport {
    BackdropReport {
        effect: "none",
        active: false,
        transparency_off,
        reason: None,
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn unsupported_report() -> BackdropReport {
    BackdropReport {
        effect: "none",
        active: false,
        transparency_off: false,
        reason: Some(UNSUPPORTED_REASON.to_string()),
    }
}

fn backdrop_file_bytes(enabled: bool, dark: bool) -> Vec<u8> {
    serde_json::to_vec(&BackdropFile { enabled, dark }).unwrap_or_default()
}

fn read_request(app: &AppHandle) -> Option<BackdropFile> {
    let path = crate::app_data_file(app, BACKDROP_FILE)?;
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Writes the request only when it changed since the last launch.
fn save_request(app: &AppHandle, enabled: bool, dark: bool) {
    if read_request(app) == Some(BackdropFile { enabled, dark }) {
        return;
    }
    let Some(path) = crate::app_data_file(app, BACKDROP_FILE) else { return };
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, backdrop_file_bytes(enabled, dark)).is_err()
        || std::fs::rename(&temp, &path).is_err()
    {
        log_shell("warn", "window backdrop: the request could not be saved");
    }
}

/// Whether Windows will draw acrylic as blur rather than as a flat colour.
///
/// `EnableTransparency` under the Personalize key is 0 when the owner turned
/// transparency effects off. A missing or unreadable value counts as on, which
/// is the Windows default.
#[cfg(windows)]
fn transparency_effects_off() -> bool {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

    let wide = |text: &str| text.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let subkey = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let value = wide("EnableTransparency");
    let mut enabled: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut enabled as *mut u32 as *mut c_void,
            &mut size,
        )
    };
    status == ERROR_SUCCESS && enabled == 0
}

#[cfg(not(windows))]
fn transparency_effects_off() -> bool {
    false
}

#[cfg(windows)]
fn apply_effect(window: &WebviewWindow, dark: bool) -> Effect {
    let tint = Some(tint_for(dark));
    if window_vibrancy::apply_acrylic(window, tint).is_ok() {
        log_shell("info", "window backdrop: acrylic");
        return Effect::Acrylic;
    }
    if window_vibrancy::apply_blur(window, tint).is_ok() {
        log_shell("info", "window backdrop: blur");
        return Effect::Blur;
    }
    log_shell("warn", "window backdrop: none");
    Effect::None
}

#[cfg(not(windows))]
fn apply_effect(_window: &WebviewWindow, _dark: bool) -> Effect {
    Effect::None
}

#[cfg(windows)]
fn clear_effect(window: &WebviewWindow, effect: Effect) {
    match effect {
        Effect::Acrylic => {
            let _ = window_vibrancy::clear_acrylic(window);
        }
        Effect::Blur => {
            let _ = window_vibrancy::clear_blur(window);
        }
        Effect::None => {}
    }
}

#[cfg(not(windows))]
fn clear_effect(_window: &WebviewWindow, _effect: Effect) {}

/// Applies or clears the effect and reports what is now in force.
#[cfg_attr(not(windows), allow(dead_code))]
fn apply_and_report(
    window: &WebviewWindow,
    state: &BackdropState,
    enabled: bool,
    dark: bool,
) -> Result<BackdropReport, String> {
    let mut applied = state
        .inner
        .lock()
        .map_err(|_| "Backdrop state is unavailable.".to_string())?;
    let transparency_off = transparency_effects_off();
    if !enabled {
        clear_effect(window, applied.effect);
        let _ = window.set_theme(None);
        applied.enabled = false;
        applied.effect = Effect::None;
        applied.dark = false;
        drop(applied);
        save_request(window.app_handle(), false, dark);
        return Ok(disabled_report(transparency_off));
    }
    if applied.effect != Effect::None && applied.dark == dark {
        let effect = applied.effect;
        drop(applied);
        return Ok(report_for(effect, transparency_off));
    }
    // The system backdrop follows the window's immersive dark mode attribute,
    // and the accent acrylic needs the previous effect gone first.
    clear_effect(window, applied.effect);
    applied.effect = Effect::None;
    let _ = window.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }));
    let effect = apply_effect(window, dark);
    applied.enabled = true;
    applied.effect = effect;
    applied.dark = dark;
    drop(applied);
    save_request(window.app_handle(), true, dark);
    Ok(report_for(effect, transparency_off))
}

/// Applies or clears the native backdrop of the main window.
///
/// A synchronous command, so it runs on the main thread, which is where window
/// calls belong. Turning the effect off is idempotent and gives the title bar
/// back to the OS theme.
#[tauri::command]
pub fn window_backdrop_apply(
    window: WebviewWindow,
    state: State<'_, BackdropState>,
    enabled: bool,
    dark: bool,
) -> Result<BackdropReport, String> {
    if window.label() != "main" {
        return Err("The frosted backdrop is only available on the main window.".to_string());
    }
    #[cfg(windows)]
    {
        apply_and_report(&window, &state, enabled, dark)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, enabled, dark);
        Ok(unsupported_report())
    }
}

/// The current report, with the transparency setting read again.
///
/// The UI calls this on focus, so a change made in Windows Settings shows up
/// without the owner restarting the app.
#[tauri::command]
pub fn window_backdrop_state(
    window: WebviewWindow,
    state: State<'_, BackdropState>,
) -> Result<BackdropReport, String> {
    if window.label() != "main" {
        return Err("The frosted backdrop is only available on the main window.".to_string());
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        return Ok(unsupported_report());
    }
    #[cfg(windows)]
    {
        let applied = state
            .inner
            .lock()
            .map_err(|_| "Backdrop state is unavailable.".to_string())?;
        let transparency_off = transparency_effects_off();
        let (enabled, effect) = (applied.enabled, applied.effect);
        drop(applied);
        if enabled {
            Ok(report_for(effect, transparency_off))
        } else {
            Ok(disabled_report(transparency_off))
        }
    }
}

/// Applies the saved request before the first frame is composed.
///
/// The window is created visible by `tauri.conf.json`, so JavaScript cannot be
/// what turns the effect on. A missing, unreadable or disabled file does
/// nothing; nothing here panics.
pub fn restore(app: &AppHandle, window: &WebviewWindow) {
    let Some(request) = read_request(app) else { return };
    if !request.enabled || window.label() != "main" {
        return;
    }
    let Some(state) = app.try_state::<BackdropState>() else { return };
    if let Err(error) = apply_and_report(window, &state, true, request.dark) {
        log_shell("warn", &format!("window backdrop: {error}"));
    }
}
