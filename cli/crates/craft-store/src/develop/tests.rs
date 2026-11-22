use super::*;
use crate::js::parse;

fn cycle(text: &str) -> Result<Obj, String> {
    let payload = parse(text).map_err(|e| e.to_string())?;
    cycle_record(payload.as_obj().unwrap_or(&Obj::new()))
}

#[test]
fn a_converged_cycle_is_filed_with_its_rounds_numbered_and_its_texts_trimmed() {
    let r = cycle(r#"{"outcome":"converged","rounds":[{"engine":" review ","scope":"full","verdict":"Block","mediumPlus":2},{"engine":"review","scope":"delta","verdict":"Approve","mediumPlus":0}],"fullReviews":[{"afterRound":2,"engine":"review","verdict":"Approve","mediumPlus":0}]}"#).unwrap();
    assert_eq!(
        Js::Obj(r).compact(),
        r#"{"schemaVersion":1,"runtime":"claude-code","kind":"develop","name":"develop","verdict":"converged","round":2,"develop":{"mode":"light","outcome":"converged","rounds":[{"n":1,"engine":"review","scope":"full","verdict":"Block","mediumPlus":2},{"n":2,"engine":"review","scope":"delta","verdict":"Approve","mediumPlus":0}],"fullReviews":[{"afterRound":2,"engine":"review","verdict":"Approve","mediumPlus":0}]}}"#
    );
}

#[test]
fn the_first_field_that_does_not_fit_is_named() {
    let round = r#"{"engine":"review","scope":"full","verdict":"Approve","mediumPlus":0}"#;
    for (text, why) in [
        (r#"{"rounds":[]}"#.to_owned(), "outcome must be one of converged, capped, no-verdict, got undefined"),
        (r#"{"outcome":"capped","rounds":[]}"#.to_owned(), "rounds must hold 1 to 12 round(s)"),
        (r#"{"mode":"deep","outcome":"capped"}"#.to_owned(), r#"mode must be one of light, full, got "deep""#),
        (r#"{"outcome":"capped","rounds":[{"engine":"r","scope":"all"}]}"#.to_owned(), r#"rounds[0].scope must be "full" or "delta", got "all""#),
        (r#"{"outcome":"capped","rounds":[{"engine":"a\nb","scope":"full"}]}"#.to_owned(), r#"rounds[0].engine must be a one-line string of at most 120 chars, got "a\nb""#),
        (r#"{"outcome":"capped","rounds":[{"engine":"r","scope":"full","verdict":"v","mediumPlus":-1}]}"#.to_owned(), "rounds[0].mediumPlus must be a non-negative integer or null, got -1"),
        (format!(r#"{{"outcome":"capped","rounds":[{round}],"fullReviews":{{}}}}"#), "fullReviews must be an array"),
        (format!(r#"{{"outcome":"capped","rounds":[{round}],"fullReviews":[{{"afterRound":2}}]}}"#), "fullReviews[0].afterRound must name one of the 1 round(s), got 2"),
        (format!(r#"{{"outcome":"converged","rounds":[{round}],"fullReviews":[{{"afterRound":1,"engine":"e","verdict":"Block","mediumPlus":1}}]}}"#), "outcome \"converged\" needs the last round, and a full review after it, to leave no open Medium+"),
    ] {
        assert_eq!(cycle(&text).unwrap_err(), why, "{text}");
    }
}
