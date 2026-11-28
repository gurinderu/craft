//! A finding its harm capped below the severity its lens rated it, listed as unjudged.

use serde_json::json;

use super::super::{settled, state};
use crate::report::markdown;

#[test]
fn a_finding_its_harm_capped_to_low_whose_verifier_died_is_listed_as_unjudged_not_held() {
    let s = state(&["a.rs"]);
    let mut capped = settled("Low", "unverified");
    capped["title"] = json!("the capped one");
    capped["lensSeverity"] = json!("Medium");
    let sum = crate::report::Summary {
        verdict: "INCOMPLETE".into(),
        unread: Vec::new(),
        jobs: 1,
        answered: 1,
        settled: vec![capped],
        unjudged: vec![0],
        left: Vec::new(),
    };
    assert!(sum.held().is_empty());
    let md = markdown(std::path::Path::new("/r"), &s, &sum, &[], false);
    let listed = md
        .split_once("## Unverified at Medium and above")
        .map(|(_, l)| l);
    let entry = "- **Low** (lens: Medium, capped by harm) `a.rs:2` — the capped one";
    assert!(listed.is_some_and(|l| l.contains(entry)), "{md}");
    assert!(!md.contains("no verifier checked"), "{md}");
}

#[test]
fn only_an_unverified_finding_whose_lens_rated_it_otherwise_is_noted_as_capped() {
    let s = state(&["a.rs"]);
    let mut raised = settled("High", "confirmed");
    raised["lensSeverity"] = json!("Medium");
    let mut same = settled("Medium", "unverified");
    same["lensSeverity"] = json!("Medium");
    let sum = crate::report::Summary {
        verdict: "Block (INCOMPLETE)".into(),
        unread: Vec::new(),
        jobs: 1,
        answered: 1,
        settled: vec![raised, same],
        unjudged: vec![1],
        left: Vec::new(),
    };
    let md = markdown(std::path::Path::new("/r"), &s, &sum, &[], false);
    assert!(
        md.contains("- **High** `a.rs:2`") && md.contains("- **Medium** `a.rs:2`"),
        "{md}"
    );
    assert!(!md.contains("capped by harm"), "{md}");
}
