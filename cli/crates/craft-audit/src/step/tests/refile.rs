use super::{Fake, args, clean, next, open, scratch};
use crate::AuditError;
use crate::step::{Said, record_path, report_path, submit};

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
    let resume = craft_step::stop::resume("audit", &s.run);
    assert!(
        report.contains(&format!(
            "the store is read-only; resume the run to file it again: `{resume}`"
        )),
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

#[test]
fn the_run_directory_is_written_before_the_store_so_a_failed_write_lands_no_record() {
    let s = scratch(&["tool.py"]);
    let w = Fake::default();
    let step = open(&s, args(None), &w);
    clean(&s.run, &step);
    std::fs::create_dir(record_path(&s.run)).unwrap();
    let got = submit(&s.run, None, &Said::default(), &w);
    assert!(matches!(got, Err(AuditError::Unwritable { .. })), "{got:?}");
    assert!(
        w.calls.borrow().is_empty(),
        "no record lands before its run directory is written"
    );
    std::fs::remove_dir(record_path(&s.run)).unwrap();
    let done = next(&s.run, &w, &Said::default());
    assert_eq!(done["filing"]["record"], "filed", "{done}");
    let calls = w.calls.borrow();
    assert_eq!((calls.len(), calls[0]["retry"].clone()), (1, false.into()));
    assert_eq!(calls[0]["writtenAtWrite"], true);
}
