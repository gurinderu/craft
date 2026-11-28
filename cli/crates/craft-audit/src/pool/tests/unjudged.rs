use craft_step::TaskState;
use serde_json::json;

use super::{finding, pooled, task, verify, vote};
use crate::pool::{Pooled, batches, unjudged, verdict};

#[test]
fn a_finding_is_unjudged_until_an_answered_verifier_gives_its_place_a_verdict() {
    let p = vec![
        pooled("rust", "High"),
        pooled("rust", "Medium"),
        pooled("rust", "Low"),
    ];
    assert_eq!(unjudged(&p, &[]), [0, 1]);
    let tasks = [
        task(
            verify(vec![1]),
            TaskState::Answered,
            Some(json!({"verdicts": [vote(0, true)]})),
        ),
        task(verify(vec![0]), TaskState::Failed, None),
    ];
    assert_eq!(unjudged(&p, &tasks), [0]);
    assert_eq!(verdict(&tasks, 1).unwrap()["refuted"], true);
    // A verdict is read at the finding's place in its verifier's batch, not at its pool index.
    let shifted = [task(
        verify(vec![0, 1]),
        TaskState::Answered,
        Some(json!({"verdicts": [vote(1, true)]})),
    )];
    assert_eq!(unjudged(&p, &shifted), [0]);
    let pending = [task(
        verify(vec![0]),
        TaskState::Pending,
        Some(json!({"verdicts": [vote(0, true)]})),
    )];
    assert_eq!(unjudged(&p, &pending), [0, 1]);
}

#[test]
fn the_latest_answered_verifier_holding_a_finding_gives_its_verdict() {
    let tasks = [
        task(
            verify(vec![0]),
            TaskState::Answered,
            Some(json!({"verdicts": [vote(0, true)]})),
        ),
        task(
            verify(vec![0]),
            TaskState::Answered,
            Some(json!({"verdicts": [vote(0, false)]})),
        ),
    ];
    assert_eq!(verdict(&tasks, 0).unwrap()["refuted"], false);
}

#[test]
fn a_medium_its_harm_would_cap_to_low_is_still_unjudged_when_its_verifier_died() {
    let mut f = finding("Medium");
    f["harmLevel"] = json!("text");
    let p = [Pooled {
        profile: "rust".into(),
        finding: f,
    }];
    let dead = [task(verify(vec![0]), TaskState::Failed, None)];
    assert_eq!(unjudged(&p, &dead), [0]);
    assert_eq!(batches(&p, &dead), [("rust".to_owned(), vec![0])]);
}

#[test]
fn an_unjudged_finding_a_pending_verifier_holds_gets_no_second_verifier_and_a_dead_ones_does() {
    let p = vec![pooled("rust", "High"), pooled("rust", "High")];
    let tasks = [
        task(verify(vec![0]), TaskState::Pending, None),
        task(verify(vec![1]), TaskState::Failed, None),
    ];
    assert_eq!(batches(&p, &tasks), [("rust".to_owned(), vec![1])]);
    let judged = [task(
        verify(vec![0]),
        TaskState::Answered,
        Some(json!({"verdicts": [vote(0, false)]})),
    )];
    assert_eq!(batches(&p, &judged), [("rust".to_owned(), vec![1])]);
}
