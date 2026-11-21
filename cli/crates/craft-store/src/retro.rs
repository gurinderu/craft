//! A version's retro: the finished runs of one craft version summed as the run-store report
//! (`lib/analyze-runs.mjs --version <v>`) sums them — records that carry a schema version and did
//! not die, a resumed run's second record folded into its newest (`lib/run-duplicates.mjs`), develop
//! cycles apart — per workflow, per engine, per lens, and what did not run.

use std::collections::BTreeMap;

use crate::js::{Js, JsString, Obj, Utf16Error};
use crate::record::SEVERITIES;
use crate::tally::{Tally, round2};

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
}

impl Lens {
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
    pub engines: BTreeMap<String, u64>,
    pub lenses: BTreeMap<String, Lens>,
    pub not_run: BTreeMap<String, u64>,
    /// Records of other versions, and of none, read past.
    pub other: u64,
    /// The records of the version that did not finish, apart from every sum.
    pub unfinished: u64,
    /// The records folded into a newer one of the same run.
    pub folded: u64,
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
    let mut kept = Vec::new();
    let mut newest: Vec<(String, Obj)> = Vec::new();
    for r in records {
        let Some(key) = run_key(&r) else {
            kept.push(r);
            continue;
        };
        match newest.iter_mut().find(|(k, _)| *k == key) {
            Some((_, seen)) if r.text_units("ts") > seen.text_units("ts") => *seen = r,
            Some(_) => {}
            None => newest.push((key, r)),
        }
    }
    kept.extend(newest.into_iter().map(|(_, r)| r));
    kept
}

/// The version's finished runs among `records`, a resumed run once.
fn finished_of(
    version: &str,
    records: impl IntoIterator<Item = Obj>,
    retro: &mut Retro,
) -> Vec<Obj> {
    let mut kept = Vec::new();
    for r in records {
        if !r.get("schemaVersion").is_some_and(Js::truthy)
            || r.text_units("craftVersion") != version
        {
            retro.other += 1;
            continue;
        }
        if r.get("partial").is_some_and(Js::truthy) {
            retro.unfinished += 1;
            continue;
        }
        kept.push(r);
    }
    let before = kept.len();
    let folded = fold_runs(kept);
    retro.folded += u64::try_from(before - folded.len()).unwrap_or(u64::MAX);
    folded
}

/// The retro of `version` over every record.
/// # Errors
/// When a report field cannot be represented as Unicode.
pub fn retro(version: &str, records: impl IntoIterator<Item = Obj>) -> Result<Retro, Utf16Error> {
    let mut out = Retro::default();
    for r in finished_of(version, records, &mut out) {
        add_record(&mut out, &r)?;
    }
    Ok(out)
}

/// Add one finished, deduplicated record to a retro.
/// # Errors
/// When a report field cannot be represented as Unicode.
pub fn add_record(out: &mut Retro, r: &Obj) -> Result<(), Utf16Error> {
    if r.text_units("kind") == "develop" {
        return Ok(());
    }
    out.runs += 1;
    *out.engines.entry(engine_key(r)?).or_default() += 1;
    let name = match r.get("name") {
        Some(n) if n.truthy() => n.to_js_string()?,
        _ => "(unknown)".into(),
    };
    let name = if name == "review" && is_cli(r) {
        "review (cli)".into()
    } else {
        name
    };
    let w = out.workflows.entry(name).or_default();
    w.add(r);
    let verdict = r.get("verdict").filter(|v| v.truthy()).map(Js::to_js_text);
    out.partial_coverage +=
        u64::from(verdict.is_some_and(|v| crate::tally::is_incomplete_units(&v)));
    for item in r.get("notRun").and_then(Js::as_arr).unwrap_or(&[]) {
        *out.not_run.entry(item.to_js_string()?).or_default() += 1;
    }
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
