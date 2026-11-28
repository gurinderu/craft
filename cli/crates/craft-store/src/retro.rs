//! A retro: the finished runs a reader keeps summed as the retired JavaScript run-store report
//! (`analyze-runs.mjs`) summed them, its figures frozen in `content/parity/retro-cases.json`
//! (realm @nick/craft, nodes #540, #562) — records that carry a schema version and did not die, a
//! resumed run's second record folded into its newest and a stopped part into the record its resume
//! finished ([`crate::parts`]) — per workflow ([`flow`]), kind, engine and lens, what did not run
//! and what the runs did not do ([`signals`]), what they recalled ([`memory`]), their memory
//! contradictions, sorting and depth; develop cycles apart ([`develop`]), and a retro's mark
//! ([`DONE_KIND`]) in none of it.

use std::collections::{BTreeMap, BTreeSet};

use crate::js::{Js, JsString, Obj, Utf16Error};
use crate::record::SEVERITIES;
use crate::tally::{Tally, round2};

mod beside;
pub mod contradictions;
pub mod depth;
pub mod develop;
pub mod flow;
mod kinds;
pub mod memory;
pub mod pairs;
pub mod plan;
mod rounds;
pub mod signals;
pub mod sorting;
pub mod unfinished;

/// The kind of the record a finished retro files (`craft runs retro-done`), which marks when this
/// repository's runs were last read; no reader counts it as a run (realm @nick/craft, node #658).
pub const DONE_KIND: &str = "retro";

/// The record a finished retro files.
#[must_use]
pub fn done_record() -> Obj {
    Obj::new()
        .with("schemaVersion", Js::Num(1.0))
        .with("kind", Js::str(DONE_KIND))
        .with("name", Js::str(DONE_KIND))
}

/// Whether a record counts as a run: neither a develop cycle nor a retro's mark.
#[must_use]
pub fn is_run(r: &Obj) -> bool {
    let kind = r.text_units("kind");
    kind != "develop" && kind != DONE_KIND
}

pub use flow::{Flow, Gate, basis};
pub use kinds::{Deferred, Kind};
pub use rounds::{Apart, Round};

/// One lens's yield over the runs it ran in.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Lens {
    pub runs: u64,
    pub dead: u64,
    pub findings: f64,
    pub confirmed: f64,
    pub suspected: f64,
    pub refuted: f64,
    pub unverified: f64,
    pub by_severity: [f64; 5],
    /// The rows that carried `unverifiedCount`, and those that predate it.
    pub tracked: u64,
    pub legacy: u64,
}

impl Lens {
    /// The candidates verification judged.
    #[must_use]
    pub fn candidates(&self) -> f64 {
        self.confirmed + self.suspected + self.refuted
    }

    /// What the refute rate is over ([`basis`]).
    #[must_use]
    pub fn refute_basis(&self) -> Option<&'static str> {
        basis(self.tracked, self.legacy)
    }

    /// Findings per run that ran, to two places.
    #[must_use]
    pub fn findings_per_run(&self) -> f64 {
        #[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
        let runs = self.runs as f64;
        if self.runs == 0 {
            0.0
        } else {
            round2(self.findings / runs)
        }
    }

    /// Refuted over the verified candidates, to two places; `None` when none was verified.
    #[must_use]
    pub fn refute_rate(&self) -> Option<f64> {
        let candidates = self.confirmed + self.suspected + self.refuted;
        (candidates > 0.0).then(|| round2(self.refuted / candidates))
    }
}

