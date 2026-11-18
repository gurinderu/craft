//! The tests lens's two findings kept apart (realm @nick/craft, node #527): a missing test, and a
//! weak assertion — a test that exists and still passes under a named regression of the changed
//! behaviour. A weak assertion is rated by the harm of the regression it lets through, capped at
//! should-fix, since the test is the missing guard, not the defect; a test gap that names no
//! regression is read as harm level `none`.

use serde_json::{Map, Value};

use super::{ceiling, effective_level, severity_rank, text};

/// The lens whose `testGap` the engine honours.
const TESTS_LENS: &str = "tests";
/// A test that exists and still passes under the named regression.
const WEAK: &str = "weak-assertion";
/// The most a weak assertion is allowed: should-fix.
pub(super) const WEAK_CEILING: &str = "Medium";

/// The lenses that reported `f`: its `sources`, else its `source`.
fn lenses(f: &Value) -> Vec<&str> {
    match f.get("sources").and_then(Value::as_array) {
        Some(a) => a.iter().filter_map(Value::as_str).collect(),
        None => text(f, "source").into_iter().collect(),
    }
}

/// The test gap `f` is, when the tests lens alone reported it: `missing` or `weak-assertion`.
fn gap(f: &Value) -> Option<&str> {
    let only_tests = {
        let l = lenses(f);
        !l.is_empty() && l.iter().all(|s| *s == TESTS_LENS)
    };
    text(f, "testGap").filter(|g| !g.is_empty() && only_tests)
}

fn names_regression(f: &Value) -> bool {
    text(f, "regression").is_some_and(|r| !r.trim().is_empty())
}

/// Whether `f` is the tests lens's test gap that names no regression: read as level `none`.
pub(super) fn unnamed(f: &Value) -> bool {
    gap(f).is_some() && !names_regression(f)
}

/// Whether `f` is the tests lens's weak assertion naming the regression it lets through.
pub(crate) fn is_weak(f: &Value) -> bool {
    gap(f) == Some(WEAK) && names_regression(f)
}

/// The ceiling `f`'s weak assertion allows below its level's own, or `None` when it is no weak
/// assertion.
pub(super) fn weak_ceiling(f: &Value) -> Option<&'static str> {
    is_weak(f).then_some(WEAK_CEILING)
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
        "{} (raised to Medium from {severity}: weak assertion — the regression it lets through is rated by its harm, capped at should-fix)",
        text(f, "why").unwrap_or("")
    );
    out.insert("severity".into(), Value::String(WEAK_CEILING.into()));
    out.insert("why".into(), Value::String(why));
    Value::Object(out)
}

#[cfg(test)]
#[path = "test_gap_tests.rs"]
mod tests;
