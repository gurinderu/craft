//! A round's tasks as the event stream tells them (realm @nick/craft, node #506): the runner's
//! start, reply and failure of each process, named by its task.

use craft_agent::AgentRequest;
use craft_agent::runner::RunEvent;
use craft_review::blocked;
use tokio::sync::mpsc::UnboundedReceiver;

use super::events::Event;
use super::outcome::blocked_in;
use super::task::Task;

/// A request as the stream names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Named {
    id: String,
    label: String,
    agent: Option<String>,
    model: Option<String>,
    tier: String,
}

impl Named {
    /// Each request's name, `ran` holding the index of its task.
    pub(crate) fn of(requests: &[AgentRequest], ran: &[usize], tasks: &[Task]) -> Vec<Self> {
        requests
            .iter()
            .zip(ran)
            .map(|(r, i)| {
                let task = tasks.get(*i);
                Self {
                    id: r.label.clone(),
                    label: task.map_or_else(|| r.label.clone(), |t| t.label.clone()),
                    agent: r.agent.clone(),
                    model: r.model.clone(),
                    tier: task.map(|t| t.model.clone()).unwrap_or_default(),
                }
            })
            .collect()
    }
}

/// A runner event as the stream's; `None` for an index no request has.
pub(crate) fn task_event(named: &[Named], event: RunEvent) -> Option<Event> {
    Some(match event {
        RunEvent::Started { index } => {
            let n = named.get(index)?.clone();
            Event::TaskStarted {
                id: n.id,
                label: n.label,
                agent: n.agent,
                model: n.model,
                tier: n.tier,
            }
        }
        // An answer that says it could not look is a failed task, as the binary fails it.
        RunEvent::Finished { index, reply } if let Some(why) = blocked_in(&reply) => {
            Event::TaskFailed {
                id: named.get(index)?.id.clone(),
                reason: blocked::failure(&why),
            }
        }
        RunEvent::Finished { index, reply } => Event::TaskFinished {
            id: named.get(index)?.id.clone(),
            tokens: Some(reply.usage.total()).filter(|t| *t > 0),
            cost_usd: Some(reply.cost_usd).filter(|c| *c > 0.0),
        },
        RunEvent::Failed { index, error } => Event::TaskFailed {
            id: named.get(index)?.id.clone(),
            reason: error,
        },
    })
}

/// Each runner event, as the stream's, until the batch's last sender is gone.
pub(crate) async fn watch(
    mut events: UnboundedReceiver<RunEvent>,
    named: &[Named],
    emit: &dyn Fn(Event),
) {
    while let Some(e) = events.recv().await {
        if let Some(event) = task_event(named, e) {
            emit(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use craft_agent::{AgentReply, Usage};

    use super::*;

    #[test]
    fn a_runner_event_is_named_by_its_task_and_its_spend_said_only_when_known() {
        let named = vec![Named {
            id: "t1".into(),
            label: "lens a".into(),
            agent: Some("review-task".into()),
            model: None,
            tier: "opus".into(),
        }];
        assert_eq!(
            task_event(&named, RunEvent::Started { index: 0 }),
            Some(Event::TaskStarted {
                id: "t1".into(),
                label: "lens a".into(),
                agent: Some("review-task".into()),
                model: None,
                tier: "opus".into()
            })
        );
        let reply = |input, cost_usd| AgentReply {
            structured: None,
            text: None,
            usage: Usage {
                input,
                ..Usage::default()
            },
            cost_usd,
            denials: Vec::new(),
        };
        assert_eq!(
            task_event(
                &named,
                RunEvent::Finished {
                    index: 0,
                    reply: reply(5, 0.5)
                }
            ),
            Some(Event::TaskFinished {
                id: "t1".into(),
                tokens: Some(5),
                cost_usd: Some(0.5)
            })
        );
        assert_eq!(
            task_event(
                &named,
                RunEvent::Finished {
                    index: 0,
                    reply: reply(0, 0.0)
                }
            ),
            Some(Event::TaskFinished {
                id: "t1".into(),
                tokens: None,
                cost_usd: None
            })
        );
        assert_eq!(task_event(&named, RunEvent::Started { index: 1 }), None);
    }
}
