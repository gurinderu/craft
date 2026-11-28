//! The loop of `craft review run` (realm @nick/craft, nodes #453, #499): start or resume, then
//! rounds of tasks and submits until the binary is done. It holds no review logic: what to ask,
//! of which model, in which shape and what the answers mean are all the binary's.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use craft_agent::codex::Codex;
use craft_agent::opencode::OpenCode;
use craft_agent::pi::Pi;
use craft_review::cancel::Cancel;
use craft_review::filing::StopCause;
use serde_json::Value;
use tokio::runtime::{Handle, RuntimeFlavor};
use tokio::task::block_in_place;

use super::HostKind;
use super::ending::{Caught, Ending, recovered};
use super::events::Event;
use super::protocol::{Lifecycle, Protocol, Said};
use super::report::resume_hint;
use super::round::{RoundCtx, RoundResult, run_round};
use super::task::{Task, tasks_of};
use super::telemetry::Lost;

/// A backstop only — the binary decides when the run is done: sixteen steps, each asked at most
/// three times, and three spare (integrations/shared/cli-review-commands.mjs, `MAX_ROUNDS`).
pub(crate) const MAX_ROUNDS: usize = 51;

/// What the loop runs with.
pub(crate) struct Driver<'a, P> {
    pub(crate) proto: &'a P,
    pub(crate) round: RoundCtx<'a>,
    /// How to run this command again on a run, as a resume hint names it.
    pub(crate) again: &'a dyn Fn(&str) -> String,
}

impl<P> Driver<'_, P> {
    pub(crate) fn log(&self, line: &str) {
        (self.round.log)(line);
    }

    fn emit(&self, event: Event) {
        (self.round.emit)(event);
    }
}

impl<P: Protocol> Driver<'_, P> {
    pub(crate) fn hint(&self, run: &Path) -> String {
        let run = run.display().to_string();
        match self.proto.lifecycle() {
            Lifecycle::Review => resume_hint(&run, &(self.again)(&run)),
            Lifecycle::Triage => format!("To resume it: {}.", (self.again)(&run)),
        }
    }
}

/// What the loop has gathered over the run.
#[derive(Debug, Default)]
pub(crate) struct Running {
    pub(crate) run: Option<PathBuf>,
    pub(crate) agents: u64,
    /// Each dead task's last error line, and how many said it.
    pub(crate) said: HashMap<String, u64>,
    /// A round in which no task answered.
    pub(crate) all_died: bool,
    pub(crate) lost: Lost,
    pub(crate) limit: Option<String>,
}

pub(crate) fn is_done(step: &Value) -> bool {
    step.get("done").and_then(Value::as_bool) == Some(true)
}

