use super::{Fake, answer, args, clean, found, ids, next, open, scratch};
use crate::AuditError;
use crate::step::{Said, submit, unread_path};

const FILES: [&str; 3] = ["src/a.rs", "src/b.rs", "tool.py"];

const RESUME: Said<'static> = Said {
    degraded: &[],
    limit: None,
    resume: true,
    abandoned: &[],
};

fn unread(run: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(unread_path(run))
        .map(|t| t.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

#[test]
fn a_budget_buys_the_first_jobs_and_the_rest_is_named_unread_never_read_as_clean() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(Some(2)), &w);
    assert_eq!(ids(&step).len(), 2);
    clean(&s.run, &step);
    let done = next(&s.run, &w, &Said::default());
    assert_eq!(done["verdict"], "INCOMPLETE", "{done}");
    assert_eq!(unread(&s.run), FILES);
    assert_eq!(done["unread"]["count"], 3);
    let resume = done["resume"].as_str().unwrap();
    assert!(resume.starts_with("craft audit submit --run '") && resume.ends_with("' --resume"));
    let record = &w.calls.borrow()[0]["record"];
    assert_eq!(record["notRun"][0], "audit:unread-files:3");
}

#[test]
fn each_resume_reads_only_what_the_passes_before_left_unread_until_every_file_is_read() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let mut step = open(&s, args(Some(2)), &w);
    let mut seen: Vec<String> = Vec::new();
    let mut pass = 1;
    loop {
        let handed = ids(&step);
        assert!(
            handed
                .iter()
                .all(|id| id.starts_with(&format!("lens-{pass}-"))),
            "{handed:?}"
        );
        seen.extend(handed.iter().map(|id| {
            id.split_once('-')
                .unwrap()
                .1
                .split_once('-')
                .unwrap()
                .1
                .to_owned()
        }));
        clean(&s.run, &step);
        let done = next(&s.run, &w, &Said::default());
        if done.get("unread").is_none() {
            assert_eq!(done["verdict"], "Approve", "{done}");
            break;
        }
        pass += 1;
        step = next(&s.run, &w, &RESUME);
        assert_eq!(step["pass"], pass);
    }
    let once: std::collections::HashSet<&String> = seen.iter().collect();
    assert_eq!(once.len(), seen.len(), "no job is read twice: {seen:?}");
    assert!(!unread_path(&s.run).exists());
    assert_eq!(w.calls.borrow().len(), pass, "one record per finished pass");
    let again = submit(&s.run, None, &RESUME, &w);
    assert!(matches!(again, Err(AuditError::Done(_))), "{again:?}");
}

#[test]
fn a_lens_whose_agent_died_leaves_its_files_unread_and_the_resume_hands_out_that_job_alone() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    let lens = ids(&step);
    for id in &lens[1..] {
        answer(&s.run, id, &found(&[]));
    }
    let dead = [lens[0].clone()];
    let said = Said {
        abandoned: &dead,
        ..Said::default()
    };
    let done = next(&s.run, &w, &said);
    assert_eq!(done["verdict"], "INCOMPLETE");
    assert_eq!(unread(&s.run), ["src/a.rs"]);
    let again = next(&s.run, &w, &RESUME);
    let rest = lens[0].strip_prefix("lens-1-").unwrap();
    assert_eq!(ids(&again), [format!("lens-2-{rest}")]);
}

#[test]
fn a_finished_audit_submitted_without_resume_is_refused_as_done() {
    let s = scratch(&FILES);
    let w = Fake::default();
    let step = open(&s, args(Some(1)), &w);
    clean(&s.run, &step);
    next(&s.run, &w, &Said::default());
    let got = submit(&s.run, None, &Said::default(), &w);
    assert!(matches!(got, Err(AuditError::Done(_))), "{got:?}");
}
