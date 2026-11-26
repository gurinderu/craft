//! The stop's text, its note and resume line, and the tasks it holds.

use super::{Cause, Stop, deaths, hold, limit, resume};
use crate::task::{Counted, TaskState};
use crate::test_kind::task;

#[test]
fn the_limit_text_is_folded_to_one_line_and_cut() {
    let s = limit(&format!("  Claude\n Max\tlimit {}", "x".repeat(300)));
    assert_eq!(s.cause, Cause::Limit);
    assert!(s.text.starts_with("Claude Max limit x"), "{}", s.text);
    assert_eq!(s.text.chars().count(), super::TEXT_MAX);
}

#[test]
fn each_stop_says_its_note_and_when_it_goes_on() {
    let l = limit("rate limit");
    assert_eq!(l.note(), "stopped: usage limit reached (rate limit)");
    assert_eq!(l.when(), "once the limit resets");
    let d = deaths("every agent died".into());
    assert_eq!(
        d.note(),
        "stopped: every agent died, most likely the account's usage limit or an outage"
    );
    assert_eq!(d.when(), "once agents answer again");
    let told = Stop { told: true, ..d };
    assert_eq!(told.note(), "stopped: every agent died");
}

#[test]
fn the_resume_line_names_its_kind_and_quotes_the_directory() {
    let line = resume("triage", std::path::Path::new("/r/it's"));
    assert_eq!(line, r"craft triage submit --run '/r/it'\''s' --resume");
}

#[test]
fn held_tasks_go_pending_again_and_answered_or_abandoned_ones_stay() {
    let mut failed = task();
    failed.state = TaskState::Failed;
    failed.retries = 2;
    failed.error = Some("e".into());
    failed.refused = Some(serde_json::json!({}));
    failed.counted = Some(Counted {
        print: "p".into(),
        at: 0,
        again: false,
    });
    let mut answered = task();
    answered.state = TaskState::Answered;
    let mut gone = task();
    gone.state = TaskState::Failed;
    gone.abandoned = true;
    let mut tasks = [failed, answered, gone];
    hold(&mut tasks);
    let [f, a, g] = &tasks;
    assert_eq!((f.state, f.retries), (TaskState::Pending, 0));
    assert!(f.error.is_none() && f.refused.is_none() && f.counted.is_some());
    assert_eq!(a.state, TaskState::Answered);
    assert_eq!(g.state, TaskState::Failed);
}

#[test]
fn hold_pending_clears_the_pending_tasks_ladders_and_leaves_failed_ones_failed() {
    let mut pending = task();
    pending.retries = 2;
    pending.error = Some("e".into());
    pending.refused = Some(serde_json::json!({}));
    let mut failed = task();
    failed.state = TaskState::Failed;
    failed.retries = 3;
    let mut tasks = [pending, failed];
    super::hold_pending(&mut tasks);
    let [p, f] = &tasks;
    assert_eq!((p.state, p.retries), (TaskState::Pending, 0));
    assert!(p.error.is_none() && p.refused.is_none());
    assert_eq!((f.state, f.retries), (TaskState::Failed, 3));
}
