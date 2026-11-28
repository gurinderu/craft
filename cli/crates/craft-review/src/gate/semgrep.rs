//! semgrep as the Rust gate runs it: the repository's own rules over the changed Rust files, each
//! result a `semgrep` seed (ERROR High, WARNING Medium, else Low), never a gate failure. Asked
//! for — a rules directory and a changed Rust file — and not answered: not installed, past the
//! budget, broken, printing what is not JSON, or reporting an error of its own, it leaves the
//! track unknown, since its silence is no pass (realm @nick/craft, node #743). Not asked for, it
//! is no signal at all.

use serde_json::Value;

use super::check::{Acc, Cx, Seed, last_line};

/// The repository rule directories semgrep reads, as the engine's `./semgrep/` and craft's own.
const SEMGREP_DIRS: [&str; 2] = ["semgrep", ".semgrep"];

/// semgrep with the repository's own rules over the changed Rust files, when it keeps any.
pub(super) fn semgrep(cx: &Cx<'_>, acc: &mut Acc) {
    let dirs: Vec<&str> = SEMGREP_DIRS
        .into_iter()
        .filter(|d| cx.top.join(d).is_dir())
        .collect();
    let files = cx.present(".rs");
    if dirs.is_empty() || files.is_empty() {
        acc.notes.push("semgrep: no repository rules (semgrep/ or .semgrep/) or no changed Rust file — skipped".into());
        return;
    }
    let mut args = vec!["scan", "--json", "--metrics=off", "--quiet"];
    for d in &dirs {
        args.extend(["--config", d]);
    }
    let label = format!("`semgrep {}`", args.join(" "));
    // `--`: a changed file named like an option stays a file.
    args.push("--");
    args.extend(files);
    let Some((_, out, err)) =
        acc.seed_tool(&label, "semgrep", cx.runner.run(cx.top, "semgrep", &args))
    else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&out) else {
        let why = format!("printed no JSON: {}", last_line(&err));
        acc.parts.push(format!("{label}: unreadable output"));
        acc.notes.push(format!("{label} {why}"));
        acc.no_answer("semgrep", &why);
        return;
    };
    let results = v
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in &results {
        let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_owned();
        let extra = r.get("extra");
        let severity = match s(extra.and_then(|e| e.get("severity"))).as_str() {
            "ERROR" => "High",
            "WARNING" => "Medium",
            _ => "Low",
        };
        let line = r
            .pointer("/start/line")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0);
        let (path, rule, message) = (
            s(r.get("path")),
            s(r.get("check_id")),
            s(extra.and_then(|e| e.get("message"))),
        );
        if let Some(file) = cx.changed(&path) {
            acc.seed(
                cx,
                &Seed {
                    tool: "semgrep",
                    rule: &rule,
                    severity,
                    title: &message,
                    file,
                    line,
                    rule_id: "",
                },
            );
        }
    }
    answered(acc, &label, &v, results.len());
}

/// Folds in semgrep's JSON answer once its findings are seeds: what it says of its own run.
fn answered(acc: &mut Acc, label: &str, v: &Value, found: usize) {
    // An error of its own — an invalid rule, a file it could not wholly parse — at any exit status
    // and beside any number of findings: the rules did not read every line, so what it found stays
    // and the track is unknown (realm @nick/craft, node #744). Its exit status says no more: the
    // answer is read by its `errors`.
    if let Some((errors, first)) = v
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| Some((errors, one_line(errors.first()?))))
    {
        let why = format!("reported {} error(s): {}", errors.len(), first);
        acc.parts.push(format!(
            "{label}: {found} result(s), {} error(s)",
            errors.len()
        ));
        acc.notes.push(format!("{label} {why}"));
        acc.no_answer("semgrep", &why);
        return;
    }
    // An answer over no file — its rules cover none of the changed ones — is named so, not as a
    // clean scan (realm @nick/craft, node #744); one without `paths` is read as it always was.
    if v.pointer("/paths/scanned")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        acc.parts.push(format!("{label}: no file scanned"));
        acc.notes.push(format!(
            "{label} scanned no file: its rules cover none of the changed ones"
        ));
        return;
    }
    acc.parts.push(format!("{label}: {found} result(s)"));
}

/// An error entry of semgrep's answer on one line of a note: its message, else its long one.
fn one_line(error: &Value) -> String {
    let said = ["message", "long_msg"]
        .iter()
        .find_map(|k| error.get(k).and_then(Value::as_str))
        .unwrap_or("no message");
    said.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}
