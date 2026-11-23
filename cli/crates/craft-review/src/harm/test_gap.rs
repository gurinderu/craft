//! The tests lens's two findings kept apart (realm @nick/craft, node #527): a missing test, and a
//! weak assertion — a test that exists and still passes under a named regression of the changed
//! behaviour. A weak assertion is rated by the harm of the regression it lets through, capped at
//! should-fix whatever level it names, since the test is the missing guard, not the defect; one
//! that names no regression is read as harm level `none`. A missing test keeps the level its lens
//! named. A test gap's reachability is its regression's, on the production line it breaks.

use craft_store::js::JsStr;
use serde_json::{Map, Value};

use super::{ceiling, effective_level, severity_rank, text};

/// The lens whose `testGap` the engine honours.
const TESTS_LENS: &str = "tests";
/// A test that exists and still passes under the named regression.
const WEAK: &str = "weak-assertion";
/// The most a weak assertion is allowed: should-fix.
pub(super) const WEAK_CEILING: &str = "Medium";
/// The weak-assertion floor's note, after the severity it raised from.
const NOTE_HEAD: &str = " (raised to Medium from ";
const NOTE_MARK: &str =
    ": weak assertion — the regression it lets through is rated by its harm, capped at should-fix)";

/// The test gap `f` is, when the tests lens alone reported it — a gate tool's seed merged in is
/// not a reading — `missing` or `weak-assertion`.
fn gap(f: &Value) -> Option<&str> {
    let l = crate::verify::lenses(f);
    let only_tests = !l.is_empty() && l.iter().all(|s| *s == TESTS_LENS);
    text(f, "testGap").filter(|g| !g.is_empty() && only_tests)
}

fn regression(f: &Value) -> Option<&str> {
    text(f, "regression").filter(|r| !r.js_trim().is_empty())
}

/// Whether `f` is the tests lens's weak assertion that names no regression: read as level `none`.
pub(super) fn unnamed(f: &Value) -> bool {
    gap(f) == Some(WEAK) && regression(f).is_none()
}

/// Whether `f` is the tests lens's weak assertion naming the regression it lets through.
pub(crate) fn is_weak(f: &Value) -> bool {
    gap(f) == Some(WEAK) && regression(f).is_some()
}

/// Whether `f` is the tests lens's test gap naming its regression, so its `reachable` is that
/// regression's.
pub(crate) fn reach_is_regression(f: &Value) -> bool {
    gap(f).is_some() && regression(f).is_some()
}

/// The lines a verifier reads for the tests lens's test gap naming its regression: the regression,
/// the production line it breaks, and that `reachable` is judged on that line, not the test's.
/// Empty for any other finding.
pub(crate) fn verifier_lines(f: &Value) -> String {
    let Some(kind) = gap(f).filter(|_| regression(f).is_some()) else {
        return String::new();
    };
    // Model-authored text, flattened to one line as every field a verifier reads.
    let regression = crate::prompts::flatten(f.get("regression"));
    let at = match crate::prompts::flatten(f.get("regressionAt")) {
        a if a.is_empty() => "(not named — find it from the regression)".to_owned(),
        a => a,
    };
    format!(
        "\n  regression the suite lets through ({kind}): {regression}\
         \n  production line that regression breaks: {at}\
         \n  REACHABILITY OF THIS TEST GAP: judge `reachable` on the regression's production path, \
         not on the cited test line — reachable=true when that production line runs in production, \
         so the regression would reach it; reachable=false only when the regression itself cannot \
         reach production (that code is test-, example- or fixture-only). The cited line being \
         test code is expected here and is NOT reachable=false."
    )
}

/// The weak-assertion floor's note in `why`, or `""` when the floor did not raise it.
pub(crate) fn weak_floor_note(why: &str) -> &str {
    ["Low", "Info"]
        .iter()
        .find_map(|from| {
            let note = format!("{NOTE_HEAD}{from}{NOTE_MARK}");
            why.find(&note).and_then(|at| why.get(at..at + note.len()))
        })
        .unwrap_or("")
}

/// `f` raised to Medium before verification when it is a weak assertion whose regression's harm
/// allows should-fix or worse and its lens rated it Low or Info, with a note saying so — so it is
/// not Low by default, and goes to a verifier. Else `f` unchanged.
pub(crate) fn raise_weak_floor(f: &Value) -> Value {
    let severity = text(f, "severity").unwrap_or("");
    let allows = effective_level(f)
        .and_then(ceiling)
        .and_then(severity_rank)
        .zip(severity_rank(WEAK_CEILING))
        .is_some_and(|(top, medium)| top <= medium);
    if !(is_weak(f) && allows && matches!(severity, "Low" | "Info")) {
        return f.clone();
    }
    let mut out: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
    let why = format!(
        "{}{NOTE_HEAD}{severity}{NOTE_MARK}",
        text(f, "why").unwrap_or("")
    );
    out.insert("severity".into(), Value::String(WEAK_CEILING.into()));
    out.insert("why".into(), Value::String(why));
    Value::Object(out)
}

#[cfg(test)]
#[path = "test_gap_tests.rs"]
mod tests;
