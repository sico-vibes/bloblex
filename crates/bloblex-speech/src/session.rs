//! Dictation lifecycle: a small, testable state machine that mirrors Orca's
//! owner-locked session semantics (desktop and companion can never drive the
//! same dictation at once, and a start that is canceled mid-flight unwinds).

use crate::error::{SpeechError, SpeechResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DictationOwner {
    Desktop,
    Companion,
}

impl DictationOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Companion => "companion",
        }
    }

    pub fn parse(value: &str) -> SpeechResult<Self> {
        match value {
            "desktop" => Ok(Self::Desktop),
            "companion" => Ok(Self::Companion),
            other => Err(SpeechError::UnknownModel(format!("owner:{other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Starting(DictationOwner),
    Active(DictationOwner),
}

#[derive(Debug, Default)]
pub struct DictationLifecycle {
    phase: Option<Phase>,
    starting_model: Option<String>,
    active_model: Option<String>,
}

impl DictationLifecycle {
    pub fn new() -> Self {
        Self::default()
    }

    fn current_phase(&self) -> Phase {
        self.phase.unwrap_or(Phase::Idle)
    }

    /// Reserve the session for `owner`. Idempotent for the same owner while a
    /// start is still in flight.
    pub fn begin_start(&mut self, owner: DictationOwner, model_id: &str) -> SpeechResult<()> {
        match self.current_phase() {
            Phase::Idle => {
                self.phase = Some(Phase::Starting(owner));
                self.starting_model = Some(model_id.to_string());
                Ok(())
            }
            Phase::Starting(current) if current == owner => Ok(()),
            _ => Err(SpeechError::AlreadyActive),
        }
    }

    /// Promote a reserved start to active once the engine reports ready.
    pub fn mark_active(&mut self, owner: DictationOwner) -> SpeechResult<()> {
        if let Phase::Starting(current) = self.current_phase() {
            if current == owner {
                self.phase = Some(Phase::Active(owner));
                self.active_model = self.starting_model.take();
                return Ok(());
            }
        }
        Err(SpeechError::OwnerMismatch)
    }

    /// A start that finished after the caller canceled it.
    pub fn cancel_start(&mut self, owner: DictationOwner) {
        if let Phase::Starting(current) = self.current_phase() {
            if current == owner {
                self.reset();
            }
        }
    }

    /// Release the session. Active and starting states both unwind to idle.
    pub fn begin_stop(&mut self, owner: DictationOwner) -> SpeechResult<()> {
        match self.current_phase() {
            Phase::Idle => Ok(()),
            Phase::Active(current) | Phase::Starting(current) if current == owner => {
                self.reset();
                Ok(())
            }
            _ => Err(SpeechError::OwnerMismatch),
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(self.current_phase(), Phase::Active(_))
    }

    pub fn active_owner(&self) -> Option<DictationOwner> {
        match self.current_phase() {
            Phase::Active(owner) => Some(owner),
            _ => None,
        }
    }

    pub fn active_model(&self) -> Option<&str> {
        self.active_model.as_deref()
    }

    pub fn phase_name(&self) -> &'static str {
        match self.current_phase() {
            Phase::Idle => "idle",
            Phase::Starting(_) => "starting",
            Phase::Active(_) => "active",
        }
    }

    fn reset(&mut self) {
        self.phase = None;
        self.starting_model = None;
        self.active_model = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{DictationLifecycle, DictationOwner};
    use crate::error::SpeechError;

    const DESKTOP: DictationOwner = DictationOwner::Desktop;
    const COMPANION: DictationOwner = DictationOwner::Companion;

    #[test]
    fn second_owner_cannot_start_while_active() {
        let mut lifecycle = DictationLifecycle::new();
        lifecycle.begin_start(DESKTOP, "m").unwrap();
        lifecycle.mark_active(DESKTOP).unwrap();
        assert!(matches!(
            lifecycle.begin_start(COMPANION, "m"),
            Err(SpeechError::AlreadyActive)
        ));
        assert_eq!(lifecycle.active_owner(), Some(DESKTOP));
        assert_eq!(lifecycle.active_model(), Some("m"));
    }

    #[test]
    fn same_owner_start_is_idempotent_while_starting() {
        let mut lifecycle = DictationLifecycle::new();
        lifecycle.begin_start(DESKTOP, "m").unwrap();
        assert!(lifecycle.begin_start(DESKTOP, "m").is_ok());
        assert_eq!(lifecycle.phase_name(), "starting");
    }

    #[test]
    fn mark_active_requires_the_reserving_owner() {
        let mut lifecycle = DictationLifecycle::new();
        lifecycle.begin_start(DESKTOP, "m").unwrap();
        assert!(matches!(
            lifecycle.mark_active(COMPANION),
            Err(SpeechError::OwnerMismatch)
        ));
    }

    #[test]
    fn canceled_start_unwinds_to_idle() {
        let mut lifecycle = DictationLifecycle::new();
        lifecycle.begin_start(DESKTOP, "m").unwrap();
        lifecycle.cancel_start(DESKTOP);
        assert_eq!(lifecycle.phase_name(), "idle");
        assert!(!lifecycle.is_active());
    }

    #[test]
    fn stop_by_wrong_owner_is_rejected() {
        let mut lifecycle = DictationLifecycle::new();
        lifecycle.begin_start(DESKTOP, "m").unwrap();
        lifecycle.mark_active(DESKTOP).unwrap();
        assert!(matches!(
            lifecycle.begin_stop(COMPANION),
            Err(SpeechError::OwnerMismatch)
        ));
        lifecycle.begin_stop(DESKTOP).unwrap();
        assert_eq!(lifecycle.phase_name(), "idle");
    }

    #[test]
    fn owner_round_trips_through_string() {
        assert_eq!(DictationOwner::parse("desktop").unwrap(), DESKTOP);
        assert_eq!(DictationOwner::parse("companion").unwrap(), COMPANION);
        assert_eq!(DESKTOP.as_str(), "desktop");
        assert!(DictationOwner::parse("nobody").is_err());
    }
}
