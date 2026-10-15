//! Keeps Windows awake while Bitbots has work, without fighting the user.
//!
//! The UI decides when a keep-awake request is wanted and calls
//! [`set_keep_awake`]; this module owns the native request. The Windows
//! execution state is per-thread, so a single dedicated thread holds
//! `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` and stays parked until the request is
//! released; the display is deliberately left free to sleep. Nothing here stops
//! the user from putting the computer to sleep themselves (closing the lid,
//! Start menu, power button): it only asks the idle sleep timer not to fire
//! while Bitbots is working.

use std::sync::{Arc, Mutex};

use tauri::State;

/// One platform call that holds or releases the keep-awake request.
///
/// The pure lifecycle in [`KeepAwake`] is written against this trait so it can
/// be unit-tested with a recording fake instead of touching the real OS.
pub trait PowerBackend: Send + Sync {
    fn set(&self, enabled: bool) -> Result<(), String>;
}

/// Tracks whether a keep-awake request is held and drives the backend.
pub struct KeepAwake {
    backend: Arc<dyn PowerBackend>,
    enabled: Mutex<bool>,
}

impl KeepAwake {
    pub fn new(backend: Arc<dyn PowerBackend>) -> Self {
        Self {
            backend,
            enabled: Mutex::new(false),
        }
    }

    /// Enables or disables the request and reports the state now in force.
    /// Enabling while already enabled and disabling while already disabled are
    /// no-ops. A backend failure is reported without changing the state.
    pub fn set(&self, enabled: bool) -> Result<bool, String> {
        let mut state = self
            .enabled
            .lock()
            .map_err(|_| "Keep-awake state is unavailable.".to_string())?;
        if *state == enabled {
            return Ok(*state);
        }
        self.backend.set(enabled)?;
        *state = enabled;
        Ok(*state)
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.lock().map(|state| *state).unwrap_or(false)
    }

    /// Releases the request if one is held. Used on application exit; the OS
    /// also drops the per-thread request when the worker thread dies.
    pub fn release(&self) {
        let _ = self.set(false);
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        let _ = self.set(false);
    }
}

/// The managed Tauri state: one keep-awake owner for the whole app.
pub struct PowerState {
    keeper: KeepAwake,
}

impl Default for PowerState {
    fn default() -> Self {
        Self {
            keeper: KeepAwake::new(default_backend()),
        }
    }
}

impl PowerState {
    fn set(&self, enabled: bool) -> Result<bool, String> {
        self.keeper.set(enabled)
    }

    fn is_enabled(&self) -> bool {
        self.keeper.is_enabled()
    }

    /// Releases any held request when the application is exiting.
    pub fn release(&self) {
        self.keeper.release();
    }
}

/// Holds or releases the keep-awake request and returns the state in force.
#[tauri::command]
pub fn set_keep_awake(state: State<'_, PowerState>, enabled: bool) -> Result<bool, String> {
    state.set(enabled)
}

/// Reports whether Bitbots currently holds a keep-awake request.
#[tauri::command]
pub fn keep_awake_state(state: State<'_, PowerState>) -> bool {
    state.is_enabled()
}

#[cfg(windows)]
fn default_backend() -> Arc<dyn PowerBackend> {
    Arc::new(Win32Power::default())
}

#[cfg(not(windows))]
fn default_backend() -> Arc<dyn PowerBackend> {
    Arc::new(NoopPower)
}

/// Non-Windows builds have no native request to hold; the flag is still
/// tracked so the command surface behaves identically.
#[cfg(not(windows))]
struct NoopPower;

