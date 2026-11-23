//! A metrics lens the critic admits is handed and sifted as the rounds hand and sift theirs.

use serde_json::json;

use super::lens_task;
use super::tests::{plan, run_with};
use crate::profile::Profile;
use crate::state::{TaskKind, TaskState};

#[test]
fn a_complexity_lens_the_critic_admits_answers_with_the_metrics_schema_and_is_sifted() {
    let rust = Profile::rust().unwrap();
    let run = run_with(&plan("large", false, &["errors"], &[]));
    let p = run.tracks[0].plan.clone().unwrap();
    let mut task = lens_task(&run, &rust, &p, "complexity").unwrap();
    let metrics = "/properties/findings/items/properties/metrics";
    assert!(
        task.schema == crate::complexity::findings_schema().unwrap(),
        "a critic-admitted complexity lens answers with the metrics schema, which carries `metrics`"
    );
    let plain = lens_task(&run, &rust, &p, "maintainability").unwrap();
    assert!(plain.schema.pointer(metrics).is_none());

    assert!(matches!(task.kind, TaskKind::CriticLens { .. }));
    task.state = TaskState::Answered;
    task.answer = Some(json!({"lens": "complexity", "findings": [
        {"title": "bare", "metrics": {"function": "f"}},
        {"title": "measured", "why": "w", "metrics": {"function": "f", "cognitive": 23}},
    ]}));
    let mut tasks = vec![task];
    let notes = crate::complexity::sift(&mut tasks, &[rust]);
    assert_eq!(notes.len(), 1, "{notes:?}");
    let kept = tasks[0].answer.as_ref().unwrap()["findings"]
        .as_array()
        .unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["title"], json!("measured"));
}
