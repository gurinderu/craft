//! `craft runs enrich-cost --run-id <wf_…>`: every record a finished Workflow run filed gets the
//! real cost of its own slice of the run's agents (realm @nick/craft, nodes #393, #389, #98, #357).
//! The engine sandbox cannot see its run id or the transcripts, so the launcher runs this after
//! the run has ended. Every record is read and every slice measured before any write, so a refusal
//! leaves all of them as they were; the cost is replaced, never appended, so a re-run re-slices
//! and re-sums.

mod agents;
mod count;
mod date;
pub mod fold;
pub mod problem;
mod run_dir;
mod slices;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub use count::{COST_RULE, COST_RULE_PER_LINE, count_usage};
pub(crate) use run_dir::entries as entries_of;
pub use run_dir::find_run_dir;

use crate::checkpoint::contains_path;
use crate::js::{Js, Obj, number_text};

/// What one enrich-cost said: its lines for stdout and its warnings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Enriched {
    pub lines: Vec<String>,
    pub warnings: Vec<String>,
}

/// A record off a logger's transcript, read only inside the store.
fn read_record(store: &Path, file: &str) -> Result<Obj, String> {
    if !contains_path(store, Path::new(file)) {
        let shown: String = file.replace(['\r', '\n'], " ").chars().take(200).collect();
        return Err(format!(
            "record {shown} is outside the store {} — refusing the run",
            store.display()
        ));
    }
    crate::amend::read_object(Path::new(file))
}

fn absorbed_js(a: &[slices::Absorbed]) -> Js {
    Js::Arr(
        a.iter()
            .map(|x| {
                Js::Obj(
                    Obj::new()
                        .with("engine", Js::str(&x.engine))
                        .with("instance", Js::str(&x.instance))
                        .with("agents", Js::Num(f64::from(x.agents))),
                )
            })
            .collect(),
    )
}

fn num(cost: &Obj, k: &str) -> String {
    number_text(cost.get(k).and_then(Js::as_num).unwrap_or(0.0))
}

fn cost_line(cost: &Obj) -> String {
    let skipped = cost.get("skipped").map_or(String::new(), |_| {
        format!(" ({} unreadable, skipped)", num(cost, "skipped"))
    });
    format!(
        "{} agent(s){skipped}: cacheRead {}, cacheWrite {}, input {}, output {}, total {} tok (real cost; outputTokens is only the turn's indicative spend)",
        num(cost, "agents"),
        num(cost, "cacheRead"),
        num(cost, "cacheWrite"),
        num(cost, "input"),
        num(cost, "output"),
        num(cost, "total"),
    )
}

/// `craft runs enrich-cost --run-dir <d> --record <f>`: every transcript under `run_dir` summed into
/// the one record named, its `cost` replaced (`source` the directory's name, no slice) — the form
/// that re-costs a record whose run cannot be sliced, such as one an older engine filed. Under
/// `store`'s lock when the record lies inside it.
///
/// # Errors
/// When the directory cannot be read, holds no readable transcript, or the record cannot be read
/// or written.
pub fn enrich_dir(run_dir: &Path, record: &Path, store: &Path) -> Result<Enriched, String> {
    let names = run_dir::transcripts(run_dir)?;
    if names.is_empty() {
        return Err(format!(
            "no agent-*.jsonl transcripts under {}",
            run_dir.display()
        ));
    }
    let absolute = crate::git::lexical(
        &std::path::absolute(run_dir).unwrap_or_else(|_| run_dir.to_path_buf()),
    );
    let source = absolute
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let mut said = Enriched::default();
    let cost = count::measure(run_dir, &names, &mut said.warnings, &source)?;
    let inside = contains_path(store, record).then_some(store);
    let warned = crate::amend::rewrite(inside, &[record], &mut |_, mut r| {
        r.set("cost", Js::Obj(cost.clone()));
        Ok(r)
    })?;
    said.warnings.extend(warned);
    said.lines.push(format!(
        "enriched {} — {}",
        record.display(),
        cost_line(&cost)
    ));
    Ok(said)
}

/// Folds the run's real cost into each record it filed in `store`.
///
/// # Errors
/// When the run's directory cannot be found or holds no transcript, a slice has no readable
/// transcript, a record cannot be read or lies outside the store, the slicing refuses the run, or
/// a write does not land.
pub fn enrich_run(run_id: &str, claude_home: &Path, store: &Path) -> Result<Enriched, String> {
    let run_dir = find_run_dir(run_id, claude_home)?;
    let names = run_dir::transcripts(&run_dir)?;
    if names.is_empty() {
        return Err(format!(
            "no agent-*.jsonl transcripts under {}",
            run_dir.display()
        ));
    }
    let mut said = Enriched::default();
    let agents: Vec<agents::RunAgent> = names
        .iter()
        .map(|n| agents::read_agent(&run_dir, n))
        .collect();
    let mut records: HashMap<String, Obj> = HashMap::new();
    let mut name_of = |file: &str| -> Result<Option<String>, String> {
        if !records.contains_key(file) {
            records.insert(file.to_owned(), read_record(store, file)?);
        }
        Ok(records
            .get(file)
            .and_then(|r| r.get("name"))
            .and_then(Js::as_str)
            .map(str::to_owned))
    };
    let slices = slices::slice_by_engine(&agents, &mut name_of, &mut said.warnings)?;
    let of = slices.len();
    let mut costs: Vec<(PathBuf, Obj)> = Vec::new();
    for (i, s) in slices.iter().enumerate() {
        let mut cost = count::measure(&run_dir, &s.transcripts, &mut said.warnings, run_id)?;
        #[expect(
            clippy::cast_precision_loss,
            reason = "a run files a handful of records"
        )]
        let mut slice = Obj::new()
            .with("index", Js::Num((i + 1) as f64))
            .with("of", Js::Num(of as f64));
        if s.tail > 0 {
            slice.set("tail", Js::Num(f64::from(s.tail)));
        }
        cost.set("slice", Js::Obj(slice));
        if !s.absorbed.is_empty() {
            cost.set("absorbed", absorbed_js(&s.absorbed));
        }
        let mut tail = String::new();
        if s.tail > 0 {
            tail.push_str(&format!(", {} after the last record's logger", s.tail));
        }
        if !s.absorbed.is_empty() {
            let n: u32 = s.absorbed.iter().map(|a| a.agents).sum();
            tail.push_str(&format!(", {n} of nested engines that filed no record"));
        }
        said.lines.push(format!(
            "enriched {} — slice {}/{of}{tail}: {}",
            s.record,
            i + 1,
            cost_line(&cost)
        ));
        costs.push((PathBuf::from(&s.record), cost));
    }
    said.warnings
        .extend(crate::amend::set_field(store, "cost", &costs)?);
    said.lines.insert(
        0,
        format!("run {run_id} ({}): {of} record(s)", run_dir.display()),
    );
    Ok(said)
}