/// From the start (or the resume) to the step that ends the run.
pub(crate) async fn steps<P: Protocol>(
    d: &Driver<'_, P>,
    resume: Option<&Path>,
    r: &mut Running,
) -> Ending {
    let name = d.proto.lifecycle().name();
    let first = match resume {
        Some(run) => d.proto.submit(
            run,
            &Said {
                resume: true,
                ..Said::default()
            },
        ),
        None => start(d),
    };
    // A stopping signal that came while the binary opened the run ends it here, before any round:
    // a start it cut short asks for a fresh review, a resume for another resume.
    let signalled = *d.round.stop.borrow();
    let doing = if resume.is_some() { "resume" } else { "start" };
    let ending = |code, error| match resume {
        Some(_) => Ending::Signalled(code, Caught::Running),
        None => Ending::Signalled(code, Caught::Starting(error)),
    };
    let step = match (first, signalled) {
        (Ok(s), _) => s,
        (Err(e), Some(code)) => return ending(code, Some(format!("{e:#}"))),
        (Err(e), None) => {
            if let Some(run) = resume.filter(|_| d.proto.lifecycle() == Lifecycle::Triage) {
                r.run = Some(run.to_owned());
                return recovered(d, run, &format!("{e:#}"), r);
            }
            return Ending::Stopped(format!("{name} could not {doing}: {e:#}"), StopCause::Start);
        }
    };
    let Some(run) = step.get("run").and_then(Value::as_str).map(PathBuf::from) else {
        return Ending::Stopped(
            format!("{name} could not {doing}: the step names no run directory"),
            StopCause::Start,
        );
    };
    d.log(&format!("run={}", run.display()));
    r.run = Some(run.clone());
    r.lost.heard(&step, &|l| d.log(l));
    if let Some(line) = step.get("worktree").and_then(Value::as_str) {
        d.log(line);
    }
    if let Some(code) = signalled {
        return ending(code, None);
    }
    // The tasks run where the run reviews: craft's own worktree of the PR given, or on a resume
    // the checkout the run recorded (realm `@nick/craft`, node #517).
    let repo = step.get("repo").and_then(Value::as_str).map(PathBuf::from);
    match repo.filter(|p| !same_dir(p, d.round.repo)) {
        Some(repo) => {
            let host = match super::there::host_in(d.round.host, &repo, d.round.log) {
                Ok(host) => host,
                Err(why) => {
                    let hint = d.hint(&run);
                    return Ending::Stopped(
                        format!(
                            "{name} cannot run its tasks: {why}. The run is in {}. {hint}",
                            run.display()
                        ),
                        StopCause::Host,
                    );
                }
            };
            let there = Driver {
                proto: d.proto,
                round: RoundCtx {
                    host: &host,
                    repo: &repo,
                    ..d.round.clone()
                },
                again: d.again,
            };
            rounds(&there, &run, step, r).await
        }
        None => rounds(d, &run, step, r).await,
    }
}

/// The run opened by the binary, a stopping signal meanwhile cutting its gate, sources and
/// consumers list short (realm @nick/craft, node #544): the start blocks this thread, so the stop is
/// handed on by a task the runtime's workers run — on a multi-threaded runtime, which `main`'s is;
/// on a current-thread one the stop is seen only once the start returns.
fn start<P: Protocol>(d: &Driver<'_, P>) -> anyhow::Result<Value> {
    let cancel = Cancel::default();
    let stopping = {
        let (cancel, mut stop) = (cancel.clone(), d.round.stop.clone());
        tokio::spawn(async move {
            if stop.wait_for(Option::is_some).await.is_ok() {
                cancel.cancel();
            }
        })
    };
    let first = match Handle::current().runtime_flavor() {
        // Off its worker's queue, so no task waiting there is held behind the start.
        RuntimeFlavor::MultiThread => block_in_place(|| d.proto.start(&cancel)),
        RuntimeFlavor::CurrentThread | _ => d.proto.start(&cancel),
    };
    stopping.abort();
    first
}

/// Whether `a` and `b` are one directory: compared resolved, so a symlinked path (macOS's `/var`)
/// or a relative one names the checkout it points at; as given when either cannot be resolved.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Rounds of tasks and submits from `at` until the binary is done.
async fn rounds<P: Protocol>(
    d: &Driver<'_, P>,
    run: &Path,
    mut at: Value,
    r: &mut Running,
) -> Ending {
    let mut last_phase = String::new();
    let name = d.proto.lifecycle().name();
    for round in 1.. {
        if d.proto.lifecycle().terminal(&at) {
            return Ending::Finished(at);
        }
        if round > MAX_ROUNDS {
            let hint = d.hint(run);
            return Ending::Stopped(
                format!(
                    "{name} gave up after {MAX_ROUNDS} rounds; the run is in {}. {hint}",
                    run.display()
                ),
                StopCause::Rounds,
            );
        }
        let tasks = match tasks_of(&at) {
            Ok(t) => t,
            Err(e) => return recovered(d, run, &e, r),
        };
        let phase = at.get("phase").and_then(Value::as_str).unwrap_or_default();
        announce(d, (round, phase), &tasks, &mut last_phase);
        let res = round_of(&d.round, &tasks, round).await;
        // A stopping signal cut the round short (its tasks' groups stopped): nothing is submitted,
        // and the round's degraded notes wait in the run beside the answers that landed.
        if let Some(code) = *d.round.stop.borrow() {
            keep(d, run, &res.degraded);
            return Ending::Signalled(code, Caught::Running);
        }
        let said = heard(r, res);
        // Not logged in: no task can answer, so nothing is submitted; a resume hands the step's
        // missing answers out again.
        if let Some(login) = said.1 {
            keep(d, run, &said.0.degraded);
            let hint = d.hint(run);
            return Ending::Stopped(
                format!("{login}. The run is in {}. {hint}", run.display()),
                StopCause::Host,
            );
        }
        match d.proto.submit(run, &said.0) {
            Ok(step) => {
                r.lost.heard(&step, &|l| d.log(l));
                at = step;
            }
            Err(e) => {
                // The submit may have failed before its state held the notes: they wait in the
                // run, taken once by the resume (or the recovery's refiling) that comes next.
                keep(d, run, &said.0.degraded);
                return recovered(d, run, &format!("{e:#}"), r);
            }
        }
    }
    Ending::Stopped(format!("{name} ran out of rounds"), StopCause::Rounds)
}