/// What the retro of one version sums.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Retro {
    pub runs: u64,
    pub partial_coverage: u64,
    pub workflows: BTreeMap<String, Tally>,
    /// The runs by kind: the workflow, a review's depth and lens scope ([`kinds`]).
    pub kinds: BTreeMap<String, Kind>,
    /// The runs filed in parts whose cost waits for [`settle`].
    pub deferred: Vec<Deferred>,
    pub engines: BTreeMap<String, u64>,
    pub lenses: BTreeMap<String, Lens>,
    pub not_run: BTreeMap<String, u64>,
    /// Records of other versions, and of none, read past.
    pub other: u64,
    /// The records of the version that did not finish, apart from every sum.
    pub unfinished: u64,
    /// The records folded into a newer one of the same run.
    pub folded: u64,
    /// Each lens round's yield after the dedup and verification, by round number.
    pub rounds: BTreeMap<u64, Round>,
    /// The confirmed of the gate's seeds and of no lens round.
    pub apart: Apart,
    /// Per workflow, what its rates are over, its full-plan cost and surface gate.
    pub flows: BTreeMap<String, Flow>,
    pub signals: signals::Signals,
    pub memory: memory::Memory,
    pub sorting: sorting::Sorting,
    pub develop: develop::Develop,
    pub depth: depth::Depth,
    pub contradictions: contradictions::Contradictions,
    /// The contradictions settled once every record is read, `[js, cli]` ([`settle_chains`]).
    pub chains: [contradictions::Tally; 2],
    /// Runs whose record names no engine revision.
    pub unattributed: u64,
    /// Per craft version, the engine revisions (`r<N>`, `r?`) its runs carry.
    pub revisions: BTreeMap<String, BTreeSet<String>>,
    /// Records with no schema version, read past.
    pub legacy: u64,
    /// The records of runs that did not finish, listed: the slice's, its unattributed, and the
    /// rebuilt ones hidden because their run finished after all ([`unfinished`]).
    pub listed: Vec<Obj>,
    pub listed_unattributed: u64,
    pub listed_twins: u64,
}

/// Whether the run is the CLI's (`reviewChain`).
#[must_use]
pub fn is_cli(r: &Obj) -> bool {
    r.text_units("name") == "cli-review" || r.text_units("driver") == "cli"
}

/// `engineKey`: the host the run's tasks ran in (`+cli` for the CLI's), its version and revision.
/// # Errors
/// When the engine's name cannot cross the Unicode-only report boundary.
pub fn engine_key(r: &Obj) -> Result<String, Utf16Error> {
    engine_text(r).to_utf8()
}

fn engine_text(r: &Obj) -> JsString {
    let runtime = match r.get("runtime") {
        Some(v) if v.truthy() => v.to_js_text(),
        _ => "unknown-runtime".into(),
    };
    let version = match r.get("craftVersion") {
        Some(v) if v.truthy() => v.to_js_text(),
        _ => "unversioned".into(),
    };
    let int = |k: &str| r.get(k).and_then(Js::as_num).filter(|n| n.fract() == 0.0);
    let rev = int("workflowEngineRevision")
        .or_else(|| int("engineRevision"))
        .map_or_else(
            || "r?".to_owned(),
            |n| format!("r{}", crate::js::number_text(n)),
        );
    let cli = if is_cli(r) { "+cli" } else { "" };
    JsString::join(
        &[
            runtime,
            cli.into(),
            " ".into(),
            version,
            " ".into(),
            rev.into(),
        ],
        "",
    )
}

/// The key a resumed run's two records share (`runKey`), `None` when the record is not foldable.
#[must_use]
pub fn run_key(r: &Obj) -> Option<String> {
    let first = |ks: &[&str]| {
        ks.iter()
            .find_map(|k| r.get(k).filter(|v| v.truthy()))
            .map(Js::to_js_text)
            .unwrap_or_default()
    };
    let head = first(&["head", "commit"]);
    let findings = r.get("findings").and_then(Js::as_obj);
    let total = findings.and_then(|f| f.get("total")).and_then(Js::as_num);
    let truthy = |k: &str| r.get(k).is_some_and(Js::truthy);
    let foldable = !head.is_empty()
        && truthy("filesDigest")
        && truthy("branch")
        && !truthy("nested")
        && !truthy("partial")
        && total.is_some_and(|t| t != 0.0 && !t.is_nan());
    if !foldable {
        return None;
    }
    let or_null = |v: Option<&Js>| match v {
        None => Js::Null,
        Some(v) => v.clone(),
    };
    let mut key = vec![Js::str(engine_text(r))];
    for k in ["kind", "name", "driver", "project"] {
        key.push(or_null(r.get(k)));
    }
    key.push(Js::str(head));
    key.push(or_null(r.get("filesDigest")));
    key.push(or_null(r.get("round")));
    let kept = [
        "base",
        "path",
        "strict",
        "dirty",
        "lensScope",
        "intentDigest",
        "specDigest",
        "unitScope",
    ];
    key.extend(kept.iter().map(|k| or_null(r.get(k))));
    let reason = r
        .get("reReview")
        .and_then(Js::as_obj)
        .map(|rr| or_null(rr.get("reason")));
    key.push(reason.unwrap_or(Js::Null));
    key.push(or_null(findings.and_then(|f| f.get("bySeverity"))));
    Some(Js::Arr(key).compact())
}

