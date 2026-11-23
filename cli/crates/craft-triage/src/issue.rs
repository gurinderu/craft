//! The issue a class-1 finding ("not this PR's", realm @nick/craft, node #303) becomes on the
//! consumer's forge, as `issueOf` in `integrations/shared/triage-noise-class.mjs`, and the issue
//! action on the ledger rows it carries.

use std::collections::BTreeSet;

use craft_store::js::{Js, JsString, Obj};

use crate::field::{self, cat, js_text};
use crate::finding::Finding;
use crate::ledger::Row;

/// The issue of finding `f` under `id`, in `issueOf`'s order: its title (none when the finding
/// has none, as `JSON.stringify` drops an `undefined`), and a body naming where it stands, why it
/// is not this PR's, and the source's own words, every UTF-16 code unit kept.
#[must_use]
pub fn issue_of(f: &Finding, id: &JsString, v: &Row) -> Js {
    let location = if field::truthy(&f.0, "location") {
        js_text(&f.0, "location")
    } else {
        "no location".into()
    };
    // An array's join writes an absent or null detail as ''.
    let body = cat(&[
        js_text(&f.0, "severity"),
        " · ".into(),
        location,
        " · from ".into(),
        js_text(&f.0, "source"),
        "\n\n".into(),
        field::or_empty_text(&f.0, "detail"),
        "\n\nNot introduced by the PR it was raised on: ".into(),
        js_text(&v.0, "reason"),
        " (checked at ".into(),
        js_text(&v.0, "premise_checked"),
        ")".into(),
    ]);
    let mut o = Obj::new().with("stable_id", Js::Str(id.clone()));
    if let Some(title) = f.0.get("title") {
        o.set("title", title.clone());
    }
    Js::Obj(o.with("body", Js::Str(body)))
}

/// `rows` with the issue action on each row a class-1 verdict carries.
#[must_use]
pub fn with_issue_actions(rows: Vec<Js>, validations: &[Row]) -> Vec<Js> {
    let to_issue: BTreeSet<JsString> = validations
        .iter()
        .filter(|v| v.text("action") == "issue")
        .map(Row::id)
        .collect();
    if to_issue.is_empty() {
        return rows;
    }
    let issued = |o: &Obj| matches!(o.get("stable_id"), Some(Js::Str(id)) if to_issue.contains(id));
    rows.into_iter()
        .map(|e| {
            if let Js::Obj(o) = &e
                && issued(o)
            {
                return Js::Obj(o.clone().with("action", Js::str("issue")));
            }
            e
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_issue_names_where_it_stands_and_why() {
        let f = Finding(
            Obj::new()
                .with("severity", Js::str("High"))
                .with("title", Js::str("t"))
                .with("location", Js::str(""))
                .with("detail", Js::str("d"))
                .with("source", Js::str("review")),
        );
        let v = Row(Obj::new()
            .with("reason", Js::str("why"))
            .with("premise_checked", Js::str("git show b:x")));
        assert_eq!(
            issue_of(&f, &"id".into(), &v).compact(),
            r#"{"stable_id":"id","title":"t","body":"High · no location · from review\n\nd\n\nNot introduced by the PR it was raised on: why (checked at git show b:x)"}"#
        );
    }

    #[test]
    fn an_issue_of_a_finding_with_no_title_has_none() {
        let f = Finding(Obj::new().with("severity", Js::str("Low")));
        let got = issue_of(&f, &"id".into(), &Row::default()).compact();
        assert!(
            got.starts_with(r#"{"stable_id":"id","body":"Low · no location · from undefined"#),
            "{got}"
        );
    }
}
