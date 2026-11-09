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
