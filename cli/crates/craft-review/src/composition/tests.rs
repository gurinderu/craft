//! The composition as the profiles check it, its round ceiling as the rounds read it, and the plan
//! it holds lenses out of.

use serde_json::json;

use super::{Composition, State, apply, hold};
use crate::plan::Plan;
use crate::profile::Profile;

fn profiles() -> Vec<Profile> {
    ["rust", "general"]
        .into_iter()
        .map(|p| Profile::load(p).unwrap())
        .collect()
}

fn of(entries: &[(&str, State)]) -> Result<Composition, String> {
    let lenses: Vec<(String, State)> = entries.iter().map(|(l, s)| ((*l).to_owned(), *s)).collect();
    Composition::of(&lenses, &profiles())
}

#[test]
fn a_lens_turned_off_or_held_is_kept_by_its_qualified_name() {
    let c = of(&[
        ("rust:money", State::Off),
        ("rust:maintainability", State::FirstRound),
        ("rust:errors", State::Always),
    ])
    .unwrap();
    assert_eq!(c.off, ["rust:money"]);
    assert_eq!(c.first_round, ["rust:maintainability"]);
    let line = c.line().unwrap();
    assert!(
        line.contains("turned off: rust:money")
            && line.contains("held to the first round: rust:maintainability"),
        "{line}"
    );
    assert_eq!(Composition::default().line(), None);
    assert!(Composition::default().is_empty() && !c.is_empty());
}

#[test]
fn the_security_floor_is_never_touched_and_concurrency_never_off() {
    let rust = Profile::load("rust").unwrap();
    let floor = rust
        .security_floor
        .first()
        .cloned()
        .unwrap_or_else(|| rust.safety_lens.clone());
    for state in [State::Off, State::FirstRound] {
        let e = of(&[(&format!("rust:{floor}"), state)]).unwrap_err();
        assert!(e.contains("security lens"), "{e}");
    }
    assert!(
        of(&[("general:concurrency", State::Off)])
            .unwrap_err()
            .contains("first round at most")
    );
    assert_eq!(
        of(&[("general:concurrency", State::FirstRound)])
            .unwrap()
            .first_round,
        ["general:concurrency"]
    );
}

#[test]
fn a_name_that_is_no_profiles_lens_is_refused() {
    assert!(
        of(&[("rust:no-such-lens", State::Off)])
            .unwrap_err()
            .contains("no such lens")
    );
    for bad in ["money", "rust:", ":money"] {
        let e = of(&[(bad, State::Off)]).unwrap_err();
        assert!(e.contains("profile:lens"), "{bad}: {e}");
    }
    assert!(
        of(&[("nope:money", State::Off)])
            .unwrap_err()
            .contains("no such lens")
    );
}

#[test]
fn a_held_lens_gets_one_round_and_the_others_keep_theirs() {
    let mut ps = profiles();
    let before = ps[0].lens("errors").unwrap().rounds;
    let general = ps[1].lens("maintainability").map(|l| l.rounds);
    apply(
        &mut ps,
        &of(&[("rust:maintainability", State::FirstRound)]).unwrap(),
    );
    assert_eq!(
        ps[0]
            .lens("maintainability")
            .unwrap()
            .rounds
            .map(std::num::NonZeroU32::get),
        Some(1)
    );
    assert_eq!(ps[0].lens("errors").unwrap().rounds, before);
    assert_eq!(
        ps[1].lens("maintainability").map(|l| l.rounds),
        general,
        "only its own profile's lens"
    );
}

#[test]
fn a_lens_turned_off_leaves_its_profiles_plan_and_is_named_there() {
    let mut plan: Plan = serde_json::from_value(json!({
        "sizeBucket": "small", "lenses": ["errors", "money", "tests"], "maxRounds": 1, "verifyVotes": 1,
        "isLibrary": false, "securitySensitive": false, "intent": "", "spec": "", "churn": [],
        "repoRules": [], "surfaceDropped": [], "lightSkipped": []
    }))
    .unwrap();
    let other = of(&[("general:money", State::Off)]).unwrap();
    hold(&mut plan, &other, "rust");
    assert_eq!(
        plan.lenses,
        ["errors", "money", "tests"],
        "general's money is not rust's"
    );
    hold(
        &mut plan,
        &of(&[("rust:money", State::Off)]).unwrap(),
        "rust",
    );
    assert_eq!(plan.lenses, ["errors", "tests"]);
    assert_eq!(plan.profile_off, ["money"]);
}
