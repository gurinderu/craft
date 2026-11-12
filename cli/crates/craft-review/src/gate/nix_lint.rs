//! The Nix gate's linters on the changed `.nix` files: statix (anti-idioms) and deadnix (dead
//! bindings), each diagnostic on a line the change added a seed (`MNT-001`, Low), never a gate
//! failure. Each counts as run only on a well-formed answer (`gate/nix_answer.rs`).

use serde_json::Value;

use super::check::{Acc, Cx, Seed};
use super::nix_answer::{broke, deadnix_reports, exit_code, statix_report, unread};

/// The rule a statix or deadnix seed cites in the nix-review catalog.
const RULE_ID: &str = "MNT-001";

/// How statix is run, as provenance names it.
pub(super) const STATIX: &str = "`statix check -o json`";

/// How deadnix is run, as provenance names it.
const DEADNIX: &str = "`deadnix -o json`";

/// Seeds `s` when the change added its line.
fn seed(cx: &Cx<'_>, acc: &mut Acc, s: &Seed<'_>) {
    if cx.lines.touches(s.file, s.line) {
        acc.seed(cx, s);
    }
}

/// A line number as the linters print it, 0 when there is none.
fn line_at(v: Option<&Value>) -> u32 {
    v.and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

/// The items of the array at `key` of `v`.
fn items<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    v.get(key).and_then(Value::as_array).into_iter().flatten()
}

/// statix on `file`: one JSON report of its lints. False when it gave no well-formed answer, which
/// ends the files' loop: not installed, the budget spent, or broken.
pub(super) fn statix(cx: &Cx<'_>, acc: &mut Acc, file: &str) -> bool {
    let ran = cx
        .runner
        .run(cx.top, "statix", &["check", "-o", "json", "--", file]);
    let code = exit_code(&ran);
    let Some((_, out, err)) = acc.exited(STATIX, "statix", ran) else {
        return false;
    };
    match statix_report(code, &out, &err) {
        Ok(v) => {
            if let Some(report) = &v {
                seed_statix(cx, acc, file, report);
            }
            true
        }
        Err(why) => {
            broke(acc, STATIX, &format!("on {file} {why}"));
            false
        }
    }
}

/// statix's report `v` on `file` as seeds.
fn seed_statix(cx: &Cx<'_>, acc: &mut Acc, file: &str, v: &Value) {
    for r in items(v, "report") {
        let code = r.get("code").and_then(Value::as_u64).unwrap_or(0);
        let kind = if r.get("severity").and_then(Value::as_str) == Some("Error") {
            'E'
        } else {
            'W'
        };
        let rule = format!("{kind}{code:02}");
        for d in items(r, "diagnostics") {
            let s = Seed {
                tool: "statix",
                rule: &rule,
                severity: "Low",
                title: d.get("message").and_then(Value::as_str).unwrap_or(""),
                file,
                line: line_at(d.pointer("/at/from/line")),
                rule_id: RULE_ID,
            };
            seed(cx, acc, &s);
        }
    }
}

/// deadnix on `files`: one JSON line per file with dead bindings. Its diagnostics name no rule:
/// the message, which names the binding, tells two of them apart. False when it gave no
/// well-formed answer, or could not parse or read a file (what it said of the others still seeds).
pub(super) fn deadnix(cx: &Cx<'_>, acc: &mut Acc, files: &[&str]) -> bool {
    // `--`: a changed file named like an option (deadnix's `-e` edits files) stays a file.
    let mut args = vec!["-o", "json", "--"];
    args.extend(files);
    let ran = cx.runner.run(cx.top, "deadnix", &args);
    let code = exit_code(&ran);
    let Some((_, out, err)) = acc.exited(DEADNIX, "deadnix", ran) else {
        return false;
    };
    let reports = match deadnix_reports(code, &out, &err) {
        Ok(r) => r,
        Err(why) => {
            broke(acc, DEADNIX, &why);
            return false;
        }
    };
    let unread: Vec<String> = reports.iter().filter_map(unread).collect();
    for report in &reports {
        seed_deadnix(cx, acc, report);
    }
    if unread.is_empty() {
        acc.parts.push(format!("{DEADNIX}: local"));
        return true;
    }
    broke(
        acc,
        DEADNIX,
        &format!("could not parse or read {}", unread.join("; ")),
    );
    false
}

/// deadnix's report `v` on one changed file as seeds.
fn seed_deadnix(cx: &Cx<'_>, acc: &mut Acc, v: &Value) {
    let Some(file) = v
        .get("file")
        .and_then(Value::as_str)
        .and_then(|f| cx.changed(f))
    else {
        return;
    };
    for r in items(v, "results") {
        let s = Seed {
            tool: "deadnix",
            rule: "",
            severity: "Low",
            title: r.get("message").and_then(Value::as_str).unwrap_or(""),
            file,
            line: line_at(r.get("line")),
            rule_id: RULE_ID,
        };
        seed(cx, acc, &s);
    }
}
