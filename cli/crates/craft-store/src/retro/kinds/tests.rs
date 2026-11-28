use super::*;
use crate::js::parse;

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn a_kind_is_the_workflow_with_its_depth_and_scope_and_sums_what_its_runs_recorded() {
    let mut kinds = BTreeMap::new();
    let light =
        r#"{"depth":"light","lensScope":"delta","runtimeStats":{"wallClockMinutes":4,"agents":6}}"#;
    add(&rec(light), "review (cli)", &mut kinds).unwrap();
    let light = r#"{"depth":"light","lensScope":"delta","runtimeStats":{"wallClockMinutes":2,"agents":-1}}"#;
    add(&rec(light), "review (cli)", &mut kinds).unwrap();
    add(
        &rec(r#"{"depth":"","runtimeStats":null}"#),
        "triage-findings",
        &mut kinds,
    )
    .unwrap();
    let delta = &kinds["review (cli) · light · delta"];
    assert_eq!((delta.runs, delta.timed, delta.counted), (2, 2, 1));
    assert_eq!(delta.minutes_per_run(), Some(3.0));
    assert_eq!(
        delta.agents_per_run(),
        Some(6.0),
        "a negative count is no count"
    );
    let triage = &kinds["triage-findings"];
    assert_eq!((triage.runs, triage.minutes_per_run()), (1, None));
}
