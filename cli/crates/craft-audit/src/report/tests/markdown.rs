use serde_json::json;

use super::{answered, settled, state};
use crate::plan::jobs;
use crate::report::{markdown, summary};
use crate::scout::profiles;

#[test]
fn the_report_opens_with_its_verdict_and_says_what_it_did_not_read() {
    let s = state(&["a.rs", "b.rs"]);
    let sum = summary(&s, &profiles().unwrap());
    let md = markdown(
        std::path::Path::new("/runs/a"),
        &s,
        &sum,
        &["the run record — refused".into()],
    );
    assert!(md.starts_with("# craft audit\n\n> **Not filed**: the run record — refused\n\n## Verdict\n\n**INCOMPLETE**\n"), "{md}");
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
    let md = markdown(std::path::Path::new("/r"), &s, &sum, &[]);
    assert!(md.contains("- Files: 1 of 1 read"), "{md}");
    assert!(
        md.contains("2 Low or Info finding(s) no verifier checked"),
        "{md}"
    );
    assert!(!md.contains("## Unverified"), "{md}");
}
