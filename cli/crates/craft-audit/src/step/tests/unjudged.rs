//! A verifier's answer held to its whole batch, and a finding no verifier judged, whatever its harm
//! caps it to, named unjudged and handed to a new verifier by a resume.

use serde_json::{Value, json};

use super::{Fake, RESUME, Scratch, answer, args, finding, found, ids, next, open, scratch};
use crate::AuditError;
use crate::state;
use crate::step::{Said, report_path, status, submit, unverified_path};

fn vote(index: u64) -> Value {
    json!({"index": index, "refuted": false, "citedLineMatches": true, "reachable": true,
        "premiseSupported": true, "behaviourIntended": false, "harmSupported": true,
        "confirmedHarmLevel": "outage", "reason": "seen"})
}

/// A run over `src/a.rs` whose first lens found `found_first` and the rest nothing, at its
/// verifiers' step.
fn at_verify(found_first: &[Value]) -> (Scratch, Fake, Value) {
    let s = scratch(&["src/a.rs"]);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    answer(&s.run, &lens[0], &found(found_first));
    for id in &lens[1..] {
        answer(&s.run, id, &found(&[]));
    }
    let verify = next(&s.run, &w, &Said::default());
    (s, w, verify)
}

#[test]
fn a_verifier_answer_missing_or_misnumbering_a_finding_is_refused_until_its_retries_are_spent() {
    let two = [finding("Medium", "src/a.rs"), finding("Medium", "src/a.rs")];
    let (s, w, verify) = at_verify(&two);
    assert_eq!(ids(&verify), ["verify-1-0"]);
    for (bad, says) in [
        (json!({"verdicts": [vote(0)]}), "no verdict for index 1"),
        (json!({"verdicts": []}), "no verdict for index 0"),
    ] {
        answer(&s.run, "verify-1-0", &bad);
        let again = next(&s.run, &w, &Said::default());
        assert_eq!(ids(&again), ["verify-1-0"], "{bad}: {again}");
        let file = again["tasks"][0]["promptFile"].as_str().unwrap();
        let prompt = std::fs::read_to_string(file).unwrap();
        assert!(prompt.contains(says), "{bad}: {prompt}");
    }
    answer(
        &s.run,
        "verify-1-0",
        &json!({"verdicts": [vote(0), vote(5)]}),
    );
    let done = next(&s.run, &w, &Said::default());
    assert_eq!(
        (done["verdict"].clone(), done["unjudged"].clone()),
        (json!("INCOMPLETE"), json!(2)),
        "{done}"
    );
    // A host that lost that step reads the same count from the status.
    let st = status(&s.run).unwrap();
    assert_eq!(
        (st["verdict"].clone(), st["unjudged"].clone()),
        (json!("INCOMPLETE"), json!(2)),
        "{st}"
    );
    let st = state::load(&s.run).unwrap();
    let t = st.tasks.iter().find(|t| t.id == "verify-1-0").unwrap();
    let why = t.error.as_deref().unwrap_or("");
    assert!(why.contains("index 5 is not a finding"), "{t:?}");
}

#[test]
fn a_medium_its_harm_caps_whose_verifier_died_leaves_the_audit_incomplete_until_a_resume_judges_it()
{
    let mut capped = finding("Medium", "src/a.rs");
    capped["harmLevel"] = json!("text");
    let (s, w, verify) = at_verify(&[capped]);
    let dead = ids(&verify);
    let gone = Said {
        abandoned: &dead,
        ..Said::default()
    };
    let done = next(&s.run, &w, &gone);
    assert_eq!(
        (done["verdict"].clone(), done["unjudged"].clone()),
        (json!("INCOMPLETE"), json!(1)),
        "{done}"
    );
    assert!(done["resume"].is_string(), "{done}");
    assert_eq!(
        w.calls.borrow()[0]["record"]["notRun"],
        json!(["audit:unjudged-findings:1"])
    );
    assert!(
        done.get("unverifiedLow").is_none() && !unverified_path(&s.run).exists(),
        "{done}"
    );
    let report = std::fs::read_to_string(report_path(&s.run)).unwrap();
    let listed = report
        .split_once("## Unverified at Medium and above")
        .map(|(_, l)| l);
    let entry = "- **Low** (lens: Medium, capped by harm) `src/a.rs:1` — Medium in src/a.rs";
    assert!(listed.is_some_and(|l| l.contains(entry)), "{report}");
    let again = next(&s.run, &w, &RESUME);
    assert_eq!(ids(&again), ["verify-2-0"], "{again}");
    answer(&s.run, "verify-2-0", &json!({"verdicts": [vote(0)]}));
    let judged = next(&s.run, &w, &Said::default());
    assert!(
        judged.get("unjudged").is_none() && judged.get("resume").is_none(),
        "{judged}"
    );
    let after = submit(&s.run, None, &RESUME, &w);
    assert!(matches!(after, Err(AuditError::Done(_))), "{after:?}");
}

#[test]
fn a_finding_whose_verifier_died_is_unjudged_and_a_resume_hands_it_to_a_new_verifier() {
    let s = scratch(&["src/a.rs"]);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    answer(&s.run, &lens[0], &found(&[finding("High", "src/a.rs")]));
    for id in &lens[1..] {
        answer(&s.run, id, &found(&[]));
    }
    let verify = next(&s.run, &w, &Said::default());
    let dead = ids(&verify);
    let gone = Said {
        abandoned: &dead,
        ..Said::default()
    };
    let done = next(&s.run, &w, &gone);
    assert_eq!(
        (done["verdict"].clone(), done["unjudged"].clone()),
        (json!("INCOMPLETE"), json!(1))
    );
    assert!(done["resume"].is_string(), "{done}");
    let again = next(
        &s.run,
        &w,
        &Said {
            resume: true,
            ..Said::default()
        },
    );
    assert_eq!(ids(&again), ["verify-2-0"], "{again}");
    answer(&s.run, "verify-2-0", &json!({"verdicts": [vote(0)]}));
    let judged = next(&s.run, &w, &Said::default());
    assert_eq!(judged["verdict"], "Block", "{judged}");
    assert!(judged.get("resume").is_none(), "{judged}");
}
