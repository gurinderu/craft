//! Taking answers over a kind that adds nothing: a refused answer file stays where its agent wrote
//! it until the kind applies the set-aside after saving its state.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{Hold, take_pending};
use crate::handoff::{Aside, answers_dir};
use crate::{Kind, Model, Task, TaskState};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
struct Empty {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum Plain {
    #[serde(rename = "plain")]
    Plain,
}

impl Kind for Plain {
    type Agent = String;
    type Marks = Empty;
    type Flags = Empty;

    fn tag(&self) -> &'static str {
        "plain"
    }
}

fn task() -> Task<Plain> {
    let schema = json!({"type": "object", "required": ["ok"]});
    Task::new(
        "t".into(),
        "t".into(),
        "p".into(),
        Model::Haiku,
        schema,
        Plain::Plain,
    )
}

#[test]
fn a_refused_answer_is_moved_aside_only_when_applied() {
    let d = tempfile::tempdir().unwrap();
    let answers = answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("t.json"), "{}").unwrap();
    let mut tasks = [task()];
    let mut aside = Aside::default();
    let live = take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert!(live);
    assert_eq!((tasks[0].state, tasks[0].retries), (TaskState::Pending, 1));
    // Cut off here, before the state is saved, the refused file is still where it was written.
    assert!(answers.join("t.json").is_file());
    assert!(aside.apply().is_empty());
    assert!(!answers.join("t.json").exists());
    assert!(answers.join("t.rejected-0.json").is_file());
}

#[test]
fn an_accepted_answer_stays_in_place() {
    let d = tempfile::tempdir().unwrap();
    let answers = answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("t.json"), r#"{"ok": true}"#).unwrap();
    let mut tasks = [task()];
    let mut aside = Aside::default();
    take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert!(aside.apply().is_empty());
    assert_eq!(tasks[0].state, TaskState::Answered);
    assert!(answers.join("t.json").is_file());
}

#[test]
fn a_refused_file_read_again_before_it_is_set_aside_is_counted_once() {
    let d = tempfile::tempdir().unwrap();
    let answers = answers_dir(d.path());
    std::fs::create_dir_all(&answers).unwrap();
    std::fs::write(answers.join("t.json"), "{}").unwrap();
    let mut tasks = [task()];
    let cut_off = {
        let mut aside = Aside::default();
        take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
        aside
    };
    // The state saved, the set-aside never applied: the same file is read again.
    drop(cut_off);
    let mut aside = Aside::default();
    let live = take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert!(live);
    assert_eq!((tasks[0].state, tasks[0].retries), (TaskState::Pending, 1));
    assert!(aside.apply().is_empty());
    assert!(!answers.join("t.json").exists());
    // The agent's next answer, the same bytes written anew, is a refusal of its own.
    let again = answers.join("t.json");
    std::fs::write(&again, "{}").unwrap();
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    std::fs::File::options()
        .write(true)
        .open(&again)
        .unwrap()
        .set_modified(later)
        .unwrap();
    let mut aside = Aside::default();
    take_pending(d.path(), &mut tasks, None, Hold::Nothing, &mut aside).unwrap();
    assert_eq!((tasks[0].state, tasks[0].retries), (TaskState::Pending, 2));
    assert!(aside.apply().is_empty());
}
