//! The hooks' report as text, or NDJSON with `--json`.

use std::io::{self, Write};

use craft_store::js::{Js, Obj};

use super::Row;

#[expect(clippy::cast_precision_loss, reason = "a line count is far below 2^52")]
fn count(n: u64) -> Js {
    Js::Num(n as f64)
}

/// The report: the rows, then the runs joined, as text or NDJSON.
pub(super) fn render(
    out: &mut dyn Write,
    rows: &[Row],
    join: (u64, u64, usize),
    json: bool,
) -> io::Result<()> {
    let (joined, runs, repos) = join;
    if json {
        for r in rows {
            let mut by = Obj::new();
            for (why, n) in &r.silent {
                by.set(why.as_str(), count(*n));
            }
            let o = Obj::new()
                .with("section", Js::str("hook"))
                .with("group", Js::str(&r.group))
                .with("runs", count(r.runs))
                .with("spoke", count(r.spoke))
                .with("silent", count(r.runs - r.spoke))
                .with("silentBy", Js::Obj(by));
            writeln!(out, "{}", Js::Obj(o).compact())?;
        }
        let o = Obj::new()
            .with("section", Js::str("hookJoin"))
            .with("joined", count(joined))
            .with("workflowRuns", count(runs))
            .with("repos", count(repos as u64));
        return writeln!(out, "{}", Js::Obj(o).compact());
    }
    for r in rows {
        let why: Vec<String> = r.silent.iter().map(|(w, n)| format!("{w} {n}")).collect();
        let why = if why.is_empty() {
            String::new()
        } else {
            format!(" ({})", why.join(", "))
        };
        writeln!(
            out,
            "{}: {} run(s) — spoke {}, silent {}{why}",
            r.group,
            r.runs,
            r.spoke,
            r.runs - r.spoke
        )?;
    }
    writeln!(
        out,
        "review runs after the start hook (SessionStart) spoke in their repo: {joined} of {runs} ({repos} repo(s))"
    )
}
