use super::*;
use crate::js::parse;

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn a_usable_cost_is_summed_by_part_and_an_unusable_one_counted_apart_by_why() {
    let mut p = Plan::default();
    let r = rec("{}");
    let usable = parse(r#"{"cacheRead":90,"cacheWrite":4,"input":3,"output":3,"total":100,"agents":1,"rule":"per-message"}"#).unwrap();
    p.add(&Input::of(&r), Some(&usable));
    let usable = parse(r#"{"cacheRead":191,"cacheWrite":4,"input":3,"output":3,"total":201,"agents":1,"rule":"per-message"}"#).unwrap();
    p.add(&Input::of(&r), Some(&usable));
    p.add(&Input::of(&r), Some(&parse(r#""x""#).unwrap()));
    p.add(&Input::of(&r), None);
    assert_eq!(p.priced, 2);
    assert_eq!(
        p.per_run(),
        Some(([141.0, 4.0, 3.0, 3.0], 151.0)),
        "a half rounds up, as Math.round does"
    );
    assert_eq!(p.apart.get(&Problem::Malformed), Some(&1));
    assert!(
        !p.apart.contains_key(&Problem::Missing),
        "a run never enriched is not counted apart"
    );
}

#[test]
fn the_pool_counts_a_marked_run_without_a_usable_cost_by_its_round() {
    let mut p = Plan::default();
    for (round, tokens) in [("1", 100), ("0", 200), ("2", 300), ("null", 50)] {
        let r = rec(&format!(
            r#"{{"round":{round},"outputTokens":{tokens},"outputTokensScope":"turn-delta"}}"#
        ));
        p.add(&Input::of(&r), None);
    }
    p.add(&Input::of(&rec(r#"{"round":2,"outputTokens":9}"#)), None);
    let usable = parse(r#"{"total":5,"cacheRead":5,"rule":"per-message"}"#).unwrap();
    p.add(
        &Input::of(&rec(
            r#"{"round":2,"outputTokens":9,"outputTokensScope":"turn-delta"}"#,
        )),
        Some(&usable),
    );
    let pools: Vec<(u64, f64)> = p.pools.iter().map(|x| (x.runs, x.tokens)).collect();
    assert_eq!(pools, [(2, 300.0), (1, 300.0), (1, 50.0)]);
    assert_eq!(avg(1.0, 2), Some(1.0));
    assert_eq!(avg(1.0, 0), None);
    assert_eq!(js_round(-0.5), 0.0);
}
