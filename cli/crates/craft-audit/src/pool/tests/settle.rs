use craft_review::settle::Tier;
use craft_step::TaskState;
use serde_json::{Value, json};

use super::{finding, pooled, task, verify};
use crate::pool::{Pooled, settle};

fn vote(index: u64, refuted: bool) -> Value {
    json!({"index": index, "refuted": refuted, "citedLineMatches": true, "reachable": true,
        "premiseSupported": true, "behaviourIntended": false, "harmSupported": true,
        "confirmedHarmLevel": "outage", "reason": "r"})
}

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
            Some(json!({"verdicts": [vote(0, true)]})),
        ),
        task(verify(vec![4]), TaskState::Failed, None),
    ];
    let tiers: Vec<Tier> = settle(&p, &tasks).iter().map(Tier::of).collect();
    assert_eq!(
        tiers,
        [
            Tier::Confirmed,
            Tier::Refuted,
            Tier::Suspected,
            Tier::Unverified,
            Tier::Unverified
        ]
    );
    let low = &settle(&p, &tasks)[3];
    assert!(
        low["why"]
            .as_str()
            .unwrap()
            .contains("verifies only Medium and above"),
        "{low}"
    );
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