/// Folds repeated records of the same resumed run, retaining the newest record.
#[must_use]
pub fn fold_runs(records: Vec<Obj>) -> Vec<Obj> {
    let named = records.into_iter().map(|r| (String::new(), r)).collect();
    fold_named(named).into_iter().map(|(_, r)| r).collect()
}

/// [`fold_runs`] over records each with its id, which the newest keeps.
fn fold_named(records: Vec<(String, Obj)>) -> Vec<(String, Obj)> {
    let mut kept = Vec::new();
    let mut newest: Vec<(String, (String, Obj))> = Vec::new();
    for (id, r) in records {
        let Some(key) = run_key(&r) else {
            kept.push((id, r));
            continue;
        };
        match newest.iter_mut().find(|(k, _)| *k == key) {
            Some((_, seen)) if r.text_units("ts") > seen.1.text_units("ts") => *seen = (id, r),
            Some(_) => {}
            None => newest.push((key, (id, r))),
        }
    }
    kept.extend(newest.into_iter().map(|(_, r)| r));
    kept
}

/// The version's finished runs among `records`, a resumed run once: a re-filed record into its
/// newest, a stopped part into the record its resume finished ([`crate::parts`]).
fn finished_of(
    version: &str,
    records: impl IntoIterator<Item = Obj>,
    retro: &mut Retro,
) -> Result<(Vec<(String, Obj)>, crate::parts::Parts), Utf16Error> {
    let records: Vec<Obj> = records.into_iter().collect();
    let mut parts = crate::parts::Parts::default();
    let live = |r: &Obj| {
        r.get("schemaVersion").is_some_and(Js::truthy) && !r.get("partial").is_some_and(Js::truthy)
    };
    for (i, r) in records.iter().enumerate().filter(|(_, r)| live(r)) {
        parts.note(&i.to_string(), r);
    }
    let mut kept = Vec::new();
    let mut held = BTreeMap::new();
    for (i, r) in records.into_iter().enumerate() {
        let inside = r.text_units("craftVersion") == version;
        if live(&r) && parts.hold(&i.to_string(), &r, inside)? {
            retro.other += u64::from(!inside);
            held.insert(i.to_string(), r);
        } else if !r.get("schemaVersion").is_some_and(Js::truthy) || !inside {
            retro.other += 1;
        } else if r.get("partial").is_some_and(Js::truthy) {
            retro.unfinished += 1;
        } else {
            kept.push((i.to_string(), r));
        }
    }
    let (standing, folded) = parts.standing();
    retro.folded += folded;
    kept.extend(
        standing
            .iter()
            .filter_map(|(_, _, name)| held.remove(name).map(|r| (name.clone(), r))),
    );
    let before = kept.len();
    let folded = fold_named(kept);
    retro.folded += u64::try_from(before - folded.len()).unwrap_or(u64::MAX);
    Ok((folded, parts))
}

/// Prices the runs filed in parts once every record is read, by their parts' shares summed once.
pub fn settle(retro: &mut Retro, parts: &crate::parts::Parts) {
    for mut d in std::mem::take(&mut retro.deferred) {
        let flow = d.flow.take();
        let cost = kinds::settle(&mut retro.kinds, d, parts);
        if let Some((name, input)) = flow {
            let plan = &mut retro.flows.entry(name).or_default().plan;
            plan.add(&input, cost.as_ref());
        }
    }
}

