//! A stopped run's record that did not land is filed again before a resume does anything else: a
//! resume refused for a moved checkout still files it.
mod common;

use std::cell::RefCell;

use common::{fixture, git, small_run};
use craft_review::filing::{self, Call, Ctx, Host, WriteError, Writer};
use craft_review::state;
use craft_review::step::{self, Said};
use serde_json::{Value, json};

/// A writer whose records land only when `up`, keeping every call's command and retry flag.
struct Store {
    up: bool,
    calls: RefCell<Vec<(String, Value)>>,
}

impl Writer for Store {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        self.calls.borrow_mut().push((
            call.command.to_owned(),
            call.request.get("retry").cloned().unwrap_or(Value::Null),
        ));
        if !self.up {
            return Err(WriteError::NoNode);
        }
        Ok(match call.command {
            "checkpoint" => json!({"phase": "start", "runDir": "/store/.partial/a"}),
            _ => json!({"ok": true, "reason": "", "file": "/store/r.json"}),
        })
    }
}

#[test]
fn a_resume_refused_for_a_moved_checkout_still_files_the_stopped_parts_record() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, first) = small_run(repo.path(), out.path());
    let down = Store {
        up: false,
        calls: RefCell::default(),
    };
    let mut ctx = Ctx::of(&state::load(&run).unwrap(), "0.44.0", "");
    ctx.root = Some("/plugin".into());
    filing::open(&run, ctx, "s", &first, &down);
    let said = Said {
        limit: Some("You've hit your limit"),
        ..Said::default()
    };
    let stopped = step::submit_with(&run, None, &said).unwrap();
    let filed = filing::submitted(&run, &stopped, &Host::default(), Vec::new(), &down).unwrap();
    assert_eq!(filed["record"], json!("failed"));

    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 2 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "fix: f"]);
    let up = Store {
        up: true,
        calls: RefCell::default(),
    };
    // As `craft review submit --resume` runs them: the re-filing first, then the resume itself.
    let lost = filing::resuming(&run, &up);
    let refused = step::submit_with(
        &run,
        None,
        &Said {
            resume: true,
            ..Said::default()
        },
    );
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .starts_with("HEAD moved since this run stopped")
    );
    assert!(lost.is_empty(), "{lost:?}");
    assert_eq!(
        *up.calls.borrow(),
        [("finalize".to_owned(), json!(true))],
        "the stopped part's record, as a retry"
    );
    assert_eq!(filing::summary(&run).unwrap()["pending"], json!(0));
}

/// A filing kept before it carried the run's identity is completed from the state, and every write
/// then carries it: the shared git directory the round chain keys on, the branch, the head and
/// whether the run read uncommitted work.
#[test]
fn every_write_carries_the_identity_the_run_had_when_it_started() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, first) = small_run(repo.path(), out.path());
    let state = state::load(&run).unwrap();
    let git_out = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    };
    let common = git_out(
        repo.path(),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    let branch = git_out(repo.path(), &["rev-parse", "--abbrev-ref", "HEAD"]);
    let mut ctx = Ctx::of(&state, "0.45.0", "");
    assert_eq!(
        (ctx.git_dir.as_str(), ctx.branch.as_deref(), ctx.dirty),
        (common.as_str(), Some(branch.as_str()), false)
    );
    ctx.root = Some("/plugin".into());
    let sent = Sent::default();
    filing::open(
        &run,
        Ctx {
            git_dir: String::new(),
            branch: None,
            ..ctx
        },
        "s",
        &first,
        &sent,
    );
    assert_eq!(
        sent.0.borrow()[0]["gitDir"],
        json!(""),
        "kept before it had one"
    );
    filing::adopt(&run, None);
    filing::submitted(&run, &first, &Host::default(), Vec::new(), &sent);
    let last = sent.0.borrow().last().cloned().unwrap();
    assert_eq!(
        (
            last["gitDir"].clone(),
            last["branch"].clone(),
            last["head"].clone(),
            last["dirty"].clone()
        ),
        (
            json!(common),
            json!(branch),
            json!(state.diff.head),
            json!(false)
        )
    );
}

/// A writer that lands every write, keeping each request.
#[derive(Default)]
struct Sent(RefCell<Vec<Value>>);

impl Writer for Sent {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        self.0.borrow_mut().push(call.request.clone());
        Ok(
            json!({"phase": "lenses", "runDir": "/store/.partial/a", "ok": true, "file": "/store/r.json"}),
        )
    }
}
