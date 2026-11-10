//! Whether a Nix linter gave a well-formed answer, the only thing that counts as its having run
//! (realm @nick/craft, node #487). The forms are statix 0.5.8's and deadnix 1.3.2's, observed by
//! hand and replayed in `gate/nix_broken_tests.rs`: statix exits 0 with nothing on stdout or
//! stderr when clean, 1 with its JSON report on findings (a syntax error is one of them), 2 on a
//! bad argument, and 0 with `config error: …` on stderr for a file it cannot find; deadnix exits 0
//! (1 only with `--fail`), one JSON line per file with findings, a result with no `line` where it
//! could not parse or read the file, and 2 on a bad argument.

use serde_json::Value;

use super::check::{Acc, last_line};
use super::runner::Ran;

/// The exit code of what running a linter came to, `None` when it did not exit or a signal did.
pub(super) fn exit_code(ran: &Ran) -> Option<i32> {
    match ran {
        Ran::Exited { code, .. } => *code,
        Ran::Missing | Ran::TimedOut(_) | Ran::Broken(_) => None,
    }
}

/// Names `label` broken: its signal is unknown, never a pass or a failure.
pub(super) fn broke(acc: &mut Acc, label: &str, why: &str) {
    acc.parts.push(format!("{label}: broken"));
    acc.notes.push(format!(
        "{label} {why} — a broken answer, its signal unknown"
    ));
}

/// Why an exit with `code` is no answer at all.
fn exit_why(code: Option<i32>, err: &str) -> String {
    code.map_or_else(
        || "was killed by a signal".to_owned(),
        |c| format!("exited {c}: {}", last_line(err)),
    )
}

/// `text` as a JSON object holding an array at `key`.
fn holding(text: &str, key: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(|v| v.get(key).is_some_and(Value::is_array))
}

/// Why `text`, printed on exit `code`, is not the JSON a linter answers with.
fn not_json(code: i32, text: &str) -> String {
    format!("exited {code}, its output not JSON: {}", last_line(text))
}

/// statix's report on one file, `None` when clean; why its answer is none.
pub(super) fn statix_report(
    code: Option<i32>,
    out: &str,
    err: &str,
) -> Result<Option<Value>, String> {
    match code {
        Some(0) if out.trim().is_empty() && err.trim().is_empty() => Ok(None),
        Some(0) if out.trim().is_empty() => Err(format!(
            "exited 0 with nothing on stdout, and on stderr: {}",
            last_line(err)
        )),
        Some(c @ (0 | 1)) => holding(out, "report")
            .map(Some)
            .ok_or_else(|| not_json(c, out)),
        other => Err(exit_why(other, err)),
    }
}

/// deadnix's reports, one per file with findings; why its answer is none.
pub(super) fn deadnix_reports(
    code: Option<i32>,
    out: &str,
    err: &str,
) -> Result<Vec<Value>, String> {
    let Some(c @ (0 | 1)) = code else {
        return Err(exit_why(code, err));
    };
    out.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| holding(l, "results").ok_or_else(|| not_json(c, l)))
        .collect()
}

/// The file of a deadnix report and the message of its first result with no line: deadnix could not
/// parse or read that file.
pub(super) fn unread(v: &Value) -> Option<String> {
    let file = v.get("file").and_then(Value::as_str).unwrap_or("a file");
    let r = v["results"]
        .as_array()?
        .iter()
        .find(|r| r.get("line").is_none())?;
    let message = r
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("no message");
    Some(format!("{file}: {message}"))
}
