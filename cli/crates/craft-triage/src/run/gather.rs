//! The Gather phase: one gatherer per source asked for, the report's and the PR's, in that order;
//! a source whose gatherer gave nothing is named as not run.

use crate::TriageError;
use crate::finding::{Finding, Gathered};
use crate::kind::TriageKind;
use crate::prompts::{self, Schema, directive};

use super::{Answers, Args, Ask, Phase, Ready, sonnet};

/// What the gatherers gave: each source that answered, its findings with their source set, and
/// the sources that produced nothing (`report`, `pr`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Got {
    pub gathered: Vec<Gathered>,
    pub raw: Vec<Finding>,
    pub not_run: Vec<String>,
}

/// The sources asked for, each with its gatherer's kind.
fn sources(args: &Args) -> Vec<(&'static str, TriageKind)> {
    let mut out = Vec::new();
    if !args.report.is_empty() {
        out.push(("report", TriageKind::GatherReport));
    }
    if !args.pr.is_empty() {
        out.push(("pr", TriageKind::GatherPr));
    }
    out
}

/// The gatherer of `source`: the report's reads only the caller's file and is pointed at no
/// repository; the PR's is.
fn ask(args: &Args, source: &str, kind: TriageKind) -> Result<Ask, TriageError> {
    let (label, prompt) = if source == "report" {
        ("gather:report", prompts::gather_report(&args.report)?)
    } else {
        let p = prompts::gather_pr(&args.pr)?;
        ("gather:pr", format!("{}{p}", directive(&args.repo)))
    };
    let id = label.replace(':', "-");
    Ok(sonnet(kind, &id, label, prompt, Schema::Raw.value()?))
}

/// The gatherers' findings, or their asks while any is not in.
///
/// # Errors
/// When a prompt or schema cannot be rendered.
pub(crate) fn gather(args: &Args, answers: &dyn Answers) -> Result<Ready<Got>, TriageError> {
    let wanted = sources(args);
    let mut asks = Vec::new();
    let mut got = Got::default();
    for (source, kind) in wanted {
        match answers.answer(&kind) {
            None => asks.push(ask(args, source, kind)?),
            Some(Some(a)) => match Gathered::read(&a, source == "report") {
                Ok(g) => got.gathered.push(g),
                Err(_) => got.not_run.push(source.into()),
            },
            Some(None) => got.not_run.push(source.into()),
        }
    }
    if !asks.is_empty() {
        return Ok(Ready::Ask(Phase::Gather, asks));
    }
    got.raw = got.gathered.iter().flat_map(Gathered::sourced).collect();
    Ok(Ready::Got(got))
}
