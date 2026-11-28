//! A retro as `craft runs retro` prints it: the summary with what it kept, then engines,
//! workflows, kinds, what did not run and the lenses, each highest first.

use std::io::{self, Write};

use craft_store::filter::Filter;
use craft_store::js::{Js, Obj};
use craft_store::record::SEVERITIES;
use craft_store::retro::Retro;
use craft_store::tally::Tally;

use super::{TALLY_HEAD, line, num, opt, table, tally_cells, tally_obj};

mod kinds;
mod rounds;

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

pub fn retro(out: &mut dyn Write, f: &Filter, r: &Retro, json: bool) -> io::Result<()> {
    if json {
        return retro_json(out, f, r);
    }
    let what = match f.version.as_ref() {
        Some(v) => format!("craft {v}"),
        None => "craft, every version".to_owned(),
    };
    let more: String = kept(f)
        .iter()
        .filter(|(k, _)| *k != "version")
        .map(|(k, v)| format!(" · {k} {v}"))
        .collect();
    writeln!(
        out,
        "{what}{more}: {} finished run(s), {} with partial coverage · {} unfinished set apart · {} folded into a newer record of the same run",
        r.runs, r.partial_coverage, r.unfinished, r.folded
    )?;
    writeln!(out, "\nEngines")?;
    let mut engines: Vec<(&String, &u64)> = r.engines.iter().collect();
    engines.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    table(
        out,
        &engines
            .iter()
            .map(|(e, n)| vec![n.to_string(), (*e).clone()])
            .collect::<Vec<_>>(),
    )?;
    writeln!(out, "\nWorkflows")?;
    let mut cells = vec![TALLY_HEAD.map(String::from).to_vec()];
    let mut flows: Vec<(&String, &Tally)> = r.workflows.iter().collect();
    flows.sort_by_key(|f| std::cmp::Reverse(f.1.runs));
    cells.extend(flows.iter().map(|(g, t)| tally_cells(g, t)));
    table(out, &cells)?;
    kinds::text(out, r)?;
    writeln!(out, "\nNot run")?;
    let mut not_run: Vec<(&String, &u64)> = r.not_run.iter().collect();
    not_run.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    table(
        out,
        &not_run
            .iter()
            .map(|(w, n)| vec![n.to_string(), (*w).clone()])
            .collect::<Vec<_>>(),
    )?;
    writeln!(out, "\nLenses")?;
    let mut lenses: Vec<_> = r.lenses.iter().collect();
    lenses.sort_by(|a, b| b.1.findings.total_cmp(&a.1.findings).then(a.0.cmp(b.0)));
    let mut cells = vec![
        "LENS RUNS DEAD FINDINGS CRIT HIGH MED LOW INFO REFUTE REFUTED/CANDIDATES UNVERIFIED"
            .split(' ')
            .map(String::from)
            .collect::<Vec<_>>(),
    ];
    for (name, l) in lenses {
        let mut row = vec![
            name.clone(),
            l.runs.to_string(),
            l.dead.to_string(),
            num(l.findings),
        ];
        row.extend(l.by_severity.iter().map(|n| num(*n)));
        row.push(opt(l.refute_rate()));
        row.push(format!(
            "{}/{}",
            num(l.refuted),
            num(l.confirmed + l.suspected + l.refuted)
        ));
        row.push(num(l.unverified));
        cells.push(row);
    }
    table(out, &cells)?;
    rounds::text(out, r)
}

fn retro_json(out: &mut dyn Write, f: &Filter, r: &Retro) -> io::Result<()> {
    #[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
    let n = |c: u64| Js::Num(c as f64);
    let mut summary = Obj::new()
        .with("section", Js::str("summary"))
        .with("version", f.version.as_ref().map_or(Js::Null, Js::str));
    for (k, v) in kept(f).into_iter().filter(|(k, _)| *k != "version") {
        summary.set(k, Js::str(v));
    }
    let summary = summary
        .with("runs", n(r.runs))
        .with("partialCoverage", n(r.partial_coverage))
        .with("unfinished", n(r.unfinished))
        .with("folded", n(r.folded));
    line(out, summary)?;
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
    for (name, l) in &r.lenses {
        let mut sev = Obj::new();
        for (s, v) in SEVERITIES.iter().zip(l.by_severity) {
            sev.set(*s, Js::Num(v));
        }
        let o = Obj::new()
            .with("section", Js::str("lens"))
            .with("lens", Js::str(name))
            .with("runs", n(l.runs))
            .with("dead", n(l.dead))
            .with("findings", Js::Num(l.findings))
            .with("bySeverity", Js::Obj(sev))
            .with("refuted", Js::Num(l.refuted))
            .with("candidates", Js::Num(l.confirmed + l.suspected + l.refuted))
            .with("refuteRate", l.refute_rate().map_or(Js::Null, Js::Num))
            .with("unverified", Js::Num(l.unverified));
        line(out, o)?;
    }
    rounds::json(out, r)
}