/// The retro of `version` over every record.
/// # Errors
/// When a report field cannot be represented as Unicode.
pub fn retro(version: &str, records: impl IntoIterator<Item = Obj>) -> Result<Retro, Utf16Error> {
    let mut out = Retro::default();
    let (finished, parts) = finished_of(version, records, &mut out)?;
    for (id, r) in &finished {
        add_record(&mut out, id, r)?;
    }
    settle(&mut out, &parts);
    let ledger = |id: &str| {
        finished
            .iter()
            .find(|(i, _)| i == id)
            .and_then(|(_, r)| r.get("ledger").cloned())
    };
    out.chains = out.contradictions.settle(ledger);
    Ok(out)
}

/// Add one finished, deduplicated record to a retro, `id` the one [`crate::parts::Parts::note`]
/// noted it by.
/// # Errors
/// When a report field cannot be represented as Unicode.
pub fn add_record(out: &mut Retro, id: &str, r: &Obj) -> Result<(), Utf16Error> {
    if r.text_units("kind") == "develop" {
        out.develop.add(r);
        return Ok(());
    }
    if !is_run(r) {
        return Ok(());
    }
    out.runs += 1;
    *out.engines.entry(engine_key(r)?).or_default() += 1;
    beside::add(out, id, r)?;
    let name = match r.get("name") {
        Some(n) if n.truthy() => n.to_js_string()?,
        _ => "(unknown)".into(),
    };
    let name = if name == "review" && is_cli(r) {
        "review (cli)".into()
    } else {
        name
    };
    let waiting = out.deferred.len();
    kinds::add((id, r), &name, &mut out.kinds, &mut out.deferred)?;
    beside::flow(out, &name, r, waiting)?;
    let w = out.workflows.entry(name).or_default();
    w.add(r);
    let verdict = r.get("verdict").filter(|v| v.truthy()).map(Js::to_js_text);
    out.partial_coverage +=
        u64::from(verdict.is_some_and(|v| crate::tally::is_incomplete_units(&v)));
    for item in r.get("notRun").and_then(Js::as_arr).unwrap_or(&[]) {
        *out.not_run.entry(item.to_js_string()?).or_default() += 1;
    }
    // A coverage gap (`capped`) is fragility a re-run fixes too, ranked beside what did not run
    // though the record keeps it apart from `notRun`, which marks a run INCOMPLETE; by its lens and
    // kind alone ([`crate::gap::key`]), as its files and errors differ run to run.
    for item in r.get("capped").and_then(Js::as_arr).unwrap_or(&[]) {
        *out.not_run
            .entry(crate::gap::key(&item.to_js_string()?).to_owned())
            .or_default() += 1;
    }
    rounds::add(r, &mut out.rounds);
    rounds::add_apart(r, &mut out.apart);
    lenses_of(r, &mut out.lenses)
}

fn lenses_of(r: &Obj, lenses: &mut BTreeMap<String, Lens>) -> Result<(), Utf16Error> {
    let chain = if is_cli(r) { " (cli)" } else { "" };
    for dim in r.get("dimensions").and_then(Js::as_arr).unwrap_or(&[]) {
        let Some(d) = dim.as_obj() else { continue };
        let name = match d.get("dimension") {
            Some(v) if v.truthy() => v.to_js_string()?,
            _ => "(unnamed)".into(),
        };
        let lens = lenses.entry(format!("{name}{chain}")).or_default();
        if d.get("ran") == Some(&Js::Bool(false)) {
            lens.dead += 1;
            continue;
        }
        let n = |k: &str| {
            d.get(k)
                .and_then(Js::as_num)
                .filter(|n| n.is_finite())
                .unwrap_or(0.0)
        };
        lens.runs += 1;
        lens.findings += n("findingCount");
        lens.confirmed += n("confirmedCount");
        lens.suspected += n("suspectedCount");
        lens.refuted += n("refutedCount");
        lens.unverified += n("unverifiedCount");
        if d.get("unverifiedCount").and_then(Js::as_num).is_some() {
            lens.tracked += 1;
        } else {
            lens.legacy += 1;
        }
        let by = d.get("bySeverity").and_then(Js::as_obj);
        for (i, s) in SEVERITIES.iter().enumerate() {
            let v = by
                .and_then(|b| b.get(s))
                .and_then(Js::as_num)
                .filter(|n| n.is_finite());
            if let Some(slot) = lens.by_severity.get_mut(i) {
                *slot += v.unwrap_or(0.0);
            }
        }
    }
    Ok(())
}
