//! `craft runs round-pairs`: consecutive review rounds of one branch paired over the whole store,
//! a resumed run once, each round priced by its parts' shares ([`craft_store::parts`]); a pair
//! compared only when nothing but memory differs, any other named with what confounds it.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use anyhow::Result;
use craft_store::js::{Js, Obj, number_text};
use craft_store::read::Skipped;
use craft_store::retro::pairs::{self, Pair};

use super::visit::{self, Seen};

mod reason;

use reason::reason;

#[expect(
    clippy::cast_precision_loss,
    reason = "a record count is far below 2^52"
)]
fn count(n: u64) -> Js {
    Js::Num(n as f64)
}

fn num(n: f64) -> Js {
    Js::Num(n)
}

fn pair_json(p: &Pair) -> Obj {
    let delta = p.delta().map_or(Js::Null, |d| {
        let mut o = Obj::new();
        let keys = [
            "costTotal",
            "cacheRead",
            "cacheWrite",
            "input",
            "output",
            "agents",
            "lensAgents",
            "candidates",
            "findings",
        ];
        for (k, v) in keys.iter().zip(d.by) {
            o.set(*k, num(v));
        }
        o.set("costRatio", num(d.ratio));
        o.set("minutesApart", d.minutes.map_or(Js::Null, num));
        Js::Obj(o)
    });
    Obj::new()
        .with("section", Js::str("roundPair"))
        .with("project", p.project.clone())
        .with("branch", Js::Str(p.branch.clone()))
        .with("fromRound", num(p.from.round))
        .with("toRound", num(p.to.round))
        .with("fromTs", p.from.ts.clone())
        .with("toTs", p.to.ts.clone())
        .with("status", Js::str(p.status))
        .with("fromCost", p.from.cost.map_or(Js::Null, |c| num(c[0])))
        .with("toCost", p.to.cost.map_or(Js::Null, |c| num(c[0])))
        .with("delta", delta)
}

/// What the pairs' token counts are, said above them.
const UNWEIGHTED: &str = "Compared only when nothing but memory differs; every other pair is named with what confounds it. Token counts are an unweighted sum across kinds (a cache read is priced far below output), so read the per-kind deltas, not the ratio alone, as money.";

fn signed(n: f64) -> String {
    format!("{}{}", if n >= 0.0 { "+" } else { "" }, number_text(n))
}

fn pair_text(p: &Pair) -> String {
    let head = format!(
        "{} ({}) round {} → {}",
        p.branch.to_utf8_lossy(),
        p.project.to_js_text().to_utf8_lossy(),
        number_text(p.from.round),
        number_text(p.to.round)
    );
    let Some(d) = p.delta() else {
        return format!("{head}: {}", reason(p.status));
    };
    let apart = d.minutes.map_or_else(
        || "time apart unknown".to_owned(),
        |m| {
            format!(
                "{} min apart — a prompt cache still warm from round {} lowers the later round's input",
                number_text(m),
                number_text(p.from.round)
            )
        },
    );
    let cost = |s: &pairs::Side| s.cost.map_or_else(String::new, |c| number_text(c[0]));
    format!(
        "{head}: tokens ×{} ({} → {}): output {}, input {}, cache read {}, cache write {} ({apart}); agents {}, lens dispatches {}, verified candidates {}, findings {}",
        number_text(d.ratio),
        cost(&p.from),
        cost(&p.to),
        signed(d.by[4]),
        signed(d.by[3]),
        signed(d.by[1]),
        signed(d.by[2]),
        signed(d.by[5]),
        signed(d.by[6]),
        signed(d.by[7]),
        signed(d.by[8])
    )
}

/// The pairs over the store at `store`, as text or NDJSON.
pub(super) fn report(
    out: &mut dyn Write,
    store: &Path,
    json: bool,
    skipped: &mut Skipped,
) -> Result<()> {
    let mut rounds: Vec<(String, Obj)> = Vec::new();
    let mut excluded: BTreeMap<&'static str, u64> = BTreeMap::new();
    let (counts, parts) = visit::walk(store, &|_| true, skipped, &mut |seen| {
        let r = match seen {
            Seen::Standing(name, r) if pairs::is_round(r) => {
                rounds.push((name.to_owned(), pairs::kept(r)));
                return Ok(());
            }
            Seen::Legacy(r) | Seen::Died(r) | Seen::Standing(_, r) => r,
            Seen::Live(_) => return Ok(()),
        };
        if let Some(why) = pairs::excluded(r) {
            *excluded.entry(why).or_default() += 1;
        }
        Ok(())
    })?;
    let rounds: Vec<Obj> = rounds
        .into_iter()
        .map(|(id, mut r)| {
            match parts.cost_of(&id, &r) {
                Some(c) => r.set("cost", c),
                None => drop(r.remove("cost")),
            }
            r
        })
        .collect();
    let found = pairs::pairs(&rounds);
    if json {
        for p in &found {
            writeln!(out, "{}", Js::Obj(pair_json(p)).compact())?;
        }
        for (why, n) in &excluded {
            let o = Obj::new()
                .with("section", Js::str("roundsExcluded"))
                .with("reason", Js::str(*why))
                .with("records", count(*n));
            writeln!(out, "{}", Js::Obj(o).compact())?;
        }
        let o = Obj::new()
            .with("section", Js::str("roundPairsFolded"))
            .with("records", count(counts.folded));
        return writeln!(out, "{}", Js::Obj(o).compact()).map_err(Into::into);
    }
    if found.is_empty() {
        writeln!(
            out,
            "No consecutive review rounds of one branch in this store."
        )?;
    } else {
        writeln!(out, "{UNWEIGHTED}")?;
    }
    for p in &found {
        writeln!(out, "{}", pair_text(p))?;
    }
    if !excluded.is_empty() {
        let why: Vec<String> = excluded.iter().map(|(k, n)| format!("{n} {k}")).collect();
        writeln!(
            out,
            "{} review record(s) are not rounds and pair with nothing: {}",
            excluded.values().sum::<u64>(),
            why.join(", ")
        )?;
    }
    if counts.folded > 0 {
        writeln!(
            out,
            "{} record(s) folded into a newer record of the same run before pairing (a resumed run files twice).",
            counts.folded
        )?;
    }
    Ok(())
}
