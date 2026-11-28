//! A retro as `craft runs retro` prints it: the summary with what it kept, then engines,
//! workflows, kinds, what did not run and the lenses, each highest first.

use std::io::{self, Write};

use craft_store::filter::Filter;
use craft_store::js::{Js, Obj};
use craft_store::record::SEVERITIES;
use craft_store::retro::Retro;
use craft_store::retro::unfinished::slice::Slice;
use craft_store::tally::Tally;

use super::{TALLY_HEAD, line, num, opt, table, tally_cells, tally_obj};

mod cycles;
mod flows;
mod kinds;
mod listed;
mod noise;
mod recall;
mod rounds;
mod signals;

/// A count as JSON.
#[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
pub(super) fn count(c: u64) -> Js {
    Js::Num(c as f64)
}

/// Two texts by their UTF-16 code units, as JavaScript orders strings, no locale.
pub(super) fn utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A count per key, highest first, ties by [`utf16`].
pub(super) fn ranked(m: &std::collections::BTreeMap<String, u64>) -> Vec<(&String, &u64)> {
    let mut v: Vec<_> = m.iter().collect();
    v.sort_by(|a, b| b.1.cmp(a.1).then_with(|| utf16(a.0, b.0)));
    v
}

/// The lenses highest yield first, ties by [`utf16`].
fn lenses_ranked(r: &Retro) -> Vec<(&String, &craft_store::retro::Lens)> {
    let mut lenses: Vec<_> = r.lenses.iter().collect();
    lenses.sort_by(|a, b| {
        b.1.findings
            .total_cmp(&a.1.findings)
            .then_with(|| utf16(a.0, b.0))
    });
    lenses
}

/// What `f` keeps, each filter by its flag's name, the version first.
fn kept(f: &Filter) -> Vec<(&'static str, &String)> {
    [
        ("version", &f.version),
        ("project", &f.project),
        ("branch", &f.branch),
        ("name", &f.name),
        ("since", &f.since),
        ("until", &f.until),
        ("verdict", &f.verdict),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.as_ref().map(|v| (k, v)))
    .collect()
}

pub fn retro(out: &mut dyn Write, slice: &Slice<'_>, r: &Retro, json: bool) -> io::Result<()> {
    let f = slice.filter;
    if json {
        return retro_json(out, slice, r);
    }
    let what = match f.version.as_ref() {
        Some(v) => format!("craft {v}"),
        None => "craft, every version".to_owned(),
    };
    let mut more: String = kept(f)
        .iter()
        .filter(|(k, _)| *k != "version")
        .map(|(k, v)| format!(" · {k} {v}"))
        .collect();
    if let Some(e) = slice.engine {
        more.push_str(&format!(" · engine {e}"));
    }
    writeln!(
        out,
        "{what}{more}: {} finished run(s), {} with partial coverage · {} unfinished set apart · {} folded into a newer record of the same run · {} without a schema version read past",
        r.runs, r.partial_coverage, r.unfinished, r.folded, r.legacy
    )?;
    writeln!(out, "\nEngines")?;
    if r.unattributed > 0 {
        writeln!(
            out,
            "{} run(s) name no engine revision: which engine ran them is unknown",
            r.unattributed
        )?;
    }
    table(
        out,
        &ranked(&r.engines)
            .iter()
            .map(|(e, n)| vec![n.to_string(), (*e).clone()])
            .collect::<Vec<_>>(),
    )?;
    for (v, revs) in noise::collisions(r) {
        let revs: Vec<&str> = revs.iter().map(|s| s.as_str()).collect();
        writeln!(
            out,
            "craft {v} spans {} engine revisions ({}): slice by engine, not version",
            revs.len(),
            revs.join(", ")
        )?;
    }
    writeln!(out, "\nWorkflows")?;
    let mut cells = vec![TALLY_HEAD.map(String::from).to_vec()];
    let mut flows: Vec<(&String, &Tally)> = r.workflows.iter().collect();
    flows.sort_by(|a, b| b.1.runs.cmp(&a.1.runs).then_with(|| utf16(a.0, b.0)));
    cells.extend(flows.iter().map(|(g, t)| tally_cells(g, t)));
    table(out, &cells)?;
    flows::text(out, r, &flows.iter().map(|(g, _)| *g).collect::<Vec<_>>())?;
    kinds::text(out, r)?;
    writeln!(out, "\nNot run")?;
    table(
        out,
        &ranked(&r.not_run)
            .iter()
            .map(|(w, n)| vec![n.to_string(), (*w).clone()])
            .collect::<Vec<_>>(),
    )?;
    signals::text(out, r)?;
    recall::text(out, r)?;
    cycles::text(out, r)?;
    writeln!(out, "\nLenses")?;
    let lenses = lenses_ranked(r);
    let mut cells = vec![
        "LENS RUNS DEAD FINDINGS PER-RUN CRIT HIGH MED LOW INFO REFUTE REFUTED/CANDIDATES BASIS UNVERIFIED"
            .split(' ')
            .map(String::from)
            .collect::<Vec<_>>(),
    ];
    for (name, l) in &lenses {
        let mut row = vec![
            (*name).clone(),
            l.runs.to_string(),
            l.dead.to_string(),
            num(l.findings),
            num(l.findings_per_run()),
        ];
        row.extend(l.by_severity.iter().map(|n| num(*n)));
        row.push(opt(l.refute_rate()));
        row.push(format!("{}/{}", num(l.refuted), num(l.candidates())));
        row.push(l.refute_basis().unwrap_or("-").to_owned());
        row.push(num(l.unverified));
        cells.push(row);
    }
    table(out, &cells)?;
    noise::text(out, &lenses)?;
    rounds::text(out, r)?;
    listed::text(out, r)
}

