//! The Nix gate's linters on the changed `.nix` files: statix (anti-idioms) and deadnix (dead
//! bindings), each diagnostic on a line the change added a seed (`MNT-001`, Low), never a gate
//! failure.

use serde_json::Value;

use super::check::{Acc, Cx, Seed, last_line};

/// The rule a statix or deadnix seed cites in the nix-review catalog.
const RULE_ID: &str = "MNT-001";

/// How statix is run, as provenance names it.
pub(super) const STATIX: &str = "`statix check -o json`";

/// statix on `file`: one JSON report of its lints. False when it did not run, which ends the
/// files' loop: not installed, or the budget spent.
pub(super) fn statix(cx: &Cx<'_>, acc: &mut Acc, file: &str) -> bool {
    let ran = cx
        .runner
        .run(cx.top, "statix", &["check", "-o", "json", file]);
    let Some((_, out, err)) = acc.exited(STATIX, "statix", ran) else {
        return false;
    };
    if out.trim().is_empty() {
        return true;
    }
    let Ok(v) = serde_json::from_str::<Value>(&out) else {
        acc.notes.push(format!(
            "{STATIX} on {file} printed no JSON: {}",
            last_line(&err)
        ));
        return true;
    };
    for r in v
        .get("report")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let code = r.get("code").and_then(Value::as_u64).unwrap_or(0);
        let kind = if r.get("severity").and_then(Value::as_str) == Some("Error") {
            'E'
        } else {
            'W'
        };
        let rule = format!("{kind}{code:02}");
        for d in r
            .get("diagnostics")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let line = d
                .pointer("/at/from/line")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0);
            let message = d.get("message").and_then(Value::as_str).unwrap_or("");
            if cx.lines.touches(file, line) {
                acc.seed(
                    cx,
                    &Seed {
                        tool: "statix",
                        rule: &rule,
                        severity: "Low",
                        title: message,
                        file,
                        line,
                        rule_id: RULE_ID,
                    },
                );
            }
        }
    }
    true
}

/// deadnix on `files`: one JSON line per file with dead bindings. Its diagnostics name no rule:
/// the message, which names the binding, tells two of them apart.
pub(super) fn deadnix(cx: &Cx<'_>, acc: &mut Acc, files: &[&str]) {
    let label = "`deadnix -o json`";
    let mut args = vec!["-o", "json"];
    args.extend(files);
    let Some((_, out, _)) = acc.exited(label, "deadnix", cx.runner.run(cx.top, "deadnix", &args))
    else {
        return;
    };
    for v in out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
    {
        let Some(file) = v
            .get("file")
            .and_then(Value::as_str)
            .and_then(|f| cx.changed(f))
        else {
            continue;
        };
        for r in v
            .get("results")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let line = r
                .get("line")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0);
            let message = r.get("message").and_then(Value::as_str).unwrap_or("");
            if cx.lines.touches(file, line) {
                acc.seed(
                    cx,
                    &Seed {
                        tool: "deadnix",
                        rule: "",
                        severity: "Low",
                        title: message,
                        file,
                        line,
                        rule_id: RULE_ID,
                    },
                );
            }
        }
    }
    acc.parts.push(format!("{label}: local"));
}
