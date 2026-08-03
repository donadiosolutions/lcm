//! Pure, versioned and fail-closed daemon-recovery transition model.
//!
//! This module deliberately has no descriptor, process, persistence, or IPC
//! authority.  A later lifecycle owner may ask it whether a transition is
//! legal only after it has independently gathered and revalidated those
//! facts.  The result is bounded data so crash-resume handling cannot depend
//! on ad-hoc control flow or an unbounded journal.

pub const TRANSITION_MODEL_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    VerifyExisting,
    PrepareStart,
    Recover,
    LaunchReplacement,
    PublishPid,
    AdmitHealthy,
    Abort,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnresolvedKind {
    Start,
    Recovery,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnresolvedPhase {
    Prepared,
    Recovering,
    ReplacementLaunched,
    PidPublished,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnresolvedOperation {
    pub kind: UnresolvedKind,
    pub phase: UnresolvedPhase,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Predecessor {
    Idle,
    Unresolved(UnresolvedOperation),
}

/// The independently obtained facts needed by a pure transition decision.
///
/// Values are intentionally booleans rather than handles or record bodies:
/// this layer cannot mistake a model decision for authority to use mutable
/// resources. `valid()` rejects contradictory fact sets before evaluating an
/// action.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Facts {
    pub supported_kernel: bool,
    /// True only when all evidence required for this transition was present
    /// and bound to the held authority. Missing evidence is distinct from an
    /// invalid authenticator over present evidence.
    pub evidence_bound: bool,
    pub authenticated: bool,
    pub unambiguous: bool,
    pub fresh: bool,
    pub existing_healthy: bool,
    pub replacement_launched: bool,
    pub pid_published: bool,
    pub healthy_admitted: bool,
}

impl Facts {
    pub const fn unavailable() -> Self {
        Self {
            supported_kernel: false,
            evidence_bound: false,
            authenticated: false,
            unambiguous: false,
            fresh: false,
            existing_healthy: false,
            replacement_launched: false,
            pid_published: false,
            healthy_admitted: false,
        }
    }

    const fn valid(self) -> bool {
        // A later health result cannot exist without an observed PID. A
        // replacement cannot coexist with a healthy predecessor daemon: that
        // combination has no safe lifecycle interpretation.
        (!self.healthy_admitted || self.pid_published)
            && !(self.existing_healthy && self.replacement_launched)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Input {
    pub version: u16,
    pub action: Action,
    pub predecessor: Predecessor,
    pub facts: Facts,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Terminal {
    ExistingVerified,
    NoExistingDaemon,
    HealthyAdmitted,
    Aborted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    UnsupportedVersion,
    UnsupportedKernel,
    MissingEvidence,
    Unauthenticated,
    Ambiguous,
    Stale,
    ContradictoryFacts,
    IllegalPredecessor,
    ExistingDaemonHealthy,
    ReplacementNotLaunched,
    PidNotPublished,
    HealthNotAdmitted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Continue(UnresolvedOperation),
    Terminal(Terminal),
    Refused(Refusal),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Output {
    pub outcome: Outcome,
    pub next: Predecessor,
}

impl Output {
    const fn refused(reason: Refusal, predecessor: Predecessor) -> Self {
        Self {
            outcome: Outcome::Refused(reason),
            // Refusal is terminal at this model layer. Keeping an unresolved
            // operation would permit a later action to make progress after an
            // ambiguous or stale observation.
            next: match predecessor {
                Predecessor::Idle | Predecessor::Unresolved(_) => Predecessor::Idle,
            },
        }
    }

    const fn terminal(terminal: Terminal) -> Self {
        Self {
            outcome: Outcome::Terminal(terminal),
            next: Predecessor::Idle,
        }
    }

    const fn continue_with(operation: UnresolvedOperation) -> Self {
        Self {
            outcome: Outcome::Continue(operation),
            next: Predecessor::Unresolved(operation),
        }
    }
}

/// Evaluates one transition. Any unsupported, missing-evidence,
/// unauthenticated, ambiguous, stale, contradictory, or otherwise illegal
/// input deterministically refuses and clears this bounded model's single
/// unresolved-operation slot.
pub const fn evaluate(input: Input) -> Output {
    if input.version != TRANSITION_MODEL_VERSION {
        return Output::refused(Refusal::UnsupportedVersion, input.predecessor);
    }
    if !input.facts.valid() {
        return Output::refused(Refusal::ContradictoryFacts, input.predecessor);
    }
    if !input.facts.supported_kernel {
        return Output::refused(Refusal::UnsupportedKernel, input.predecessor);
    }
    // Evidence absence/unboundness takes precedence over authentication so a
    // caller cannot collapse "nothing was authenticated" into "bad MAC".
    if !input.facts.evidence_bound {
        return Output::refused(Refusal::MissingEvidence, input.predecessor);
    }
    if !input.facts.authenticated {
        return Output::refused(Refusal::Unauthenticated, input.predecessor);
    }
    if !input.facts.unambiguous {
        return Output::refused(Refusal::Ambiguous, input.predecessor);
    }
    if !input.facts.fresh {
        return Output::refused(Refusal::Stale, input.predecessor);
    }

    match (input.action, input.predecessor) {
        (Action::VerifyExisting, Predecessor::Idle) if input.facts.existing_healthy => {
            Output::terminal(Terminal::ExistingVerified)
        }
        (Action::VerifyExisting, Predecessor::Idle) => Output::terminal(Terminal::NoExistingDaemon),
        (Action::PrepareStart, Predecessor::Idle) => Output::continue_with(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::Prepared,
        }),
        (Action::Recover, Predecessor::Idle) if input.facts.existing_healthy => {
            Output::refused(Refusal::ExistingDaemonHealthy, input.predecessor)
        }
        (Action::Recover, Predecessor::Idle) => Output::continue_with(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::Recovering,
        }),
        (
            Action::LaunchReplacement,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Recovery,
                phase: UnresolvedPhase::Recovering,
            }),
        ) if input.facts.replacement_launched => Output::continue_with(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::ReplacementLaunched,
        }),
        (
            Action::LaunchReplacement,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Recovery,
                phase: UnresolvedPhase::Recovering,
            }),
        ) => Output::refused(Refusal::ReplacementNotLaunched, input.predecessor),
        (
            Action::PublishPid,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Start,
                phase: UnresolvedPhase::Prepared,
            }),
        ) if input.facts.pid_published => Output::continue_with(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::PidPublished,
        }),
        (
            Action::PublishPid,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Recovery,
                phase: UnresolvedPhase::ReplacementLaunched,
            }),
        ) if input.facts.pid_published => Output::continue_with(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::PidPublished,
        }),
        (
            Action::PublishPid,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Start,
                phase: UnresolvedPhase::Prepared,
            })
            | Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Recovery,
                phase: UnresolvedPhase::ReplacementLaunched,
            }),
        ) => Output::refused(Refusal::PidNotPublished, input.predecessor),
        (
            Action::AdmitHealthy,
            Predecessor::Unresolved(UnresolvedOperation {
                phase: UnresolvedPhase::PidPublished,
                ..
            }),
        ) if input.facts.healthy_admitted => Output::terminal(Terminal::HealthyAdmitted),
        (
            Action::AdmitHealthy,
            Predecessor::Unresolved(UnresolvedOperation {
                phase: UnresolvedPhase::PidPublished,
                ..
            }),
        ) => Output::refused(Refusal::HealthNotAdmitted, input.predecessor),
        (Action::Abort, Predecessor::Unresolved(_)) => Output::terminal(Terminal::Aborted),
        _ => Output::refused(Refusal::IllegalPredecessor, input.predecessor),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE_FACTS: Facts = Facts {
        supported_kernel: true,
        evidence_bound: true,
        authenticated: true,
        unambiguous: true,
        fresh: true,
        existing_healthy: false,
        replacement_launched: false,
        pid_published: false,
        healthy_admitted: false,
    };

    const PREDECESSORS: [Predecessor; 9] = [
        Predecessor::Idle,
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::Prepared,
        }),
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::Recovering,
        }),
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::ReplacementLaunched,
        }),
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::Recovering,
        }),
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::ReplacementLaunched,
        }),
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::PidPublished,
        }),
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::Prepared,
        }),
        Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::PidPublished,
        }),
    ];

    const ACTIONS: [Action; 7] = [
        Action::VerifyExisting,
        Action::PrepareStart,
        Action::Recover,
        Action::LaunchReplacement,
        Action::PublishPid,
        Action::AdmitHealthy,
        Action::Abort,
    ];

    fn input(action: Action, predecessor: Predecessor, facts: Facts) -> Input {
        Input {
            version: TRANSITION_MODEL_VERSION,
            action,
            predecessor,
            facts,
        }
    }

    fn assert_refused(output: Output, reason: Refusal) {
        assert_eq!(output.outcome, Outcome::Refused(reason));
        assert_eq!(output.next, Predecessor::Idle);
    }

    #[test]
    fn matrix_refuses_every_illegal_action_predecessor_pair() {
        for action in ACTIONS {
            for predecessor in PREDECESSORS {
                let output = evaluate(input(action, predecessor, BASE_FACTS));
                let legal = matches!(
                    (action, predecessor),
                    (
                        Action::VerifyExisting | Action::PrepareStart | Action::Recover,
                        Predecessor::Idle
                    ) | (
                        Action::LaunchReplacement,
                        Predecessor::Unresolved(UnresolvedOperation {
                            kind: UnresolvedKind::Recovery,
                            phase: UnresolvedPhase::Recovering
                        })
                    ) | (
                        Action::PublishPid,
                        Predecessor::Unresolved(UnresolvedOperation {
                            kind: UnresolvedKind::Start,
                            phase: UnresolvedPhase::Prepared
                        })
                    ) | (
                        Action::PublishPid,
                        Predecessor::Unresolved(UnresolvedOperation {
                            kind: UnresolvedKind::Recovery,
                            phase: UnresolvedPhase::ReplacementLaunched
                        })
                    ) | (
                        Action::AdmitHealthy,
                        Predecessor::Unresolved(UnresolvedOperation {
                            phase: UnresolvedPhase::PidPublished,
                            ..
                        })
                    ) | (Action::Abort, Predecessor::Unresolved(_))
                );
                if !legal {
                    assert_refused(output, Refusal::IllegalPredecessor);
                }
            }
        }
    }

    #[test]
    fn happy_paths_keep_exactly_one_unresolved_operation() {
        let start = evaluate(input(Action::PrepareStart, Predecessor::Idle, BASE_FACTS));
        assert_eq!(
            start.outcome,
            Outcome::Continue(UnresolvedOperation {
                kind: UnresolvedKind::Start,
                phase: UnresolvedPhase::Prepared
            })
        );
        let published = evaluate(input(
            Action::PublishPid,
            start.next,
            Facts {
                pid_published: true,
                ..BASE_FACTS
            },
        ));
        assert_eq!(
            published.next,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Start,
                phase: UnresolvedPhase::PidPublished
            })
        );
        let healthy = evaluate(input(
            Action::AdmitHealthy,
            published.next,
            Facts {
                pid_published: true,
                healthy_admitted: true,
                ..BASE_FACTS
            },
        ));
        assert_eq!(
            healthy.outcome,
            Outcome::Terminal(Terminal::HealthyAdmitted)
        );
        assert_eq!(healthy.next, Predecessor::Idle);

        let recovery = evaluate(input(Action::Recover, Predecessor::Idle, BASE_FACTS));
        let launched = evaluate(input(
            Action::LaunchReplacement,
            recovery.next,
            Facts {
                replacement_launched: true,
                ..BASE_FACTS
            },
        ));
        let replacement_pid = evaluate(input(
            Action::PublishPid,
            launched.next,
            Facts {
                replacement_launched: true,
                pid_published: true,
                ..BASE_FACTS
            },
        ));
        assert_eq!(
            replacement_pid.next,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Recovery,
                phase: UnresolvedPhase::PidPublished
            })
        );
        let recovery_healthy = evaluate(input(
            Action::AdmitHealthy,
            replacement_pid.next,
            Facts {
                replacement_launched: true,
                pid_published: true,
                healthy_admitted: true,
                ..BASE_FACTS
            },
        ));
        assert_eq!(
            recovery_healthy.outcome,
            Outcome::Terminal(Terminal::HealthyAdmitted)
        );
        assert_eq!(recovery_healthy.next, Predecessor::Idle);
    }

    #[test]
    fn crash_resume_never_starts_a_second_unresolved_operation() {
        let recovered = evaluate(input(Action::Recover, Predecessor::Idle, BASE_FACTS));
        let in_flight = recovered.next;
        assert!(matches!(in_flight, Predecessor::Unresolved(_)));

        // A crash after durable recovery intent is represented by the same
        // bounded predecessor. Reissuing either admission/start action cannot
        // create a second operation; only the next recovery edge can resume.
        assert_refused(
            evaluate(input(Action::Recover, in_flight, BASE_FACTS)),
            Refusal::IllegalPredecessor,
        );
        assert_refused(
            evaluate(input(Action::PrepareStart, in_flight, BASE_FACTS)),
            Refusal::IllegalPredecessor,
        );
        let resumed = evaluate(input(
            Action::LaunchReplacement,
            in_flight,
            Facts {
                replacement_launched: true,
                ..BASE_FACTS
            },
        ));
        assert_eq!(
            resumed.next,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Recovery,
                phase: UnresolvedPhase::ReplacementLaunched,
            })
        );
    }

    #[test]
    fn verification_and_abort_are_terminal() {
        let verified = evaluate(input(
            Action::VerifyExisting,
            Predecessor::Idle,
            Facts {
                existing_healthy: true,
                ..BASE_FACTS
            },
        ));
        assert_eq!(
            verified.outcome,
            Outcome::Terminal(Terminal::ExistingVerified)
        );
        assert_eq!(verified.next, Predecessor::Idle);

        let absent = evaluate(input(Action::VerifyExisting, Predecessor::Idle, BASE_FACTS));
        assert_eq!(
            absent.outcome,
            Outcome::Terminal(Terminal::NoExistingDaemon)
        );

        let aborted = evaluate(input(
            Action::Abort,
            Predecessor::Unresolved(UnresolvedOperation {
                kind: UnresolvedKind::Recovery,
                phase: UnresolvedPhase::Recovering,
            }),
            BASE_FACTS,
        ));
        assert_eq!(aborted.outcome, Outcome::Terminal(Terminal::Aborted));
        assert_eq!(aborted.next, Predecessor::Idle);
    }

    #[test]
    fn fault_inputs_fail_closed_and_clear_unresolved_state() {
        let predecessor = Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::Prepared,
        });
        let faults = [
            (
                Facts {
                    supported_kernel: false,
                    ..BASE_FACTS
                },
                Refusal::UnsupportedKernel,
            ),
            (
                Facts {
                    evidence_bound: false,
                    ..BASE_FACTS
                },
                Refusal::MissingEvidence,
            ),
            (
                Facts {
                    authenticated: false,
                    ..BASE_FACTS
                },
                Refusal::Unauthenticated,
            ),
            (
                Facts {
                    unambiguous: false,
                    ..BASE_FACTS
                },
                Refusal::Ambiguous,
            ),
            (
                Facts {
                    fresh: false,
                    ..BASE_FACTS
                },
                Refusal::Stale,
            ),
            (
                Facts {
                    healthy_admitted: true,
                    ..BASE_FACTS
                },
                Refusal::ContradictoryFacts,
            ),
        ];
        for (facts, reason) in faults {
            assert_refused(
                evaluate(input(Action::PublishPid, predecessor, facts)),
                reason,
            );
        }
        assert_refused(
            evaluate(Input {
                version: TRANSITION_MODEL_VERSION + 1,
                action: Action::PublishPid,
                predecessor,
                facts: BASE_FACTS,
            }),
            Refusal::UnsupportedVersion,
        );
        assert_refused(
            evaluate(input(
                Action::PublishPid,
                predecessor,
                Facts {
                    evidence_bound: false,
                    authenticated: false,
                    ..BASE_FACTS
                },
            )),
            Refusal::MissingEvidence,
        );
    }

    #[test]
    fn launch_and_health_require_their_observable_facts() {
        let recovering = Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::Recovering,
        });
        assert_refused(
            evaluate(input(Action::LaunchReplacement, recovering, BASE_FACTS)),
            Refusal::ReplacementNotLaunched,
        );
        let prepared = Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::Prepared,
        });
        assert_refused(
            evaluate(input(Action::PublishPid, prepared, BASE_FACTS)),
            Refusal::PidNotPublished,
        );
        let published = Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Start,
            phase: UnresolvedPhase::PidPublished,
        });
        assert_refused(
            evaluate(input(
                Action::AdmitHealthy,
                published,
                Facts {
                    pid_published: true,
                    ..BASE_FACTS
                },
            )),
            Refusal::HealthNotAdmitted,
        );
    }

    #[test]
    fn contradictory_existing_and_replacement_facts_fail_closed() {
        let predecessor = Predecessor::Unresolved(UnresolvedOperation {
            kind: UnresolvedKind::Recovery,
            phase: UnresolvedPhase::Recovering,
        });
        assert_refused(
            evaluate(input(
                Action::LaunchReplacement,
                predecessor,
                Facts {
                    existing_healthy: true,
                    replacement_launched: true,
                    ..BASE_FACTS
                },
            )),
            Refusal::ContradictoryFacts,
        );
    }
}
