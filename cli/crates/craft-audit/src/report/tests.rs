use craft_step::{Model, TaskState};
use serde_json::{Value, json};

use super::{NOTHING, summary, verdict};
use crate::batch::Tracked;
use crate::plan::{Job, jobs};
use crate::scout::{profiles, scout};
use crate::state::{Args, AuditState, Phase, STATE_VERSION, Task};

mod markdown;

pub(super) fn settled(sev: &str, tier: &str) -> Value {
    json!({"severity": sev, "tier": tier, "title": "t", "file": "a.rs", "line": 2, "why": "w", "source": "errors"})
}

#[test]
fn the_verdict_is_the_worst_confirmed_severity_and_incomplete_when_something_was_not_read() {
    let v = |f: &[Value], inc| verdict(f, inc);
    assert_eq!(v(&[], false), "Approve");
    assert_eq!(
        v(
            &[settled("High", "suspected"), settled("Low", "confirmed")],
            false
        ),
        "Approve"
    );
    assert_eq!(v(&[settled("Medium", "confirmed")], false), "Warning");
    assert_eq!(
        v(
            &[
                settled("Medium", "confirmed"),
                settled("Critical", "confirmed")
            ],
            false
        ),
        "Block"
    );
    let worst_first = [
        settled("Critical", "confirmed"),
        settled("Medium", "confirmed"),
    ];
    assert_eq!(v(&worst_first, false), "Block");
    assert_eq!(v(&[], true), "INCOMPLETE");
    assert_eq!(
        v(&[settled("High", "confirmed")], true),
        "Block (INCOMPLETE)"
    );
}

pub(super) fn state(files: &[&str]) -> AuditState {
    let tracked: Vec<Tracked> = files
        .iter()
        .map(|p| Tracked {
            path: (*p).into(),
            bytes: 6,
        })
        .chain([Tracked {
            path: "README.md".into(),
            bytes: 1,
        }])
        .collect();
    AuditState {
        version: STATE_VERSION,
        cwd: "/r".into(),
        args: Args::default(),
        scout: scout(&tracked, &profiles().unwrap(), 10),
        phase: Phase::Done,
        pass: 1,
        tasks: Vec::new(),
        degraded: Vec::new(),
        notes: Vec::new(),
        stopped: None,
    }
}

pub(super) fn answered(job: &Job, findings: &Value) -> Task {
    let mut t = Task::new(
        "t".into(),
        "t".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        job.kind(),
    );
    t.state = TaskState::Answered;
    t.answer = Some(json!({"lens": job.lens, "findings": findings}));
    t
}

#[test]
fn a_file_is_read_only_once_every_lens_over_it_answered() {
    let mut s = state(&["a.rs", "b.rs"]);
    let all = jobs(&s.scout, &profiles().unwrap());
    // Every job over a.rs answered, all but one over b.rs.
    let (b, a): (Vec<&Job>, Vec<&Job>) = all.iter().partition(|j| j.batch == 1);
    s.tasks = a
        .iter()
        .chain(b.iter().skip(1))
        .map(|j| answered(j, &json!([])))
        .collect();
    let sum = summary(&s, &profiles().unwrap());
    assert_eq!(sum.unread, ["b.rs"]);
    assert_eq!((sum.jobs, sum.answered), (all.len(), all.len() - 1));
    assert_eq!(sum.verdict, "INCOMPLETE");
    s.tasks.push(answered(b[0], &json!([settled("Low", "")])));
    let sum = summary(&s, &profiles().unwrap());
    assert!(sum.unread.is_empty());
    assert_eq!(sum.verdict, "Approve");
    assert_eq!(sum.held().len(), 1);
}

#[test]
fn a_project_whose_profiles_take_no_file_has_nothing_to_audit() {
    let sum = summary(&state(&[]), &profiles().unwrap());
    assert_eq!((sum.verdict.as_str(), sum.jobs), (NOTHING, 0));
}

#[test]
fn the_tiers_are_counted_confirmed_suspected_refuted_unverified() {
    let sum = super::Summary {
        verdict: String::new(),
        unread: Vec::new(),
        jobs: 0,
        answered: 0,
        settled: [
            "confirmed",
            "confirmed",
            "refuted",
            "",
            "suspected",
            "unverified",
        ]
        .iter()
        .map(|t| settled("Low", t))
        .collect(),
        left: Vec::new(),
    };
    assert_eq!(sum.tiers(), [2, 1, 1, 2]);
}
