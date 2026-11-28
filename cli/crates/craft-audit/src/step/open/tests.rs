use super::{StartOptions, bad_path, check_start, start};
use crate::AuditError;
use crate::step::tests::{Fake, args, ids, scratch};

#[test]
fn a_path_must_name_a_part_of_the_project_from_its_root() {
    for ok in ["src", "src/", "a b/c.rs", "web/app.ts"] {
        assert_eq!(bad_path(ok), None, "{ok}");
    }
    for bad in [
        "", "  ", "/etc", "../other", "src/../x", ".", "./src", "a\nb",
    ] {
        assert!(bad_path(bad).is_some(), "{bad:?}");
    }
}

fn opts(s: &crate::step::tests::Scratch, a: crate::state::Args) -> StartOptions {
    StartOptions {
        cwd: s.repo.clone(),
        run_dir: s.run.clone(),
        args: a,
    }
}

fn refused(got: Result<impl std::fmt::Debug, AuditError>) -> String {
    match got {
        Err(e) => {
            assert!(e.refuses_argument(), "{e}");
            e.to_string()
        }
        Ok(v) => panic!("not refused: {v:?}"),
    }
}

#[test]
fn a_budget_of_nothing_and_a_bad_path_are_refused_before_any_agent() {
    let s = scratch(&["tool.py"]);
    let zero = crate::state::Args {
        batch_bytes: 0,
        ..args(None)
    };
    assert!(refused(check_start(&opts(&s, zero))).contains("at least one byte"));
    assert!(refused(check_start(&opts(&s, args(Some(0))))).contains("at least one agent"));
    let up = crate::state::Args {
        paths: vec!["../x".into()],
        ..args(None)
    };
    assert!(refused(check_start(&opts(&s, up))).contains("\"../x\""));
    assert!(!s.run.exists(), "nothing is written for a refused run");
}

#[test]
fn a_path_under_which_git_tracks_nothing_is_refused_not_read_as_a_clean_audit() {
    let s = scratch(&["src/a.rs", "tool.py"]);
    let w = Fake::default();
    let typo = crate::state::Args {
        paths: vec!["scr".into()],
        ..args(None)
    };
    assert!(refused(start(&opts(&s, typo), &w)).contains("\"scr\" holds no file"));
    let prefix = crate::state::Args {
        paths: vec!["src/a".into()],
        ..args(None)
    };
    assert!(refused(start(&opts(&s, prefix), &w)).contains("holds no file"));
    let under = crate::state::Args {
        paths: vec!["src/".into()],
        ..args(None)
    };
    let step = start(&opts(&s, under), &w).unwrap();
    assert!(ids(&step).iter().all(|id| id.contains("-rust-")), "{step}");
}

#[test]
fn a_directory_outside_git_is_refused_and_a_run_directory_in_use_is_not_reused() {
    let d = tempfile::tempdir().unwrap();
    let outside = StartOptions {
        cwd: d.path().to_path_buf(),
        run_dir: d.path().join("run"),
        args: args(None),
    };
    assert!(matches!(
        check_start(&outside),
        Err(AuditError::NotGit { .. })
    ));
    let s = scratch(&["tool.py"]);
    start(&opts(&s, args(None)), &Fake::default()).unwrap();
    let got = check_start(&opts(&s, args(None)));
    assert!(matches!(got, Err(AuditError::RunExists(_))), "{got:?}");
}

#[test]
fn an_audit_started_in_a_subdirectory_reads_the_whole_repository_from_its_root() {
    let s = scratch(&["sub/x.py", "tool.py"]);
    let inner = StartOptions {
        cwd: s.repo.join("sub"),
        ..opts(&s, args(None))
    };
    assert_eq!(check_start(&inner).unwrap(), s.repo.canonicalize().unwrap());
    let st = start(&inner, &Fake::default()).unwrap();
    let prompt = std::fs::read_to_string(st["tasks"][0]["promptFile"].as_str().unwrap()).unwrap();
    assert!(prompt.contains("- `sub/x.py`"), "{prompt}");
}

#[test]
fn every_path_given_must_hold_a_tracked_file_and_one_may_name_a_file() {
    let s = scratch(&["src/a.rs", "tool.py"]);
    let w = Fake::default();
    let one_bad = crate::state::Args {
        paths: vec!["src".into(), "nowhere".into()],
        ..args(None)
    };
    assert!(refused(start(&opts(&s, one_bad), &w)).contains("\"nowhere\" holds no file"));
    let file = crate::state::Args {
        paths: vec!["tool.py".into()],
        ..args(None)
    };
    let step = start(&opts(&s, file), &w).unwrap();
    assert!(
        ids(&step).iter().all(|id| id.contains("-general-")),
        "{step}"
    );
}
