use craft_step::{Model, TaskState};
use serde_json::json;

use super::{Job, answered, batch, buy, jobs, read_by, unanswered};
use crate::batch::Tracked;
use crate::scout::{Scouted, profiles, scout};
use crate::state::Task;

fn file(path: &str) -> Tracked {
    sized(path, 6)
}

fn sized(path: &str, bytes: u64) -> Tracked {
    Tracked {
        path: path.into(),
        bytes,
    }
}

fn scouted() -> Scouted {
    let files = [
        file("src/a.rs"),
        file("src/b.rs"),
        sized("web/app.ts", 3),
        sized("web/rows.json", 3),
    ];
    scout(&files, &profiles().unwrap(), 10)
}

fn lenses_of(profile: &str) -> usize {
    let p = craft_review::profile::Profile::load(profile).unwrap();
    crate::lenses::audited(&p).len()
}

#[test]
fn every_lens_an_audit_runs_reads_every_batch_of_its_profile_none_sampled() {
    let all = jobs(&scouted(), &profiles().unwrap());
    let rust: Vec<&Job> = all.iter().filter(|j| j.profile == "rust").collect();
    assert_eq!(rust.len(), 2 * lenses_of("rust"));
    let general: Vec<&Job> = all.iter().filter(|j| j.profile == "general").collect();
    assert_eq!(general.len(), lenses_of("general"));
    assert!(all.iter().all(|j| batch(&scouted(), j).is_some()));
}

#[test]
fn a_per_file_lens_reads_no_data_file_and_the_security_lens_reads_it() {
    let s = scouted();
    let all = profiles().unwrap();
    let general = super::profile(&all, "general").unwrap();
    let b = &s.parts[1].batches[0];
    let paths = |t: Vec<Tracked>| t.into_iter().map(|f| f.path).collect::<Vec<_>>();
    assert_eq!(paths(read_by(general, "correctness", b)), ["web/app.ts"]);
    assert_eq!(
        paths(read_by(general, "security", b)),
        ["web/app.ts", "web/rows.json"]
    );
}

#[test]
fn a_batch_of_data_alone_gets_only_the_lenses_that_read_data() {
    let s = scout(&[file("a.json")], &profiles().unwrap(), 10);
    let got: Vec<String> = jobs(&s, &profiles().unwrap())
        .into_iter()
        .map(|j| j.lens)
        .collect();
    assert_eq!(got, ["security"]);
}

fn task(job: &Job, state: TaskState) -> Task {
    let mut t = Task::new(
        "t".into(),
        "t".into(),
        "p".into(),
        Model::Opus,
        json!({}),
        job.kind(),
    );
    t.state = state;
    t
}

#[test]
fn only_an_answered_task_reads_its_job_and_a_pass_buys_the_rest_in_order_up_to_its_budget() {
    let all = jobs(&scouted(), &profiles().unwrap());
    let (first, second, third) = (&all[0], &all[1], &all[2]);
    let tasks = [
        task(first, TaskState::Answered),
        task(second, TaskState::Failed),
        task(third, TaskState::Pending),
    ];
    assert!(answered(&tasks, first));
    assert!(!answered(&tasks, second) && !answered(&tasks, third));
    let todo = unanswered(all.clone(), &tasks);
    assert_eq!(todo.len(), all.len() - 1);
    assert_eq!(&todo[0], second);
    assert_eq!(buy(todo.clone(), &[], Some(2)), todo[..2]);
    assert_eq!(buy(todo.clone(), &[], None), todo);
}

#[test]
fn a_pass_buys_the_jobs_never_tried_first_then_the_least_tried_each_tie_in_job_order() {
    let all = jobs(&scouted(), &profiles().unwrap());
    let (a, b, c, d) = (&all[0], &all[1], &all[2], &all[3]);
    let tasks = [
        task(a, TaskState::Failed),
        task(a, TaskState::Failed),
        task(b, TaskState::Failed),
    ];
    let todo = vec![a.clone(), b.clone(), c.clone(), d.clone()];
    assert_eq!(buy(todo.clone(), &tasks, Some(2)), [c.clone(), d.clone()]);
    assert_eq!(
        buy(todo, &tasks, None),
        [c.clone(), d.clone(), b.clone(), a.clone()]
    );
}
