//! The issue a class-1 finding ("not this PR's", realm @nick/craft, node #303) becomes on the
//! consumer's forge, as `issueOf` in `integrations/shared/triage-noise-class.mjs`, and the issue
//! action on the ledger rows it carries.

use std::collections::HashSet;

use crate::finding::Finding;
use crate::js;
use crate::json::{Json, Obj};
use crate::ledger::Row;

/// The issue of finding `f` under `id`, in `issueOf`'s order: its title, and a body naming where
/// it stands, why it is not this PR's, and the source's own words.
#[must_use]
pub fn issue_of(f: &Finding, id: &str, v: &Row) -> Json {
    let location = if js::truthy(f.0.get("location")) {
        f.js("location")
    } else {
        "no location".into()
    };
    // An array's join writes an absent or null detail as ''.
    let detail = match f.0.get("detail") {
        None | Some(Json::Null) => String::new(),
        d => js::string(d),
    };
    let body = format!(
        "{} · {location} · from {}\n\n{detail}\n\nNot introduced by the PR it was raised on: {} (checked at {})",
        f.js("severity"),
        f.js("source"),
        v.js("reason"),
        v.js("premise_checked")
    );
    let title = f.0.get("title").cloned().unwrap_or_default();
    Json::Object(
        Obj::new()
            .with("stable_id", id)
            .with("title", title)
            .with("body", body),
    )
}

/// `rows` with the issue action on each row a class-1 verdict carries.
#[must_use]
pub fn with_issue_actions(rows: Vec<Json>, validations: &[Row]) -> Vec<Json> {
    let to_issue: HashSet<&str> = validations
        .iter()
        .filter(|v| v.0.get("action").and_then(Json::as_str) == Some("issue"))
        .map(Row::id)
        .collect();
    if to_issue.is_empty() {
        return rows;
    }
    let issued = |o: &Obj| {
        o.get("stable_id")
            .and_then(Json::as_str)
            .is_some_and(|id| to_issue.contains(id))
    };
    rows.into_iter()
        .map(|e| {
            if let Json::Object(o) = &e
                && issued(o)
            {
                return Json::Object(o.clone().with("action", "issue"));
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
                .with("severity", "High")
                .with("title", "t")
                .with("location", "")
                .with("detail", "d")
                .with("source", "review"),
        );
        let v = Row(Obj::new()
            .with("reason", "why")
            .with("premise_checked", "git show b:x"));
        assert_eq!(
            serde_json::to_string(&issue_of(&f, "id", &v)).unwrap(),
            r#"{"stable_id":"id","title":"t","body":"High · no location · from review\n\nd\n\nNot introduced by the PR it was raised on: why (checked at git show b:x)"}"#
        );
    }
}