fn retro_json(out: &mut dyn Write, slice: &Slice<'_>, r: &Retro) -> io::Result<()> {
    let f = slice.filter;
    #[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
    let n = |c: u64| Js::Num(c as f64);
    let mut summary = Obj::new()
        .with("section", Js::str("summary"))
        .with("version", f.version.as_ref().map_or(Js::Null, Js::str));
    for (k, v) in kept(f).into_iter().filter(|(k, _)| *k != "version") {
        summary.set(k, Js::str(v));
    }
    if let Some(e) = slice.engine {
        summary.set("engine", Js::str(e));
    }
    let summary = summary
        .with("runs", n(r.runs))
        .with("partialCoverage", n(r.partial_coverage))
        .with("unfinished", n(r.unfinished))
        .with("folded", n(r.folded))
        .with("legacy", n(r.legacy))
        .with("unattributed", n(r.unattributed));
    line(out, summary)?;
    for (v, revs) in noise::collisions(r) {
        let o = Obj::new()
            .with("section", Js::str("versionCollision"))
            .with("version", Js::str(v))
            .with(
                "revisions",
                Js::Arr(revs.into_iter().map(Js::str).collect()),
            );
        line(out, o)?;
    }
    for (e, c) in &r.engines {
        line(
            out,
            Obj::new()
                .with("section", Js::str("engine"))
                .with("engine", Js::str(e))
                .with("runs", n(*c)),
        )?;
    }
    for (w, t) in &r.workflows {
        let mut o = Obj::new()
            .with("section", Js::str("workflow"))
            .with("name", Js::str(w));
        o.spread(&tally_obj(t));
        if let Some(f) = r.flows.get(w) {
            flows::json(&mut o, f);
        }
        line(out, o)?;
    }
    kinds::json(out, r)?;
    for (w, c) in &r.not_run {
        line(
            out,
            Obj::new()
                .with("section", Js::str("notRun"))
                .with("what", Js::str(w))
                .with("runs", n(*c)),
        )?;
    }
    signals::json(out, r)?;
    recall::json(out, r)?;
    cycles::json(out, r)?;
    let lenses = lenses_ranked(r);
    for (name, l) in &lenses {
        let mut sev = Obj::new();
        for (s, v) in SEVERITIES.iter().zip(l.by_severity) {
            sev.set(*s, Js::Num(v));
        }
        let o = Obj::new()
            .with("section", Js::str("lens"))
            .with("lens", Js::str(*name))
            .with("runs", n(l.runs))
            .with("dead", n(l.dead))
            .with("findings", Js::Num(l.findings))
            .with("findingsPerRun", Js::Num(l.findings_per_run()))
            .with("bySeverity", Js::Obj(sev))
            .with("confirmed", Js::Num(l.confirmed))
            .with("suspected", Js::Num(l.suspected))
            .with("refuted", Js::Num(l.refuted))
            .with("candidates", Js::Num(l.candidates()))
            .with("refuteRate", l.refute_rate().map_or(Js::Null, Js::Num))
            .with("refuteBasis", l.refute_basis().map_or(Js::Null, Js::str))
            .with("unverified", Js::Num(l.unverified));
        line(out, o)?;
    }
    noise::json(out, &lenses)?;
    rounds::json(out, r)?;
    listed::json(out, r)
}
