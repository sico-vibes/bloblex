use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use thiserror::Error;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    Host,
    Runtime,
    Agent,
    Project,
    Session,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Policy {
    pub id: String,
    pub scope: Scope,
    pub scope_id: Option<String>,
    pub period: String,
    pub metric: String,
    pub hard_limit: i64,
    pub enabled: bool,
}
#[derive(Debug, Clone)]
pub struct Admission {
    pub turn_id: String,
    pub estimate: i64,
    pub applicable_policy_ids: Vec<String>,
}
#[derive(Debug, Error, PartialEq, Eq)]
pub enum BudgetError {
    #[error("budget blocked by policy {0}")]
    Blocked(String),
    #[error("duplicate turn reservation")]
    Duplicate,
    #[error("policy missing: {0}")]
    PolicyMissing(String),
}
#[derive(Default)]
pub struct BudgetEngine {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    policies: Vec<Policy>,
    consumed: std::collections::HashMap<String, i64>,
    reserved: std::collections::HashMap<String, i64>,
    turns: std::collections::HashMap<String, (i64, Vec<String>)>,
}
impl BudgetEngine {
    pub fn set_policies(&self, p: Vec<Policy>) {
        self.state.lock().unwrap().policies = p
    }
    pub fn admit(&self, a: Admission) -> Result<(), BudgetError> {
        let mut s = self.state.lock().unwrap();
        if s.turns.contains_key(&a.turn_id) {
            return Err(BudgetError::Duplicate);
        }
        let policies = s
            .policies
            .iter()
            .filter(|p| p.enabled && a.applicable_policy_ids.contains(&p.id))
            .collect::<Vec<_>>();
        for p in &policies {
            let used = s
                .consumed
                .get(&p.id)
                .copied()
                .unwrap_or(0)
                .saturating_add(s.reserved.get(&p.id).copied().unwrap_or(0));
            if used.saturating_add(a.estimate) > p.hard_limit {
                return Err(BudgetError::Blocked(p.id.clone()));
            }
        }
        let ids = policies.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
        for id in &ids {
            *s.reserved.entry(id.clone()).or_default() += a.estimate;
        }
        s.turns.insert(a.turn_id, (a.estimate, ids));
        Ok(())
    }
    pub fn reconcile(&self, turn: &str, actual: i64) -> bool {
        let mut s = self.state.lock().unwrap();
        let Some((reserved, ids)) = s.turns.remove(turn) else {
            return false;
        };
        for id in ids {
            *s.reserved.entry(id.clone()).or_default() -= reserved;
            *s.consumed.entry(id).or_default() += actual;
        }
        true
    }
    pub fn release(&self, turn: &str) -> bool {
        let mut s = self.state.lock().unwrap();
        let Some((reserved, ids)) = s.turns.remove(turn) else {
            return false;
        };
        for id in ids {
            *s.reserved.entry(id).or_default() -= reserved;
        }
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn strictest_policy_blocks() {
        let b = BudgetEngine::default();
        b.set_policies(vec![
            Policy {
                id: "global".into(),
                scope: Scope::Global,
                scope_id: None,
                period: "day".into(),
                metric: "tokens".into(),
                hard_limit: 100,
                enabled: true,
            },
            Policy {
                id: "session".into(),
                scope: Scope::Session,
                scope_id: Some("s".into()),
                period: "turn".into(),
                metric: "tokens".into(),
                hard_limit: 5,
                enabled: true,
            },
        ]);
        assert_eq!(
            b.admit(Admission {
                turn_id: "t".into(),
                estimate: 10,
                applicable_policy_ids: vec!["global".into(), "session".into()]
            }),
            Err(BudgetError::Blocked("session".into()))
        );
    }
    #[test]
    fn concurrent_admissions_cannot_double_spend() {
        let b = Arc::new(BudgetEngine::default());
        b.set_policies(vec![Policy {
            id: "g".into(),
            scope: Scope::Global,
            scope_id: None,
            period: "day".into(),
            metric: "tokens".into(),
            hard_limit: 10,
            enabled: true,
        }]);
        let mut threads = vec![];
        for i in 0..20 {
            let b = b.clone();
            threads.push(std::thread::spawn(move || {
                b.admit(Admission {
                    turn_id: i.to_string(),
                    estimate: 1,
                    applicable_policy_ids: vec!["g".into()],
                })
                .is_ok()
            }));
        }
        let accepted = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|accepted| *accepted)
            .count();
        assert_eq!(accepted, 10);
    }
    #[test]
    fn reconciliation_releases_reservation() {
        let b = BudgetEngine::default();
        b.set_policies(vec![Policy {
            id: "g".into(),
            scope: Scope::Global,
            scope_id: None,
            period: "day".into(),
            metric: "tokens".into(),
            hard_limit: 10,
            enabled: true,
        }]);
        b.admit(Admission {
            turn_id: "t".into(),
            estimate: 8,
            applicable_policy_ids: vec!["g".into()],
        })
        .unwrap();
        assert!(b.reconcile("t", 4));
        assert!(b
            .admit(Admission {
                turn_id: "t2".into(),
                estimate: 6,
                applicable_policy_ids: vec!["g".into()]
            })
            .is_ok());
    }
}
