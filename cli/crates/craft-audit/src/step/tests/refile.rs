use super::{Fake, args, clean, next, open, scratch};
use crate::AuditError;
use crate::step::{Said, report_path, submit};

const RESUME: Said<'static> = Said {
    degraded: &[],
    limit: None,
    resume: true,
    abandoned: &[],
};

#[test]
fn a_record_that_did_not_land_leads_the_report_and_a_resume_files_it_again_as_a_retry() {
    let s = scratch(&["tool.py"]);
    let w = Fake::default();
    *w.refuse.borrow_mut() = true;
    let step = open(&s, args(None), &w);
    clean(&s.run, &step);
    let done = next(&s.run, &w, &Said::default());
    assert_eq!(done["filing"]["record"], "failed", "{done}");
    let report = std::fs::read_to_string(report_path(&s.run)).unwrap();
    assert!(
        report.starts_with(
            "# craft audit\n\n> **Not filed**: the run record — the store is read-only"
        ),
        "{report}"
    );
    *w.refuse.borrow_mut() = false;
    let refiled = next(&s.run, &w, &RESUME);
    assert_eq!(refiled["filing"]["record"], "filed", "{refiled}");
    assert_eq!(w.calls.borrow()[1]["retry"], true);
    let report = std::fs::read_to_string(report_path(&s.run)).unwrap();
    assert!(!report.contains("Not filed"), "{report}");
    let again = submit(&s.run, None, &RESUME, &w);
    assert!(matches!(again, Err(AuditError::Done(_))), "{again:?}");
}

#[test]
fn a_run_that_does_not_record_files_nothing_and_its_finished_resume_is_done() {
    let s = scratch(&["tool.py"]);
    let w = Fake::default();
    let step = open(
        &s,
        crate::state::Args {
            record: None,
            ..args(None)
        },
        &w,
    );
    clean(&s.run, &step);
    let done = next(&s.run, &w, &Said::default());
    assert!(done.get("filing").is_none(), "{done}");
    assert!(w.calls.borrow().is_empty());
    let again = submit(&s.run, None, &RESUME, &w);
    assert!(matches!(again, Err(AuditError::Done(_))), "{again:?}");
}
