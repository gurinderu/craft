//! The issue a class-1 finding ("not this PR's", realm @nick/craft, node #303) becomes on the
//! consumer's forge, as `issueOf` in `integrations/shared/triage-noise-class.mjs`.

use serde::{Deserialize, Serialize};

use crate::finding::Finding;
use crate::ledger::Validation;

/// The issue a class-1 finding becomes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    pub stable_id: String,
    pub title: String,
    pub body: String,
}

/// The issue of finding `f` under `id`: its title, and a body naming where it stands, why it is
/// not this PR's, and the source's own words.
#[must_use]
pub fn issue_of(f: &Finding, id: &str, v: &Validation) -> Issue {
    let location = if f.location.is_empty() {
        "no location"
    } else {
        &f.location
    };
    Issue {
        stable_id: id.to_owned(),
        title: f.title.clone(),
        body: format!(
            "{} · {location} · from {}\n\n{}\n\nNot introduced by the PR it was raised on: {} (checked at {})",
            f.severity, f.source, f.detail, v.reason, v.premise_checked
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(reason: &str, premise: &str) -> Validation {
        Validation {
            reason: reason.into(),
            premise_checked: premise.into(),
            ..Validation::default()
        }
    }

    #[test]
    fn an_issue_names_where_it_stands_and_why() {
        let f = Finding {
            severity: "High".into(),
            title: "t".into(),
            detail: "d".into(),
            source: "review".into(),
            ..Finding::default()
        };
        let i = issue_of(&f, "id", &v("why", "git show b:x"));
        assert_eq!(i.title, "t");
        assert_eq!(
            i.body,
            "High · no location · from review\n\nd\n\nNot introduced by the PR it was raised on: why (checked at git show b:x)"
        );
    }
}
