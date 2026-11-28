//! How a pass ends besides its verdict: a project with nothing to audit, the held findings' order
//! and the host's notes riding on the finished step.

use serde_json::json;

use super::{Fake, answer, args, finding, found, ids, next, open, scratch};
use crate::step::{Said, unverified_path};

#[test]
fn a_project_its_profiles_take_nothing_of_ends_at_start_with_nothing_to_audit() {
    let s = scratch(&["README.md", "Dockerfile"]);
    let w = Fake::default();
    let done = open(&s, args(None), &w);
    assert_eq!(done["verdict"], crate::report::NOTHING, "{done}");
    assert_eq!(w.calls.borrow().len(), 1);
}

#[test]
fn the_held_findings_are_listed_low_before_info_and_the_hosts_notes_ride_on_the_steps() {
    let s = scratch(&["tool.py"]);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    answer(
        &s.run,
        &lens[0],
        &found(&[finding("Info", "tool.py"), finding("Low", "tool.py")]),
    );
    for id in &lens[1..] {
        answer(&s.run, id, &found(&[]));
    }
    let weaker = ["ran on a smaller model".to_owned()];
    let done = next(
        &s.run,
        &w,
        &Said {
            degraded: &weaker,
            ..Said::default()
        },
    );
    assert_eq!(done["degraded"], json!(weaker), "{done}");
    let held = std::fs::read_to_string(unverified_path(&s.run)).unwrap();
    assert!(
        held.find("Low in tool.py").unwrap() < held.find("Info in tool.py").unwrap(),
        "{held}"
    );
}
