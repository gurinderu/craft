//! What a finding a record answers carries (`priorDecisionMark`, `reraiseReason`, `reraisedNote` in
//! `lib/prior-decision-apply.mjs`): set aside, the record's mark; raised again, why.

use serde_json::{Map, Value, json};

use super::{PriorDecision, RecordKind, Scope, matching, or};

/// The mark a set-aside finding carries (`priorDecisionMark`, `deferralMark`).
fn mark(d: &PriorDecision) -> String {
    let (who, when) = (
        or(&d.who, "author not recorded"),
        or(&d.when, "date not recorded"),
    );
    let link = or(&d.link, "no link");
    if d.kind == RecordKind::Question {
        return format!(
            "KNOWN AND DEFERRED: {} — {who}, {when}, {link} (question {})",
            d.reason, d.id
        );
    }
    format!(
        "REJECTED BEFORE: {} — {who}, {when}, {link} ({} {})",
        d.reason,
        d.kind.label(),
        d.id
    )
}

/// Why the repository's lack of a record's commit raises its finding.
pub(super) fn commit_missing(d: &PriorDecision) -> String {
    format!(
        "commit {} not found in this repo — raised normally",
        d.commit
    )
}

/// Why record `d` cannot set finding `f` aside; '' when it can (`reraiseReason`).
pub(super) fn reraise_reason(f: &Value, d: &PriorDecision, scope: &Scope) -> String {
    if matching::reraised_by_severity(f) {
        let what = if d.kind == RecordKind::Question {
            "deferred question"
        } else {
            "decision"
        };
        return format!("a Critical/High finding is never set aside by a prior {what}");
    }
    if d.commit.is_empty() {
        return format!(
            "the {} records no commit, so an unchanged scope cannot be established",
            d.kind.label()
        );
    }
    if scope.missing.contains(&d.id) {
        return commit_missing(d);
    }
    if !scope.unchanged.contains(&d.id) {
        return format!(
            "the code in {} changed since {} (or that could not be checked)",
            d.scope, d.commit
        );
    }
    String::new()
}

/// The note a finding raised again despite its record carries (`reraisedNote`).
pub(super) fn reraised_note(d: &PriorDecision, why: &str) -> String {
    let before = if d.kind == RecordKind::Question {
        "Deferred before"
    } else {
        "Rejected before"
    };
    format!(
        "{before} ({} {}, {}, {}) — raised again: {why}.",
        d.kind.label(),
        d.id,
        or(&d.who, "author not recorded"),
        or(&d.when, "date not recorded")
    )
}

/// `f` with `note` appended to its `why`, and `extra` fields set.
pub(super) fn noted(f: &Value, note: &str, extra: &[(&str, Value)]) -> Value {
    let mut o: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
    let why = o
        .get("why")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    o.insert("why".into(), Value::from(format!("{why} · {note}")));
    for (k, v) in extra {
        o.insert((*k).to_owned(), v.clone());
    }
    Value::Object(o)
}

/// `f` set aside by `d`, matched as `how`.
pub(super) fn set_aside(f: &Value, d: &PriorDecision, how: &str) -> Value {
    let tier = f.get("tier").and_then(Value::as_str).unwrap_or("confirmed");
    let mut extra = vec![
        ("priorTier", Value::from(tier)),
        ("priorDecision", Value::from(d.id.as_str())),
        ("priorKind", json!(d.kind)),
        ("priorMatch", Value::from(how)),
    ];
    if d.kind == RecordKind::Question {
        extra.push((
            "deferral",
            json!({"id": d.id, "reason": d.reason, "who": d.who, "when": d.when, "link": d.link, "commit": d.commit}),
        ));
    }
    noted(f, &mark(d), &extra)
}
