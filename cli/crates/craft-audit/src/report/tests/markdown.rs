use serde_json::json;

use super::{answered, settled, state};
use crate::plan::jobs;
use crate::report::{markdown, summary};
use crate::scout::profiles;

mod capped;

#[test]
fn the_report_opens_with_its_verdict_and_says_what_it_did_not_read() {
    let s = state(&["a.rs", "b.rs"]);
    let sum = summary(&s, &profiles().unwrap());
    let md = markdown(
        std::path::Path::new("/runs/a"),
        &s,
        &sum,
        &["the run record — refused".into()],
        true,
    );
    assert!(md.starts_with("# craft audit\n\n> **Not filed**: the run record — refused; a resume files a record — this pass's, or its own when a new pass reads what is left: `craft audit submit --run '/runs/a' --resume`\n\n## Verdict\n\n**INCOMPLETE**\n"), "{md}");
    assert!(
        md.contains("- Files: 0 of 2 read, of 3 tracked; 1 outside every profile"),
        "{md}"
    );
    assert!(
        md.contains("- Unread: 2 file(s), listed in `unread.txt`"),
        "{md}"
    );
    assert!(
        md.contains("craft audit submit --run '/runs/a' --resume"),
        "{md}"
    );
    assert!(
        md.contains("- Lenses of rust an audit does not run: "),
        "{md}"
    );
}

#[test]
fn the_report_lists_the_findings_that_stand_worst_first_and_holds_low_unverified_apart() {
    let mut s = state(&["a.rs"]);
    let all = jobs(&s.scout, &profiles().unwrap());
    s.tasks = all.iter().map(|j| answered(j, &json!([]))).collect();
    s.tasks[0].answer = Some(json!({"findings": [settled("Low", ""), settled("Info", "")]}));
    let sum = summary(&s, &profiles().unwrap());
    let md = markdown(std::path::Path::new("/r"), &s, &sum, &[], false);
    assert!(md.contains("- Files: 1 of 1 read"), "{md}");
    assert!(
        md.contains("2 Low or Info finding(s) no verifier checked"),
        "{md}"
    );
    assert!(!md.contains("## Unverified"), "{md}");
}

#[test]
fn findings_are_listed_worst_first_with_their_fix_and_no_line_counts_nothing() {
    let s = state(&["a.rs"]);
    let mut low = settled("Low", "confirmed");
    low["title"] = json!("the low one");
    let mut high = settled("High", "confirmed");
    high["title"] = json!("the high one");
    high["fix"] = json!("guard it");
    let mut medium = settled("Medium", "confirmed");
    medium["title"] = json!("the medium one");
    let sum = crate::report::Summary {
        verdict: "Block".into(),
        unread: Vec::new(),
        jobs: 1,
        answered: 1,
        settled: vec![low, medium, high],
        unjudged: Vec::new(),
        left: Vec::new(),
    };
    let md = markdown(std::path::Path::new("/r"), &s, &sum, &[], false);
    let at = |t: &str| md.find(t).unwrap();
    assert!(
        at("the high one") < at("the medium one") && at("the medium one") < at("the low one"),
        "{md}"
    );
    assert_eq!(md.matches("  - Fix: ").count(), 1, "{md}");
    assert!(md.contains("  - Fix: guard it\n"), "{md}");
    for absent in ["Unread:", "Unjudged:", "no verifier checked", "Not filed"] {
        assert!(!md.contains(absent), "{absent}: {md}");
    }
}

#[test]
fn a_finding_left_unjudged_is_named_with_how_to_hand_it_to_a_new_verifier() {
    let s = state(&["a.rs"]);
    let sum = crate::report::Summary {
        verdict: "INCOMPLETE".into(),
        unread: Vec::new(),
        jobs: 1,
        answered: 1,
        settled: vec![settled("High", "unverified")],
        unjudged: vec![0],
        left: Vec::new(),
    };
    let md = markdown(std::path::Path::new("/r"), &s, &sum, &[], false);
    assert!(
        md.contains("- Unjudged: 1 finding(s) at Medium or above"),
        "{md}"
    );
    assert!(md.contains("## Unverified at Medium and above"), "{md}");
    assert!(
        !md.contains("capped by harm"),
        "no lens severity, no note: {md}"
    );
}

#[test]
fn a_lost_write_beside_a_record_that_landed_names_no_resume() {
    let s = state(&["a.rs"]);
    let sum = summary(&s, &profiles().unwrap());
    let lost = ["the run directory (the record itself landed) — full".to_owned()];
    let md = markdown(std::path::Path::new("/r"), &s, &sum, &lost, false);
    assert!(
        md.contains("> **Not filed**: the run directory (the record itself landed) — full\n"),
        "{md}"
    );
}
