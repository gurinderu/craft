//! Each workflow's sums beside its verdicts: what its refute rate is over and its thinned panels,
//! then over its full-plan runs the token pool, the real cost by token part and the surface gate.

use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::plan::{PARTS, Plan, avg};
use craft_store::retro::{Flow, Retro};

mod gate;

use gate::gate_json;

use super::super::{num, opt, table};
use super::{count, ranked};

fn or_null(v: Option<f64>) -> Js {
    v.map_or(Js::Null, Js::Num)
}

fn plan_json(p: &Plan) -> (Obj, Obj) {
    let mut pool = Obj::new();
    for (k, at) in ["firstPass", "reReview", "unclassified"]
        .iter()
        .zip(p.pools)
    {
        pool.set(*k, or_null(avg(at.tokens, at.runs)));
        pool.set(format!("{k}Runs"), count(at.runs));
    }
    let per = p.per_run();
    let mut cost = Obj::new().with("runs", count(p.priced));
    for (i, k) in PARTS.iter().enumerate() {
        cost.set(
            *k,
            or_null(per.and_then(|(parts, _)| parts.get(i).copied())),
        );
    }
    cost.set("total", or_null(per.map(|(_, t)| t)));
    let mut apart = Obj::new();
    for (why, n) in &p.apart {
        apart.set(why.as_str(), count(*n));
    }
    cost.set("apart", Js::Obj(apart));
    (pool, cost)
}

/// The workflow line's fields beyond its tally.
pub fn json(o: &mut Obj, f: &Flow) {
    o.set("refuteBasis", f.refute_basis().map_or(Js::Null, Js::str));
    o.set("thinned", Js::Num(f.thinned));
    o.set("thinnedRuns", count(f.thinned_runs));
    o.set("thinnedMeasured", count(f.thinned_measured));
    let (pool, cost) = plan_json(&f.plan);
    o.set("pool", Js::Obj(pool));
    o.set("cost", Js::Obj(cost));
    o.set("surfaceGate", Js::Obj(gate_json(&f.gate)));
}

fn pool_cell(p: &Plan) -> String {
    let cells: Vec<String> = p
        .pools
        .iter()
        .map(|at| format!("{} ({})", opt(avg(at.tokens, at.runs)), at.runs))
        .collect();
    cells.join(" / ")
}

fn apart_cell(p: &Plan) -> String {
    let why: Vec<String> = p
        .apart
        .iter()
        .map(|(w, n)| format!("{} {n}", w.as_str()))
        .collect();
    if why.is_empty() {
        "-".into()
    } else {
        why.join(", ")
    }
}

/// The workflows' verification, full-plan cost and surface gate as tables.
pub fn text(out: &mut dyn Write, r: &Retro, flows: &[&String]) -> io::Result<()> {
    let empty = Flow::default();
    let of = |name: &String| r.flows.get(name).unwrap_or(&empty);
    writeln!(
        out,
        "\nVerification (refute basis; panels thinned by off-schema votes)"
    )?;
    let mut cells = vec![
        "WORKFLOW BASIS THINNED THINNED-RUNS MEASURED"
            .split(' ')
            .map(String::from)
            .collect::<Vec<_>>(),
    ];
    for name in flows {
        let f = of(name);
        cells.push(vec![
            (*name).clone(),
            f.refute_basis().unwrap_or("-").to_owned(),
            num(f.thinned),
            f.thinned_runs.to_string(),
            f.thinned_measured.to_string(),
        ]);
    }
    table(out, &cells)?;
    writeln!(out, "\nFull-plan cost (light runs apart; tokens per run)")?;
    let head = "WORKFLOW PRICED CACHE-READ CACHE-WRITE INPUT OUTPUT TOTAL LEFT-OUT POOL:first/re-review/no-round(runs)";
    let mut cells = vec![head.split(' ').map(String::from).collect::<Vec<_>>()];
    for name in flows {
        let p = &of(name).plan;
        let per = p.per_run();
        let mut row = vec![(*name).clone(), p.priced.to_string()];
        row.extend((0..4).map(|i| opt(per.and_then(|(parts, _)| parts.get(i).copied()))));
        row.push(opt(per.map(|(_, t)| t)));
        row.push(apart_cell(p));
        row.push(pool_cell(p));
        cells.push(row);
    }
    table(out, &cells)?;
    writeln!(out, "\nSurface gate (whole-repo lens passes not bought)")?;
    let head =
        "WORKFLOW GATE-RUNS NO-RECORD FAILED SAVED-RUNS SAVED-PASSES SHARE% NO-DISPATCHED BY-LENS";
    let mut cells = vec![head.split(' ').map(String::from).collect::<Vec<_>>()];
    for name in flows.iter().filter(|n| of(n).gate.gate_runs > 0) {
        let g = &of(name).gate;
        let by: Vec<String> = ranked(&g.saved_by_lens)
            .into_iter()
            .map(|(l, n)| format!("{l} {n}"))
            .collect();
        cells.push(vec![
            (*name).clone(),
            g.gate_runs.to_string(),
            g.pre_gate.to_string(),
            g.failed_runs.to_string(),
            g.saved_runs.to_string(),
            g.saved_passes.to_string(),
            opt(g.share()),
            g.missing_dispatched_runs.to_string(),
            if by.is_empty() {
                "-".into()
            } else {
                by.join(", ")
            },
        ]);
    }
    if cells.len() == 1 {
        return writeln!(out, "not recorded in these runs");
    }
    table(out, &cells)
}
