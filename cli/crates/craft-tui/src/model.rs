//! What the view shows: phases in the order they began, each with its agents.

/// A step of the run, as the producer reports it. Agent ids are unique across the run.
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressEvent {
    /// A phase began.
    Phase {
        name: String,
    },
    /// An agent was queued in a phase.
    Agent {
        phase: String,
        agent: String,
    },
    Started {
        agent: String,
    },
    Finished {
        agent: String,
        tokens: u64,
        cost_usd: f64,
    },
    Failed {
        agent: String,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Queued,
    Running,
    Done,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRow {
    pub id: String,
    pub status: Status,
    pub tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PhaseRow {
    pub name: String,
    pub agents: Vec<AgentRow>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    pub phases: Vec<PhaseRow>,
}

impl Progress {
    pub fn apply(&mut self, event: ProgressEvent) {
        match event {
            ProgressEvent::Phase { name } => self.phase(name),
            ProgressEvent::Agent { phase, agent } => {
                if !self.phases.iter().any(|p| p.name == phase) {
                    self.phase(phase.clone());
                }
                if let Some(p) = self.phases.iter_mut().find(|p| p.name == phase) {
                    p.agents.push(AgentRow {
                        id: agent,
                        status: Status::Queued,
                        tokens: 0,
                        cost_usd: 0.0,
                    });
                }
            }
            ProgressEvent::Started { agent } => {
                self.set(&agent, |row| row.status = Status::Running);
            }
            ProgressEvent::Finished {
                agent,
                tokens,
                cost_usd,
            } => self.set(&agent, |row| {
                row.status = Status::Done;
                row.tokens = tokens;
                row.cost_usd = cost_usd;
            }),
            ProgressEvent::Failed { agent, reason } => {
                self.set(&agent, |row| row.status = Status::Failed(reason));
            }
        }
    }

    /// Tokens and dollars over every agent.
    #[must_use]
    pub fn totals(&self) -> (u64, f64) {
        self.rows().fold((0, 0.0), |(t, c), r| {
            (t.saturating_add(r.tokens), c + r.cost_usd)
        })
    }

    fn rows(&self) -> impl Iterator<Item = &AgentRow> {
        self.phases.iter().flat_map(|p| &p.agents)
    }

    fn phase(&mut self, name: String) {
        if !self.phases.iter().any(|p| p.name == name) {
            self.phases.push(PhaseRow {
                name,
                agents: Vec::new(),
            });
        }
    }

    /// An event for an agent never queued is dropped: the producer broke its contract, and the
    /// view has no phase to put it under.
    fn set(&mut self, agent: &str, change: impl FnOnce(&mut AgentRow)) {
        if let Some(row) = self
            .phases
            .iter_mut()
            .flat_map(|p| &mut p.agents)
            .find(|r| r.id == agent)
        {
            change(row);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(phase: &str, agent: &str) -> ProgressEvent {
        ProgressEvent::Agent {
            phase: phase.into(),
            agent: agent.into(),
        }
    }

    #[test]
    fn agents_move_from_queued_through_running_to_done_or_failed() {
        let mut p = Progress::default();
        p.apply(agent("scan", "a"));
        p.apply(agent("scan", "b"));
        p.apply(ProgressEvent::Started { agent: "a".into() });
        assert_eq!(p.phases[0].agents[0].status, Status::Running);
        p.apply(ProgressEvent::Finished {
            agent: "a".into(),
            tokens: 10,
            cost_usd: 0.5,
        });
        p.apply(ProgressEvent::Failed {
            agent: "b".into(),
            reason: "exit 1".into(),
        });
        let rows = &p.phases[0].agents;
        assert_eq!((rows[0].status.clone(), rows[0].tokens), (Status::Done, 10));
        assert_eq!(rows[1].status, Status::Failed("exit 1".into()));
        let (tokens, cost) = p.totals();
        assert_eq!(tokens, 10);
        assert!((cost - 0.5).abs() < 1e-12);
    }

    #[test]
    fn phases_keep_their_order_and_are_not_repeated() {
        let mut p = Progress::default();
        p.apply(ProgressEvent::Phase {
            name: "scan".into(),
        });
        p.apply(agent("verify", "v"));
        p.apply(ProgressEvent::Phase {
            name: "scan".into(),
        });
        let names: Vec<_> = p.phases.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["scan", "verify"]);
    }

    #[test]
    fn an_event_for_an_unknown_agent_changes_nothing() {
        let mut p = Progress::default();
        p.apply(agent("scan", "a"));
        let before = p.clone();
        p.apply(ProgressEvent::Started {
            agent: "ghost".into(),
        });
        assert_eq!(p, before);
    }
}
