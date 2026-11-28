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
    add(&rec(light), "review (cli)", &mut kinds, &mut Vec::new()).unwrap();
    let light = r#"{"depth":"light","lensScope":"delta","runtimeStats":{"wallClockMinutes":2,"agents":-1}}"#;
    add(&rec(light), "review (cli)", &mut kinds, &mut Vec::new()).unwrap();
    add(
        &rec(r#"{"depth":"","runtimeStats":null}"#),
        "triage-findings",
        &mut kinds,
        &mut Vec::new(),
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

#[test]
fn a_kind_sums_the_usable_costs_and_counts_the_others_by_why() {
    let mut kinds = BTreeMap::new();
    let priced = |t: u64| format!(r#"{{"cost":{{"total":{t},"agents":1,"rule":"per-message"}}}}"#);
    add(&rec(&priced(100)), "review", &mut kinds, &mut Vec::new()).unwrap();
    add(&rec(&priced(300)), "review", &mut kinds, &mut Vec::new()).unwrap();
    add(
        &rec(r#"{"cost":{"total":5,"agents":1}}"#),
        "review",
        &mut kinds,
        &mut Vec::new(),
    )
    .unwrap();
    add(
        &rec(r#"{"cost":{"total":5,"agents":1,"rule":"per-message","skipped":1}}"#),
        "review",
        &mut kinds,
        &mut Vec::new(),
    )
    .unwrap();
    add(&rec("{}"), "review", &mut kinds, &mut Vec::new()).unwrap();
    let k = &kinds["review"];
    assert_eq!((k.priced, k.cost_per_run()), (2, Some(200.0)));
    let why: Vec<(&str, u64)> = k.unpriced.iter().map(|(p, n)| (p.as_str(), *n)).collect();
    assert_eq!(why, [("missing", 1), ("overcounted", 1), ("partial", 1)]);
}
