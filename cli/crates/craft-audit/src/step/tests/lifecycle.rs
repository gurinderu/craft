use serde_json::{Value, json};

use super::{Fake, Scratch, answer, args, clean, finding, found, ids, next, open, scratch};
use crate::plan::jobs;
use crate::scout::profiles;
use crate::step::{Said, report_path, status, unread_path, unverified_path};

const FILES: [&str; 4] = ["src/a.rs", "src/b.rs", "tool.py", "README.md"];

fn every_job() -> usize {
    let s = scratch(&FILES);
    let files = crate::scout::tracked(&s.repo, &[]).unwrap();
    let scouted = crate::scout::scout(&files, &profiles().unwrap(), 10);
    jobs(&scouted, &profiles().unwrap()).len()
}

#[test]
fn start_hands_out_one_lens_agent_per_lens_and_batch_with_its_files_written() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    assert_eq!(
        (step["phase"].clone(), step["pass"].clone()),
        (json!("lens"), json!(1))
    );
    assert_eq!(step["done"], false);
    assert_eq!(ids(&step).len(), every_job());
    let first = &step["tasks"][0];
    assert_eq!(first["kind"], "lens");
    let prompt = std::fs::read_to_string(first["promptFile"].as_str().unwrap()).unwrap();
    assert!(
        prompt.contains("- `src/a.rs` (6 bytes)") && !prompt.contains("src/b.rs"),
        "{prompt}"
    );
    assert!(std::path::Path::new(first["schemaFile"].as_str().unwrap()).is_file());
    let repo = s.repo.canonicalize().unwrap();
    assert_eq!(step["repo"], repo.display().to_string());
}

#[test]
fn findings_at_medium_and_above_are_verified_and_the_audit_ends_with_its_verdict_and_record() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    answer(&s.run, &lens[0], &found(&[finding("High", "src/a.rs")]));
    answer(&s.run, &lens[1], &found(&[finding("Low", "src/a.rs")]));
    for id in &lens[2..] {
        answer(&s.run, id, &found(&[]));
    }
    let verify = next(&s.run, &w, &Said::default());
    assert_eq!(verify["phase"], "verify");
    assert_eq!(ids(&verify), ["verify-1-0"]);
    let vote = json!({"index": 0, "refuted": false, "citedLineMatches": true, "reachable": true,
        "premiseSupported": true, "behaviourIntended": false, "harmSupported": true,
        "confirmedHarmLevel": "outage", "reason": "seen"});
    answer(&s.run, "verify-1-0", &json!({"verdicts": [vote]}));
    let done = next(&s.run, &w, &Said::default());
    assert_eq!(
        (done["done"].clone(), done["verdict"].clone()),
        (json!(true), json!("Block"))
    );
    ended_blocked(&s, &w, &done);
}

/// What the Block run left: its report and held findings, no unread list, its record filed once.
fn ended_blocked(s: &Scratch, w: &Fake, done: &Value) {
    let report = std::fs::read_to_string(report_path(&s.run)).unwrap();
    assert!(
        report.starts_with("# craft audit\n\n## Verdict\n\n**Block**\n"),
        "{report}"
    );
    assert!(
        report.contains("## Confirmed") && report.contains("High in src/a.rs"),
        "{report}"
    );
    let held = std::fs::read_to_string(unverified_path(&s.run)).unwrap();
    assert!(held.contains("Low in src/a.rs"), "{held}");
    assert_eq!(done["unverifiedLow"]["count"], 1);
    assert!(
        !unread_path(&s.run).exists() && done.get("unread").is_none(),
        "{done}"
    );
    let calls = w.calls.borrow();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["record"]["name"], "audit");
    assert_eq!(calls[0]["record"]["verdict"], "Block");
    assert_eq!(calls[0]["retry"], false);
    assert_eq!(
        calls[0]["keptAtWrite"], "attempted",
        "the attempt is kept before the write"
    );
    // The held findings' list is written before the store's write.
    assert_eq!(calls[0]["atWrite"]["unverified"], true);
    assert_eq!(done["filing"]["record"], "filed");
    let st = status(&s.run).unwrap();
    assert_eq!(
        (st["done"].clone(), st["verdict"].clone()),
        (json!(true), json!("Block"))
    );
}

#[test]
fn an_audit_whose_lenses_find_nothing_ends_without_a_verifier_and_approves() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    clean(&s.run, &step);
    let done = next(&s.run, &w, &Said::default());
    assert_eq!(done["verdict"], "Approve", "{done}");
    assert!(!unverified_path(&s.run).exists());
    for absent in [
        "unjudged",
        "unverifiedLow",
        "unread",
        "resume",
        "degraded",
        "notes",
    ] {
        assert!(done.get(absent).is_none(), "{absent}: {done}");
    }
}
