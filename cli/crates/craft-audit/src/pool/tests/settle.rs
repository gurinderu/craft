use craft_review::settle::Tier;
use craft_step::TaskState;
use serde_json::json;

use super::{finding, pooled, task, verify, vote};
use crate::pool::{Pooled, settle};

#[test]
fn each_finding_settles_by_its_verifiers_vote_or_says_why_none_judged_it() {
    let p = vec![
        pooled("rust", "High"),
        pooled("rust", "Medium"),
        pooled("rust", "Medium"),
        pooled("rust", "Low"),
        pooled("rust", "High"),
    ];
    let tasks = [
        task(
            verify(vec![0]),
            TaskState::Answered,
            Some(json!({"verdicts": [vote(0, false)]})),
        ),
        task(
            verify(vec![1, 2]),
            TaskState::Answered,
            Some(json!({"verdicts": [vote(1, false), vote(0, true)]})),
        ),
        task(verify(vec![4]), TaskState::Failed, None),
    ];
    let tiers: Vec<Tier> = settle(&p, &tasks).iter().map(Tier::of).collect();
    assert_eq!(
        tiers,
        [
            Tier::Confirmed,
            Tier::Refuted,
            Tier::Confirmed,
            Tier::Unverified,
            Tier::Unverified
        ]
    );
    let why = |i: usize| settle(&p, &tasks)[i]["why"].as_str().unwrap().to_owned();
    assert!(
        why(3).contains("verifies only Medium and above"),
        "{}",
        why(3)
    );
    assert!(why(4).contains("returned no verdict for it"), "{}", why(4));
    assert!(
        settle(&p, &[])[0]["why"]
            .as_str()
            .unwrap()
            .contains("no verifier was handed it")
    );
}

#[test]
fn a_kept_answer_missing_a_findings_verdict_leaves_it_unverified_never_suspected() {
    let p = vec![pooled("rust", "Medium"), pooled("rust", "Medium")];
    let partial = [task(
        verify(vec![0, 1]),
        TaskState::Answered,
        Some(json!({"verdicts": [vote(0, false)]})),
    )];
    let tiers: Vec<Tier> = settle(&p, &partial).iter().map(Tier::of).collect();
    assert_eq!(tiers, [Tier::Confirmed, Tier::Unverified]);
}

#[test]
fn a_severity_rests_on_its_harm_alone_capped_to_what_its_level_allows() {
    let mut f = finding("High");
    f["harmLevel"] = json!("text");
    let p = [Pooled {
        profile: "rust".into(),
        finding: f,
    }];
    let tasks = [task(
        verify(vec![0]),
        TaskState::Answered,
        Some(json!({"verdicts": [vote(0, false)]})),
    )];
    let got = &settle(&p, &tasks)[0];
    assert_eq!(got["severity"], "Low", "{got}");
}
