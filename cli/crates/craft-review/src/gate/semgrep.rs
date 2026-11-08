//! semgrep as the Rust gate runs it: the repository's own rules over the changed Rust files, each
//! result a `semgrep` seed (ERROR High, WARNING Medium, else Low), never a gate failure.

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
    args.extend(files);
    let Some((_, out, err)) =
        acc.exited(&label, "semgrep", cx.runner.run(cx.top, "semgrep", &args))
    else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&out) else {
        acc.parts.push(format!("{label}: unreadable output"));
        acc.notes
            .push(format!("{label} printed no JSON: {}", last_line(&err)));
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
    acc.parts
        .push(format!("{label}: {} result(s)", results.len()));
}
