//! Triage's lifecycle adapter to the native host loop (realm @nick/craft, nodes #616, #610).
mod ending;
mod prepare;
mod recovery;

pub(super) use ending::ended;
pub(super) use recovery::recovered;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::Result;
use clap::ValueEnum;
use craft_review::cancel::Cancel;
use craft_triage::step::StartOptions;
use serde_json::Value;

use super::drive::Driver;
use super::events::{Event, Sink};
use super::protocol::{Lifecycle, Protocol, Said};
use super::round::RoundCtx;
use super::{EventFormat, HostArgs};

#[derive(Debug, clap::Args)]
pub(crate) struct RunArgs {
    #[command(flatten)]
    pub(crate) host: HostArgs,
    #[command(flatten)]
    pub(crate) start: crate::triage::StartArgs,
    /// Resume this run; source arguments belong to its start and cannot be replaced.
    #[arg(long, conflicts_with_all = ["run_dir", "report", "pr", "base", "pr_base", "prior_ledger", "prior_decisions"])]
    pub(crate) run: Option<PathBuf>,
    /// Craft's plugin root, found above the executable when absent.
    #[arg(long, env = "CRAFT_ROOT")]
    pub(crate) craft_root: Option<PathBuf>,
}

struct InProcess {
    start: Option<StartOptions>,
}

impl Protocol for InProcess {
    fn lifecycle(&self) -> Lifecycle {
        Lifecycle::Triage
    }

    fn start(&self, _cancel: &Cancel) -> Result<Value> {
        let start = self
            .start
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no triage start"))?;
        Ok(craft_triage::step::start(
            start,
            &crate::filing_worker::BoundedWriter,
        )?)
    }

    fn submit(&self, run: &Path, said: &Said) -> Result<Value> {
        crate::triage::submit(&crate::triage::SubmitArgs {
            run: run.to_owned(),
            answers: None,
            degraded: said.degraded.clone(),
            limit: said.limit.clone(),
            resume: said.resume,
            abandoned: said.abandoned.clone(),
        })
    }

    fn status(&self, run: &Path) -> Result<Value> {
        crate::triage::status(run)
    }

    fn comment(&self, _run: &Path) -> Result<Value> {
        anyhow::bail!("triage returns a plan for the main session; it publishes nothing")
    }

    fn unfinished(&self, _run: &Path, _not_run: &[&str]) -> Option<Vec<String>> {
        None
    }
}

pub(crate) async fn run(args: RunArgs) -> Result<ExitCode> {
    let sink = Sink {
        json: args.host.events == Some(EventFormat::Json),
    };
    let prepared = match prepare::prepare(args, sink) {
        Ok(p) => p,
        Err(e) => {
            super::say(
                &mut std::io::stdout().lock(),
                &format!("Triage refused: {e:#}. Nothing ran."),
            )?;
            sink.emit(&Event::TriageResult {
                plan_file: None,
                summary: None,
                run: None,
                stopped: None,
                exit_code: 2,
            });
            return Ok(ExitCode::from(2));
        }
    };
    // (realm @nick/craft, node #735)
    let stop = super::stopping();
    let p = prepared;
    let backend = p
        .host
        .kind
        .to_possible_value()
        .map(|v| v.get_name().to_owned())
        .unwrap_or_default();
    let again = |dir: &str| {
        format!(
            "`craft triage run --backend {backend} --run '{}'`",
            dir.replace('\'', r"'\''")
        )
    };
    let log = |line: &str| sink.log(line);
    let emit = |event: Event| sink.emit(&event);
    let proto = InProcess { start: p.start };
    let driver = Driver {
        proto: &proto,
        round: RoundCtx {
            host: &p.host,
            root: &p.root,
            repo: &p.repo,
            concurrency: p.concurrency,
            deadline: None,
            log: &log,
            emit: &emit,
            stop: stop.clone(),
        },
        again: &again,
    };
    let answer = super::ending::drive(&driver, p.resume.as_deref(), false).await;
    super::say(&mut std::io::stdout().lock(), &answer.text)?;
    let code = (*stop.borrow()).unwrap_or(u8::from(!answer.finished));
    let last = answer.step.as_ref();
    let text = |key| {
        last.and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    sink.emit(&Event::TriageResult {
        plan_file: text("planFile"),
        summary: text("summary"),
        run: answer.run,
        stopped: last.and_then(|s| s.get("stopped")).cloned(),
        exit_code: code,
    });
    Ok(ExitCode::from(code))
}
