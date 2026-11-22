//! A refused answer file is moved aside only after the state counting its refusal is saved, and a
//! file left in place is counted once, however often it is read again.

mod common;

use common::{fixture, ids, opts, prompt_of, write_answer};
use craft_review::{state, status, step};

const SCOUT: &str = "scout-rust";

#[expect(
    clippy::unwrap_used,
    reason = "a step of the test, failing loudly like it"
)]
fn retries(run: &std::path::Path) -> u32 {
    let st = state::load(run).unwrap();
    st.tasks.iter().find(|t| t.id == SCOUT).unwrap().retries
}

#[test]
fn a_refused_file_stays_in_place_when_the_state_is_not_saved() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(&run, None).unwrap();
    assert_eq!((ids(&s), retries(&run)), (vec![SCOUT.to_owned()], 1));
    write_answer(&s, SCOUT, "{\"sizeBucket\": ");
    // The state's temporary file cannot be written: the save fails.
    let blocker = run.join("state.json.tmp");
    std::fs::create_dir(&blocker).unwrap();
    step::submit(&run, None).expect_err("the state cannot be saved");
    assert!(
        run.join("answers/scout-rust.json").is_file(),
        "nothing set aside before the state saying why is saved"
    );
    assert_eq!(retries(&run), 1);
    std::fs::remove_dir(&blocker).unwrap();
    let s = step::submit(&run, None).unwrap();
    assert!(prompt_of(&s["tasks"][0]).contains("is not JSON"), "{s}");
    assert!(run.join("answers/scout-rust.rejected-1.json").is_file());
    assert_eq!(retries(&run), 2);
}

/// `answers/` read-only while it lives, so no refused file can be moved aside; `None` where the
/// test runs with rights that write there anyway (root).
#[cfg(unix)]
struct Locked(std::path::PathBuf);

#[cfg(unix)]
impl Locked {
    #[expect(
        clippy::unwrap_used,
        reason = "a step of the test, failing loudly like it"
    )]
    fn new(answers: &std::path::Path) -> Option<Self> {
        use std::os::unix::fs::PermissionsExt;
        let locked = Self(answers.to_owned());
        std::fs::set_permissions(answers, std::fs::Permissions::from_mode(0o555)).unwrap();
        let probe = answers.join(".probe");
        std::fs::write(&probe, "")
            .is_err()
            .then_some(locked)
            .or_else(|| {
                std::fs::remove_file(&probe).unwrap();
                None
            })
    }
}

#[cfg(unix)]
impl Drop for Locked {
    #[expect(clippy::panic, reason = "a step of the test, failing loudly like it")]
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        // Left read-only, the temporary directory cannot be removed: say so loudly.
        if let Err(e) = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755)) {
            panic!("restoring {}: {e}", self.0.display());
        }
    }
}

#[cfg(unix)]
#[expect(
    clippy::unwrap_used,
    reason = "a step of the test, failing loudly like it"
)]
fn noted(run: &std::path::Path, text: &str) -> bool {
    let st = status::status(run).unwrap();
    st.get("notes")
        .and_then(serde_json::Value::as_array)
        .unwrap()
        .iter()
        .any(|n| n.as_str().is_some_and(|n| n.contains(text)))
}

#[cfg(unix)]
#[test]
fn a_file_the_set_aside_could_not_move_is_counted_once() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(&run, None).unwrap();
    write_answer(&s, SCOUT, "{\"sizeBucket\": ");
    let answers = run.join("answers");
    let Some(lock) = Locked::new(&answers) else {
        return; // root writes through the lock: nothing to test here
    };
    let s = step::submit(&run, None);
    drop(lock);
    let s = s.expect("a set-aside that fails after the save fails no submit");
    assert_eq!((ids(&s), retries(&run)), (vec![SCOUT.to_owned()], 2));
    assert!(answers.join("scout-rust.json").is_file());
    assert!(noted(&run, "set aside uncounted"));
    // Read again, the same file is the refusal already counted: its retries are not spent by it.
    let s = step::submit(&run, None).unwrap();
    assert_eq!((ids(&s), retries(&run)), (vec![SCOUT.to_owned()], 2));
    assert!(!answers.join("scout-rust.json").exists());
    assert!(answers.join("scout-rust.rejected-1.json").is_file());
}

#[cfg(unix)]
#[test]
fn a_file_that_never_moves_fails_its_task() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(&run, None).unwrap();
    write_answer(&s, SCOUT, "{\"sizeBucket\": ");
    let Some(_lock) = Locked::new(&run.join("answers")) else {
        return; // root writes through the lock: nothing to test here
    };
    let counted = step::submit(&run, None).unwrap();
    let again = step::submit(&run, None).unwrap();
    assert_eq!(
        (ids(&counted), ids(&again)),
        (vec![SCOUT.to_owned()], vec![SCOUT.to_owned()])
    );
    assert_eq!(retries(&run), 2);
    // Found there a third time, it is no new answer: the scout fails, the plan goes on without it.
    let s = step::submit(&run, None).unwrap();
    assert!(ids(&s).len() > 1, "{s}");
    let st = status::status(&run).unwrap();
    assert!(
        st.get("notRun")
            .is_some_and(|n| n.to_string().contains("no new answer was written")),
        "{st}"
    );
    assert!(noted(&run, "its task is settled"));
}
