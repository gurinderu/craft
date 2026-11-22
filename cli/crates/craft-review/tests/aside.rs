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

#[cfg(unix)]
#[test]
fn a_file_the_set_aside_could_not_move_is_counted_once() {
    use std::os::unix::fs::PermissionsExt;
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(&run, None).unwrap();
    write_answer(&s, SCOUT, "{\"sizeBucket\": ");
    let answers = run.join("answers");
    let mode = |m| std::fs::set_permissions(&answers, std::fs::Permissions::from_mode(m)).unwrap();
    mode(0o555);
    let s = step::submit(&run, None);
    mode(0o755);
    let s = s.expect("a set-aside that fails after the save fails no submit");
    assert_eq!((ids(&s), retries(&run)), (vec![SCOUT.to_owned()], 2));
    assert!(answers.join("scout-rust.json").is_file());
    let st = status::status(&run).unwrap();
    assert!(
        st["notes"].as_array().unwrap().iter().any(|n| n
            .as_str()
            .unwrap()
            .contains("moved aside on the next submit")),
        "{st}"
    );
    // Read again, the same file is the refusal already counted: its retries are not spent by it.
    let s = step::submit(&run, None).unwrap();
    assert_eq!((ids(&s), retries(&run)), (vec![SCOUT.to_owned()], 2));
    assert!(!answers.join("scout-rust.json").exists());
    assert!(answers.join("scout-rust.rejected-2.json").is_file());
}
