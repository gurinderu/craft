use serde_json::{Map, json};

use super::{Fake, answer, args, found, ids, next, open, scratch};
use crate::AuditError;
use crate::state;
use crate::step::{Said, status, submit};

const FILES: [&str; 2] = ["src/a.rs", "tool.py"];

#[test]
fn on_the_hosts_limit_the_audit_keeps_its_answers_and_stops_then_goes_on_with_the_rest() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    answer(&s.run, &lens[0], &found(&[]));
    let limit = Said {
        limit: Some("  usage   limit reached "),
        ..Said::default()
    };
    let stopped = next(&s.run, &w, &limit);
    assert_eq!(stopped["done"], true);
    assert_eq!(
        stopped["stopped"]["text"], "usage limit reached",
        "{stopped}"
    );
    assert!(
        stopped["resume"]
            .as_str()
            .unwrap()
            .contains("craft audit submit"),
        "{stopped}"
    );
    assert!(status(&s.run).unwrap()["stopped"].is_object());
    // The limit said again changes nothing; a submit without it hands out what is still pending.
    assert_eq!(next(&s.run, &w, &limit)["stopped"], stopped["stopped"]);
    let again = next(&s.run, &w, &Said::default());
    assert_eq!(ids(&again), lens[1..], "{again}");
    assert!(again.get("stopped").is_none());
    assert!(
        w.calls.borrow().is_empty(),
        "a stopped pass files no record"
    );
}

#[test]
fn a_resume_hands_a_missing_answer_out_again_uncounted_and_a_plain_submit_counts_it() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let first = ids(&step)[0].clone();
    let retries = |run: &std::path::Path| {
        let st = state::load(run).unwrap();
        st.tasks.iter().find(|t| t.id == first).unwrap().retries
    };
    next(
        &s.run,
        &w,
        &Said {
            resume: true,
            ..Said::default()
        },
    );
    assert_eq!(retries(&s.run), 0);
    next(&s.run, &w, &Said::default());
    assert_eq!(retries(&s.run), 1);
}

#[test]
fn an_answer_for_no_pending_task_is_refused() {
    let s = scratch(&FILES);
    let w = Fake::default();
    open(&s, args(None), &w);
    let mut given = Map::new();
    given.insert("lens-9-none-x-0".into(), json!({}));
    let got = submit(&s.run, Some(&given), &Said::default(), &w);
    assert!(matches!(got, Err(AuditError::UnknownTask(id)) if id == "lens-9-none-x-0"));
}

#[test]
fn a_lens_that_says_it_could_not_look_fails_and_its_files_stay_unread() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    let blind = json!({"lens": "l", "findings": [], "blocked": {"couldNotLook": true, "what": "no checkout"}});
    answer(&s.run, &lens[0], &blind);
    for id in &lens[1..] {
        answer(&s.run, id, &found(&[]));
    }
    let done = next(&s.run, &w, &Said::default());
    assert_eq!(done["verdict"], "INCOMPLETE", "{done}");
    let st = state::load(&s.run).unwrap();
    let t = st.tasks.iter().find(|t| t.id == lens[0]).unwrap();
    assert!(
        t.error.as_deref().unwrap_or("").contains("no checkout"),
        "{t:?}"
    );
}

#[test]
fn a_finding_whose_verifier_died_is_unjudged_and_a_resume_hands_it_to_a_new_verifier() {
    let s = scratch(&["src/a.rs"]);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    answer(
        &s.run,
        &lens[0],
        &found(&[super::finding("High", "src/a.rs")]),
    );
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
    let vote = json!({"index": 0, "refuted": false, "citedLineMatches": true, "reachable": true,
        "premiseSupported": true, "behaviourIntended": false, "harmSupported": true,
        "confirmedHarmLevel": "outage", "reason": "seen"});
    answer(&s.run, "verify-2-0", &json!({"verdicts": [vote]}));
    let judged = next(&s.run, &w, &Said::default());
    assert_eq!(judged["verdict"], "Block", "{judged}");
    assert!(judged.get("resume").is_none(), "{judged}");
}
