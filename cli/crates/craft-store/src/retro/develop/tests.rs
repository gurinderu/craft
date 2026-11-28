use super::*;
use crate::js::parse;

fn add(d: &mut Develop, develop: &str) {
    let r = parse(&format!(r#"{{"develop":{develop}}}"#)).unwrap();
    d.add(r.as_obj().unwrap());
}

#[test]
fn cycles_count_by_outcome_and_mode_with_the_open_medium_plus_of_each_round() {
    let mut d = Develop::default();
    let round =
        |m: &str| format!(r#"{{"engine":"e","scope":"full","verdict":"v","mediumPlus":{m}}}"#);
    add(
        &mut d,
        &format!(
            r#"{{"outcome":"converged","rounds":[{},{}],"fullReviews":[{{"afterRound":1,"engine":"e","verdict":"v","mediumPlus":2}}]}}"#,
            round("2"),
            round("0")
        ),
    );
    add(
        &mut d,
        &format!(
            r#"{{"mode":"full","outcome":"no-verdict","rounds":[{}],"fullReviews":[{{"afterRound":1,"engine":"e","verdict":"v","mediumPlus":null}}]}}"#,
            round("null")
        ),
    );
    add(
        &mut d,
        &format!(r#"{{"outcome":"capped","rounds":[{}]}}"#, round("1")),
    );
    add(&mut d, r#"{"outcome":"converged","rounds":[]}"#);
    add(&mut d, "7");
    assert_eq!(
        (d.cycles, d.unreadable, d.converged, d.capped, d.no_verdict),
        (3, 2, 1, 1, 1)
    );
    assert_eq!(
        (d.light, d.full, d.rounds, d.converged_rounds),
        (2, 1, 4, 2)
    );
    assert_eq!(d.by_round, [(3, 3.0), (1, 0.0)]);
    assert_eq!(
        (d.full_reviews, d.full_reopened, d.full_no_verdict),
        (2, 1, 1)
    );
    assert_eq!(d.rounds_per_cycle(), (1.3, 2.0));
    assert_eq!(tenths(1.0, 0), 0.0);
}
