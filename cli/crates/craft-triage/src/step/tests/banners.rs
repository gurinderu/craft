//! A record that did not land leads every plan: above the banners the run computed, and above the
//! host's degraded notes.

use craft_review::filing::WriteError;

use super::recording::{CASE, kept, recording};
use super::{run_case, run_recording};

#[test]
fn a_record_that_did_not_land_leads_the_plan_and_keeps_its_other_banners() {
    let w = kept(Err(WriteError::Store("disk full".into())));
    let (_, _, plain) = run_case("a dead gather source", &[]);
    let (_, _, step) = run_recording("a dead gather source", &[], Some(recording()), &w);
    let (md, was) = (
        step["plan"]["plan_markdown"].as_str().unwrap(),
        plain["plan"]["plan_markdown"].as_str().unwrap(),
    );
    assert!(md.starts_with("## ⚠️ Telemetry lost\n"), "{md}");
    assert!(
        md.ends_with(was),
        "the banners the run computed follow it whole: {md}"
    );
    assert!(was.contains("INCOMPLETE TRIAGE"), "{was}");
    for k in ["memory", "notRun", "summary"] {
        assert_eq!(step["plan"][k], plain["plan"][k], "{k}");
    }
}

#[test]
fn the_hosts_degraded_notes_follow_the_record_that_did_not_land() {
    let w = kept(Err(WriteError::Store("disk full".into())));
    let notes = ["a lens ran on the default agent".to_owned()];
    let (_, _, step) = run_recording(CASE, &notes, Some(recording()), &w);
    let md = step["plan"]["plan_markdown"].as_str().unwrap();
    let (lost, degraded) = (
        md.find("## ⚠️ Telemetry lost").unwrap(),
        md.find("> **DEGRADED**").unwrap(),
    );
    assert_eq!(lost, 0, "{md}");
    assert!(degraded > lost, "{md}");
}