/// The degraded notes of a round no submit carries, kept in the run for the next submit to take
/// (realm @nick/craft, node #752); notes that cannot be kept are said, so they are not lost unseen.
fn keep<P>(d: &Driver<'_, P>, run: &Path, notes: &[String]) {
    if let Err(e) = craft_step::noted::keep(run, notes) {
        let why = craft_step::left::chain(&e);
        d.log(&format!(
            "⚠️ the round's degraded notes could not be kept for the resume ({why}); a resumed run will not say them: {}",
            notes.join(" | ")
        ));
    }
}

/// A round's start, said: the phase when it moved, then the round and its tasks.
fn announce<P>(
    d: &Driver<'_, P>,
    (round, phase): (usize, &str),
    tasks: &[Task],
    last: &mut String,
) {
    if !phase.is_empty() && phase != last {
        phase.clone_into(last);
        d.emit(Event::Phase {
            name: phase.to_owned(),
        });
    }
    d.emit(Event::Round {
        round,
        phase: phase.to_owned(),
        tasks: tasks.len(),
    });
    let labels: Vec<&str> = tasks.iter().map(|t| t.label.as_str()).collect();
    let phase = if phase.is_empty() {
        String::new()
    } else {
        format!(" ({phase})")
    };
    d.log(&format!(
        "round {round}{phase}: {} task(s) — {}",
        tasks.len(),
        labels.join(", ")
    ));
}

/// A round counted into the run's: what the next submit says, and a missing login.
fn heard(r: &mut Running, res: RoundResult) -> (Said, Option<String>) {
    r.agents += res.dispatched;
    for line in res.errors {
        *r.said.entry(line).or_default() += 1;
    }
    r.all_died |= res.all_died;
    if res.limit.is_some() {
        r.limit.clone_from(&res.limit);
    }
    let said = Said {
        degraded: res.degraded,
        abandoned: res.abandoned,
        died: res.died,
        limit: res.limit,
        resume: false,
        agents: r.agents,
    };
    (said, res.login)
}

/// A round through the host's backend, each process told the plugin root.
async fn round_of(ctx: &RoundCtx<'_>, tasks: &[Task], round: usize) -> RoundResult {
    let env = vec![(
        "CLAUDE_PLUGIN_ROOT".to_owned(),
        ctx.root.display().to_string(),
    )];
    let command = ctx.host.command.clone();
    match ctx.host.kind {
        HostKind::Codex => {
            let codex = Codex {
                command,
                env,
                ..Codex::default()
            };
            run_round(codex, tasks, round, ctx).await
        }
        HostKind::Pi => {
            let pi = Pi {
                command,
                env,
                ..Pi::default()
            };
            run_round(pi, tasks, round, ctx).await
        }
        HostKind::OpenCode if let Some(delegate) = &ctx.host.delegate => {
            delegate.name(tasks);
            run_round(delegate.clone(), tasks, round, ctx).await
        }
        HostKind::OpenCode => {
            let opencode = OpenCode {
                command,
                env,
                archived: ctx.host.archived,
                ..OpenCode::default()
            };
            run_round(opencode, tasks, round, ctx).await
        }
    }
}
