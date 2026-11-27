//! The composition as the profiles check it, its round ceiling as the rounds read it, and the plan
//! it holds lenses out of.

use serde_json::json;

use super::{Composition, Refused, State, apply, hold};
use crate::plan::Plan;
use crate::profile::Profile;

fn profiles() -> Vec<Profile> {
    ["rust", "general"]
        .into_iter()
        .map(|p| Profile::load(p).unwrap())
        .collect()
}

fn of(entries: &[(&str, State)]) -> Result<Composition, Refused> {
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
    assert_eq!(rust.safety_lens, "safety");
    for lens in ["rust:security", "rust:safety", "general:security"] {
        for state in [State::Off, State::FirstRound] {
            let e = of(&[(lens, state)]).unwrap_err().to_string();
            assert!(e.contains("security lens"), "{lens}: {e}");
        }
    }
    assert!(
        of(&[("general:concurrency", State::Off)])
            .unwrap_err()
            .to_string()
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
            .to_string()
            .contains("no such lens")
    );
    for bad in ["money", "rust:", ":money"] {
        let e = of(&[(bad, State::Off)]).unwrap_err().to_string();
        assert!(e.contains("profile:lens"), "{bad}: {e}");
    }
    assert!(
        of(&[("nope:money", State::Off)])
            .unwrap_err()
            .to_string()
            .contains("no such lens")
    );
}

#[test]
fn each_refusal_is_its_own_kind_naming_the_entry() {
    let cases = [
        (
            "money",
            State::Off,
            Refused::NotQualified("money".to_owned()),
        ),
        (
            "rust:no-such-lens",
            State::Off,
            Refused::NoSuchLens("rust:no-such-lens".to_owned()),
        ),
        (
            "rust:safety",
            State::FirstRound,
            Refused::Floor("rust:safety".to_owned()),
        ),
        (
            "general:concurrency",
            State::Off,
            Refused::ConcurrencyOff("general:concurrency".to_owned()),
        ),
    ];
    for (lens, state, want) in cases {
        assert_eq!(of(&[(lens, state)]).unwrap_err(), want, "{lens}");
    }
    assert_eq!(
        Refused::Floor("rust:safety".to_owned()).to_string(),
        "rust:safety: a security lens is never held or turned off"
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

fn small_plan(extra: &serde_json::Value) -> Plan {
    let mut v = json!({
        "sizeBucket": "small", "lenses": ["errors", "money", "tests"], "maxRounds": 1, "verifyVotes": 1,
        "isLibrary": false, "securitySensitive": false, "intent": "", "spec": "", "churn": [],
        "repoRules": [], "surfaceDropped": [], "lightSkipped": []
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

#[test]
fn a_lens_turned_off_leaves_its_profiles_plan_and_is_named_there() {
    let mut plan = small_plan(&json!({}));
    let other = of(&[("general:money", State::Off)]).unwrap();
    assert!(hold(&mut plan, &other, "rust", &[]).is_empty());
    assert_eq!(
        plan.lenses,
        ["errors", "money", "tests"],
        "general's money is not rust's"
    );
    assert!(plan.profile_off.is_empty());
    let money = of(&[("rust:money", State::Off)]).unwrap();
    assert!(hold(&mut plan, &money, "rust", &[]).is_empty());
    assert_eq!(plan.lenses, ["errors", "tests"]);
    assert_eq!(plan.profile_off, ["money"]);
}

#[test]
fn a_lens_turned_off_but_never_planned_is_named_and_left_out_of_every_held_back_list() {
    let mut plan = small_plan(&json!({
        "lenses": ["errors"], "signalSkipped": ["performance"], "metricsDropped": ["complexity"],
        "lightSkipped": ["compat"], "surfaceDropped": ["design"],
        "dataSkipped": ["sql-queries"]
    }));
    let c = of(&[
        ("rust:performance", State::Off),
        ("rust:complexity", State::Off),
        ("rust:compat", State::Off),
        ("rust:design", State::Off),
        ("rust:money", State::Off),
        ("rust:sql-queries", State::Off),
    ])
    .unwrap();
    assert!(hold(&mut plan, &c, "rust", &[]).is_empty());
    assert_eq!(plan.lenses, ["errors"]);
    assert!(plan.signal_skipped.is_empty(), "{:?}", plan.signal_skipped);
    assert!(
        plan.metrics_dropped.is_empty(),
        "{:?}",
        plan.metrics_dropped
    );
    assert!(plan.light_skipped.is_empty(), "{:?}", plan.light_skipped);
    assert!(
        plan.surface_dropped.is_empty(),
        "{:?}",
        plan.surface_dropped
    );
    assert!(plan.data_skipped.is_empty(), "{:?}", plan.data_skipped);
    assert_eq!(
        plan.profile_off,
        [
            "performance",
            "complexity",
            "compat",
            "design",
            "money",
            "sql-queries"
        ]
    );
}

#[test]
fn what_the_run_asked_for_itself_stays_and_says_the_profile_gave_way() {
    let c = of(&[("rust:money", State::Off), ("rust:errors", State::Off)]).unwrap();
    let mut plan = small_plan(&json!({}));
    let notes = hold(&mut plan, &c, "rust", &["money".to_owned()]);
    assert_eq!(plan.lenses, ["money", "tests"]);
    assert_eq!(plan.profile_off, ["errors"]);
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(
        notes[0].contains("the run asks for rust's money itself"),
        "{notes:?}"
    );
}

#[test]
fn a_part_left_with_no_lens_keeps_its_planned_ones_yet_holds_back_the_rest() {
    let c = of(&[
        ("rust:money", State::Off),
        ("rust:errors", State::Off),
        ("rust:tests", State::Off),
        ("rust:performance", State::Off),
        ("rust:complexity", State::Off),
    ])
    .unwrap();
    let mut plan = small_plan(&json!({
        "signalSkipped": ["performance"], "metricsDropped": ["complexity"]
    }));
    let notes = hold(&mut plan, &c, "rust", &[]);
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(
        notes[0].contains("every lens planned for rust")
            && notes[0].contains("errors, money, tests"),
        "{notes:?}"
    );
    assert_eq!(plan.lenses, ["errors", "money", "tests"]);
    assert!(plan.signal_skipped.is_empty() && plan.metrics_dropped.is_empty());
    assert_eq!(plan.profile_off, ["performance", "complexity"]);

    let mut empty = small_plan(&json!({"lenses": [], "signalSkipped": ["performance"]}));
    assert!(
        hold(&mut empty, &c, "rust", &[]).is_empty(),
        "an empty plan is not one left empty"
    );
    assert!(empty.signal_skipped.is_empty());
}
