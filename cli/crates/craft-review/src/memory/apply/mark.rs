//! What a finding a record answers carries (`priorDecisionMark`, `reraiseReason`, `reraisedNote` in
//! `integrations/shared/prior-decision-apply.mjs`): set aside, the record's mark; raised again, why.

use craft_store::js::JsStr;
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

/// Why `f`'s severity raises it again whatever `d` says (`severityReason`).
fn severity_reason(f: &Value, d: &PriorDecision) -> String {
    let critical = f
        .get("severity")
        .and_then(Value::as_str)
        .is_some_and(|s| s.js_trim().eq_ignore_ascii_case("critical"));
    if critical {
        let what = if d.kind == RecordKind::Question {
            "deferred question"
        } else {
            "decision"
        };
        return format!("a Critical finding is never set aside by a prior {what}");
    }
    if d.kind == RecordKind::Question {
        return "a High finding is never set aside by a prior deferred question".into();
    }
    if d.deferred {
        return "a High finding is never set aside by a recorded deferral".into();
    }
    "a High finding is set aside only by a human's decision (decidedBy: human), and this one is not"
        .into()
}

/// Why record `d` cannot set finding `f` aside; '' when it can (`reraiseReason`).
pub(super) fn reraise_reason(f: &Value, d: &PriorDecision, scope: &Scope) -> String {
    if matching::reraised_by_rank(f, d) {
        return severity_reason(f, d);
    }
    let Some(anchor) = d.anchor() else {
        return format!(
            "the {} records no commit and no date, so an unchanged scope cannot be established",
            d.kind.label()
        );
    };
    if scope.missing.contains(&d.id) {
        return scope.missing_why(d, &anchor);
    }
    if !scope.unchanged.contains(&d.id) {
        return format!(
            "the code in {} changed {} (or that could not be checked)",
            d.scope,
            scope.changed(d, &anchor)
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

/// `f` with `note` appended to its field `key` (the review's `why`), and `extra` fields set.
pub(in crate::memory) fn noted(f: &Value, key: &str, note: &str, extra: &[(&str, Value)]) -> Value {
    let mut o: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
    let was = o.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
    o.insert(key.into(), Value::from(format!("{was} · {note}")));
    for (k, v) in extra {
        o.insert((*k).to_owned(), v.clone());
    }
    Value::Object(o)
}

/// `f` set aside by `d`, matched as `how`, its mark appended to its field `key`.
pub(super) fn set_aside(f: &Value, d: &PriorDecision, how: &str, key: &str) -> Value {
    let tier = f.get("tier").and_then(Value::as_str).unwrap_or("confirmed");
    let mut extra = vec![
        ("priorTier", Value::from(tier)),
        ("priorDecision", Value::from(d.id.as_str())),
        ("priorKind", json!(d.kind)),
        ("priorMatch", Value::from(how)),
    ];
    if d.kind == RecordKind::Question {
        let mut deferral = json!({"id": d.id, "reason": d.reason, "who": d.who, "when": d.when, "link": d.link, "commit": d.commit});
        // Its pull requests ride beside `link`, which names only one link, and not always a pull
        // request's: the next round anchors the deferral by them (realm @nick/craft, node #680).
        if let (Some(o), false) = (deferral.as_object_mut(), d.pulls.is_empty()) {
            o.insert("pulls".into(), json!(d.pulls));
        }
        extra.push(("deferral", deferral));
    }
    noted(f, key, &mark(d), &extra)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{PriorDecision, RecordKind, set_aside};
    use crate::memory::Pull;

    #[test]
    fn a_questions_pull_requests_ride_its_deferral_and_none_is_written_without_them() {
        let pr = Pull {
            repo: "owner/repo".into(),
            number: 7,
        };
        let mut q = PriorDecision {
            id: "question-abcdef0123".into(),
            kind: RecordKind::Question,
            link: "https://github.com/owner/repo/issues/3".into(),
            pulls: vec![pr],
            ..PriorDecision::default()
        };
        let f = json!({"file": "a.rs", "why": "w"});
        let aside = set_aside(&f, &q, "title", "why");
        assert_eq!(
            aside["deferral"]["pulls"],
            json!([{"repo": "owner/repo", "number": 7}])
        );
        q.pulls.clear();
        let aside = set_aside(&f, &q, "title", "why");
        assert!(aside["deferral"].get("pulls").is_none(), "{aside}");
        assert_eq!(aside["deferral"]["link"], json!(q.link));
    }
}
