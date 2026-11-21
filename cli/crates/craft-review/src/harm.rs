//! The harm a finding names, held in code as the engines hold it (realm @nick/craft, node #379):
//! the ceiling each harm level allows (`integrations/shared/harm-levels.mjs`) and the cap that lowers a finding to
//! its level's ceiling (`integrations/shared/harm-cap.mjs`); the verified-harm raise is [`raise`].
//! `content/parity/verify-cases.json` holds both ports to the same answers.

mod floor;
pub(crate) mod raise;
mod test_gap;

pub(crate) use floor::{floor_note, raise_path_floor};
pub(crate) use test_gap::{raise_weak_floor, reach_is_regression, verifier_lines, weak_floor_note};

use serde_json::{Map, Value};

/// Every level, worst first, with the highest severity it allows.
pub(crate) const LEVELS: [(&str, &str); 10] = [
    ("data-loss", "Critical"),
    ("security", "Critical"),
    ("outage", "Critical"),
    ("irreversible", "Critical"),
    ("intent-unmet", "Critical"),
    ("repo-rule", "Critical"),
    ("operator-recovery", "Medium"),
    ("self-healing", "Low"),
    ("text", "Low"),
    ("none", "Low"),
];

/// Severity ordering, worst first.
const RANK: [&str; 5] = ["Critical", "High", "Medium", "Low", "Info"];

/// Lint seeds that report style and idiom: one that names no harm is read as level `none`.
const LINT_SEED_SOURCES: [&str; 4] = ["clippy-pedantic", "statix", "deadnix", "fmt"];

const REPO_RULE: &str = "repo-rule";

fn ceiling(level: &str) -> Option<&'static str> {
    LEVELS.iter().find(|(l, _)| *l == level).map(|(_, c)| *c)
}

fn level_rank(level: &str) -> usize {
    LEVELS
        .iter()
        .position(|(l, _)| *l == level)
        .unwrap_or(LEVELS.len())
}

fn severity_rank(severity: &str) -> Option<usize> {
    RANK.iter().position(|s| *s == severity)
}

fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// JavaScript's truthiness, for the fields the engines test that way.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Whether a cited repository rule names its file and text, both non-empty.
fn rule_cited(rule: Option<&Value>) -> bool {
    let filled = |k| {
        rule.and_then(|r| text(r, k))
            .is_some_and(|s| !s.trim().is_empty())
    };
    filled("file") && filled("text")
}

/// The level the cap reads: the finding's own, or `none` for an uncited `repo-rule`, for the tests
/// lens's weak assertion that names no regression, and for a lint seed that names no harm.
fn effective_level(f: &Value) -> Option<&str> {
    let own = text(f, "harmLevel").filter(|l| !l.is_empty());
    if (own == Some(REPO_RULE) && !rule_cited(f.get("repoRule"))) || test_gap::unnamed(f) {
        return Some("none");
    }
    if own.is_some() {
        return own;
    }
    let source = text(f, "source").unwrap_or("");
    (!truthy(f.get("harm")) && LINT_SEED_SOURCES.contains(&source)).then_some("none")
}

fn note(f: &mut Map<String, Value>, why: &str) {
    let old = f
        .get("why")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    f.insert("why".into(), Value::String(format!("{old} ({why})")));
}

/// The most `f` is allowed and why: its level's row, but a weak assertion naming its regression
/// no more than should-fix, whatever level it names or none (realm @nick/craft, node #527).
fn limit(f: &Value) -> Option<(&'static str, String)> {
    let level = effective_level(f);
    let row = level.and_then(|l| Some((ceiling(l)?, l)));
    let weak = test_gap::is_weak(f).then_some(test_gap::WEAK_CEILING);
    let held = |top| severity_rank(top) < severity_rank(test_gap::WEAK_CEILING);
    match (row, weak) {
        (Some((top, l)), Some(w)) if held(top) => Some((
            w,
            format!(
                "weak assertion, harm level {l}: the test is the missing guard, not the defect, so at most {w}"
            ),
        )),
        (None, Some(w)) => Some((
            w,
            format!("weak assertion naming no known harm level: at most {w}"),
        )),
        (Some((top, l)), _) => Some((
            top,
            if test_gap::unnamed(f) {
                format!(
                    "a weak assertion naming no regression is read as harm level {l}, which allows at most {top}"
                )
            } else {
                format!("harm level {l} allows at most {top}")
            },
        )),
        (None, None) => None,
    }
}

/// `f` lowered to its harm level's ceiling, with a note saying so; unchanged when it names no
/// known level or already sits at or below the ceiling.
pub(crate) fn cap(f: &Value) -> Value {
    let Some((top, reason)) = limit(f) else {
        return f.clone();
    };
    let severity = text(f, "severity").unwrap_or("");
    let worse = severity_rank(severity)
        .zip(severity_rank(top))
        .is_some_and(|(at, max)| at < max);
    let mut out = f.as_object().cloned().unwrap_or_default();
    if worse {
        let why = format!("lowered to {top} from {severity}: harm cap — {reason}");
        out.insert("severity".into(), Value::String(top.to_owned()));
        note(&mut out, &why);
    }
    Value::Object(out)
}
