//! What `craft runs` prints: an aligned table, or with `--json` one JSON object per line.

mod retro;

pub use retro::retro;

use std::io::{self, Write};

use craft_store::check::Found;
use craft_store::js::{Js, Obj, number_text};
use craft_store::record::SEVERITIES;
use craft_store::tally::{TRIAGE, Tally};

pub(super) fn num(n: f64) -> String {
    number_text(n)
}

pub(super) fn opt(n: Option<f64>) -> String {
    n.map_or_else(|| "-".to_owned(), num)
}

/// Rows of cells, each column as wide as its widest cell.
pub(super) fn table(out: &mut dyn Write, rows: &[Vec<String>]) -> io::Result<()> {
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            let w = cell.chars().count();
            match widths.get_mut(i) {
                Some(have) => *have = (*have).max(w),
                None => widths.push(w),
            }
        }
    }
    for row in rows {
        let cells: Vec<String> = row
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{c:<w$}", w = widths.get(i).copied().unwrap_or(0)))
            .collect();
        writeln!(out, "{}", cells.join("  ").trim_end())?;
    }
    Ok(())
}

pub(super) fn line(out: &mut dyn Write, o: Obj) -> io::Result<()> {
    writeln!(out, "{}", Js::Obj(o).compact())
}

pub fn ls(out: &mut dyn Write, rows: &[Obj], json: bool) -> io::Result<()> {
    if json {
        return rows.iter().try_for_each(|r| line(out, r.clone()));
    }
    let mut cells = vec![
        [
            "TS", "NAME", "VERSION", "VERDICT", "FINDINGS", "BRANCH", "PROJECT",
        ]
        .map(String::from)
        .to_vec(),
    ];
    for r in rows {
        let name = match r.text("driver") {
            "" => r.text("name").to_owned(),
            d => format!("{} ({d})", r.text("name")),
        };
        let project = r
            .text("project")
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_owned();
        let findings = r
            .get("findingsTotal")
            .map(Js::to_js_string)
            .unwrap_or_default();
        cells.push(vec![
            r.text("ts").to_owned(),
            name,
            r.text("craftVersion").to_owned(),
            r.text("verdict").to_owned(),
            findings,
            r.text("branch").to_owned(),
            project,
        ]);
    }
    table(out, &cells)
}

pub(super) fn tally_obj(t: &Tally) -> Obj {
    let mut sev = Obj::new();
    for (s, n) in SEVERITIES.iter().zip(t.findings) {
        sev.set(*s, Js::Num(n));
    }
    let mut triage = Obj::new();
    for (k, n) in TRIAGE.iter().zip(t.triage) {
        triage.set(*k, Js::Num(n));
    }
    #[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
    let n = |c: u64| Js::Num(c as f64);
    let verdicts = Obj::new()
        .with("block", n(t.block))
        .with("warning", n(t.warning))
        .with("approve", n(t.approve))
        .with("incomplete", n(t.incomplete))
        .with("partialCoverage", n(t.partial_coverage));
    let verified = Obj::new()
        .with("candidates", Js::Num(t.candidates))
        .with("confirmed", Js::Num(t.confirmed))
        .with("share", t.verified_share().map_or(Js::Null, Js::Num));
    Obj::new()
        .with("runs", n(t.runs))
        .with("verdicts", Js::Obj(verdicts))
        .with("findings", Js::Obj(sev))
        .with("verified", Js::Obj(verified))
        .with("avgRefute", t.avg_refute().map_or(Js::Null, Js::Num))
        .with("triage", Js::Obj(triage))
}

pub(super) fn tally_cells(name: &str, t: &Tally) -> Vec<String> {
    let mut row = vec![name.to_owned(), t.runs.to_string()];
    row.push(format!("{}/{}/{}", t.block, t.warning, t.approve));
    row.push(t.incomplete.to_string());
    row.push(t.partial_coverage.to_string());
    row.extend(t.findings.iter().map(|n| num(*n)));
    row.push(format!(
        "{}/{} {}",
        num(t.confirmed),
        num(t.candidates),
        opt(t.verified_share())
    ));
    row.push(opt(t.avg_refute()));
    row.push(
        t.triage
            .iter()
            .map(|n| num(*n))
            .collect::<Vec<_>>()
            .join("/"),
    );
    row
}

pub(super) const TALLY_HEAD: [&str; 13] = [
    "GROUP",
    "RUNS",
    "B/W/A",
    "INC",
    "PARTIAL",
    "CRIT",
    "HIGH",
    "MED",
    "LOW",
    "INFO",
    "VERIFIED",
    "REFUTE",
    "TRIAGE g/v/acc/rej/def/nd/conf/iss",
];

pub fn stats(out: &mut dyn Write, groups: &[(String, Tally)], json: bool) -> io::Result<()> {
    if json {
        return groups.iter().try_for_each(|(g, t)| {
            line(
                out,
                Obj::new()
                    .with("group", Js::str(g))
                    .with("tally", Js::Obj(tally_obj(t))),
            )
        });
    }
    let mut cells = vec![TALLY_HEAD.map(String::from).to_vec()];
    cells.extend(groups.iter().map(|(g, t)| tally_cells(g, t)));
    table(out, &cells)
}

pub fn check(out: &mut dyn Write, f: &Found, json: bool) -> io::Result<()> {
    let mut items: Vec<(&str, String)> = Vec::new();
    items.extend(
        f.skipped
            .lines
            .iter()
            .map(|n| ("unreadable-line", format!("index.jsonl line {n}"))),
    );
    items.extend(
        f.skipped
            .records
            .iter()
            .map(|(n, w)| ("unreadable-record", format!("{n}: {w}"))),
    );
    items.extend(f.unindexed.iter().map(|n| ("unindexed-record", n.clone())));
    items.extend(f.missing.iter().map(|n| ("missing-record", n.clone())));
    items.extend(
        f.phantoms
            .iter()
            .map(|(p, t)| ("phantom-incomplete", format!("{p} beside {t}"))),
    );
    items.extend(
        f.unfiled
            .iter()
            .map(|d| ("finished-unfiled", format!("cli/{d}"))),
    );
    items.extend(
        f.partials
            .iter()
            .map(|d| ("unfinalized-checkpoints", format!(".partial/{d}"))),
    );
    if json {
        return items.iter().try_for_each(|(k, w)| {
            line(
                out,
                Obj::new()
                    .with("kind", Js::str(*k))
                    .with("what", Js::str(w)),
            )
        });
    }
    if items.is_empty() {
        return writeln!(out, "the store is clean");
    }
    let mut cells = vec![vec!["KIND".to_owned(), "WHAT".to_owned()]];
    cells.extend(items.into_iter().map(|(k, w)| vec![k.to_owned(), w]));
    table(out, &cells)
}