#[cfg(not(windows))]
impl PowerBackend for NoopPower {
    fn set(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(flags: u32) -> u32;
}

#[cfg(windows)]
const ES_CONTINUOUS: u32 = 0x8000_0000;
#[cfg(windows)]
const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

/// The real Windows backend. The execution state belongs to the thread that
/// set it, so enabling starts a dedicated thread that parks until released.
#[cfg(windows)]
#[derive(Default)]
struct Win32Power {
    parked: Mutex<Option<Parked>>,
}

#[cfg(windows)]
struct Parked {
    commands: Sender<Command>,
    join: Option<JoinHandle<()>>,
}

#[cfg(windows)]
enum Command {
    Release(Sender<Result<(), String>>),
}

#[cfg(windows)]
impl PowerBackend for Win32Power {
    fn set(&self, enabled: bool) -> Result<(), String> {
        let mut parked = self
            .parked
            .lock()
            .map_err(|_| "Keep-awake state is unavailable.".to_string())?;
        if enabled {
            if parked.is_some() {
                return Ok(());
            }
            let (commands, receiver) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::channel();
            let join = thread::Builder::new()
                .name("bloblex-keep-awake".to_string())
                .spawn(move || run_keep_awake(receiver, ready_tx))
                .map_err(|error| format!("Could not start the keep-awake thread: {error}"))?;
            match ready_rx.recv() {
                Ok(Ok(())) => {
                    *parked = Some(Parked {
                        commands,
                        join: Some(join),
                    });
                    Ok(())
                }
                Ok(Err(error)) => {
                    let _ = join.join();
                    Err(error)
                }
                Err(_) => {
                    let _ = join.join();
                    Err("The keep-awake thread stopped before it started.".to_string())
                }
            }
        } else {
            if let Some(held) = parked.take() {
                let (done_tx, done_rx) = mpsc::channel();
                if held.commands.send(Command::Release(done_tx)).is_ok() {
                    let _ = done_rx.recv();
                }
                if let Some(join) = held.join {
                    let _ = join.join();
                }
            }
            Ok(())
        }
    }
}

/// Runs on the dedicated thread: acquire the request, then stay alive (and
/// therefore keep holding it) until asked to release or the manager is dropped.
#[cfg(windows)]
fn run_keep_awake(receiver: Receiver<Command>, ready: Sender<Result<(), String>>) {
    let acquired = set_thread_execution_state(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    let failed = acquired.is_err();
    let _ = ready.send(acquired);
    if failed {
        return;
    }
    while let Ok(Command::Release(reply)) = receiver.recv() {
        let _ = reply.send(set_thread_execution_state(ES_CONTINUOUS));
        return;
    }
    let _ = set_thread_execution_state(ES_CONTINUOUS);
}

/// A successful call returns the previous execution state (always including
/// `ES_CONTINUOUS`); only a failure returns zero.
#[cfg(windows)]
fn set_thread_execution_state(flags: u32) -> Result<(), String> {
    if unsafe { SetThreadExecutionState(flags) } == 0 {
        Err("Windows refused the keep-awake request.".to_string())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
use std::sync::mpsc::{self, Receiver, Sender};
#[cfg(windows)]
use std::thread::{self, JoinHandle};

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingBackend {
        calls: Mutex<Vec<bool>>,
        fail_on: Mutex<Option<bool>>,
    }

    impl RecordingBackend {
        fn calls(&self) -> Vec<bool> {
            self.calls.lock().unwrap().clone()
        }

        fn fail_on(&self, value: bool) {
            *self.fail_on.lock().unwrap() = Some(value);
        }

        fn stop_failing(&self) {
            *self.fail_on.lock().unwrap() = None;
        }
    }

    impl PowerBackend for RecordingBackend {
        fn set(&self, enabled: bool) -> Result<(), String> {
            if *self.fail_on.lock().unwrap() == Some(enabled) {
                return Err("the backend refused the request".to_string());
            }
            self.calls.lock().unwrap().push(enabled);
            Ok(())
        }
    }

    fn keeper(backend: &Arc<RecordingBackend>) -> KeepAwake {
        KeepAwake::new(Arc::clone(backend) as Arc<dyn PowerBackend>)
    }

    #[test]
    fn enabling_twice_calls_the_backend_once() {
        let backend = Arc::new(RecordingBackend::default());
        let keeper = keeper(&backend);
        assert_eq!(keeper.set(true), Ok(true));
        assert_eq!(keeper.set(true), Ok(true));
        assert_eq!(backend.calls(), vec![true]);
    }

    #[test]
    fn disabling_when_off_is_a_no_op() {
        let backend = Arc::new(RecordingBackend::default());
        let keeper = keeper(&backend);
        assert_eq!(keeper.set(false), Ok(false));
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn state_is_reported_and_toggles_with_the_backend() {
        let backend = Arc::new(RecordingBackend::default());
        let keeper = keeper(&backend);
        assert!(!keeper.is_enabled());
        assert_eq!(keeper.set(true), Ok(true));
        assert!(keeper.is_enabled());
        assert_eq!(keeper.set(false), Ok(false));
        assert!(!keeper.is_enabled());
        assert_eq!(backend.calls(), vec![true, false]);
    }

    #[test]
    fn dropping_a_held_request_releases_it() {
        let backend = Arc::new(RecordingBackend::default());
        {
            let keeper = keeper(&backend);
            assert_eq!(keeper.set(true), Ok(true));
        }
        assert_eq!(backend.calls(), vec![true, false]);
    }

    #[test]
    fn dropping_without_a_request_touches_nothing() {
        let backend = Arc::new(RecordingBackend::default());
        {
            let _keeper = keeper(&backend);
        }
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn a_failed_enable_reports_an_error_without_holding_the_request() {
        let backend = Arc::new(RecordingBackend::default());
        backend.fail_on(true);
        let keeper = keeper(&backend);
        assert!(keeper.set(true).is_err());
        assert!(!keeper.is_enabled());
        assert!(backend.calls().is_empty());
        backend.stop_failing();
        assert_eq!(keeper.set(true), Ok(true));
        assert!(keeper.is_enabled());
    }

    #[test]
    fn a_failed_disable_reports_an_error_and_keeps_the_request() {
        let backend = Arc::new(RecordingBackend::default());
        let keeper = keeper(&backend);
        assert_eq!(keeper.set(true), Ok(true));
        backend.fail_on(false);
        assert!(keeper.set(false).is_err());
        assert!(keeper.is_enabled());
        backend.stop_failing();
        assert_eq!(keeper.set(false), Ok(false));
        assert!(!keeper.is_enabled());
        assert_eq!(backend.calls(), vec![true, false]);
    }
}
