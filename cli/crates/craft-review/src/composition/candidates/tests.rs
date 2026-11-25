//! The yield summed per lens and the lenses it offers, by its numbers and the composition's rules.

use std::collections::BTreeMap;

use craft_store::retro::Lens;

use super::{PASSES, State, candidates, yields};
use crate::profile::Profile;

/// A lens of `runs` passes whose confirmed findings are `by` (Critical … Info).
fn lens(runs: u64, by: [f64; 5]) -> Lens {
    Lens {
        runs,
        by_severity: by,
        ..Lens::default()
    }
}

fn offered(rows: &[(&str, Lens)]) -> Vec<(String, Vec<State>)> {
    let rows: BTreeMap<String, Lens> = rows
        .iter()
        .map(|(n, l)| ((*n).to_owned(), l.clone()))
        .collect();
    let profiles = Profile::all().unwrap();
    candidates(&yields(&rows), &profiles)
        .into_iter()
        .map(|c| (c.lens, c.states))
        .collect()
}

#[test]
fn a_lens_with_enough_passes_and_no_confirmed_medium_is_offered_both_states() {
    let quiet = lens(PASSES, [0.0, 0.0, 0.0, 4.0, 2.0]);
    assert_eq!(
        offered(&[("rust:money", quiet)]),
        [("rust:money".to_owned(), vec![State::FirstRound, State::Off])]
    );
}

#[test]
fn a_lens_short_of_its_passes_or_with_a_confirmed_medium_is_not() {
    assert!(offered(&[("rust:money", lens(PASSES - 1, [0.0; 5]))]).is_empty());
    for i in 0..3 {
        let mut by = [0.0; 5];
        by[i] = 1.0;
        assert!(
            offered(&[("rust:money", lens(PASSES, by))]).is_empty(),
            "{i}"
        );
    }
}

#[test]
fn the_security_and_safety_lenses_are_never_offered_and_concurrency_only_held() {
    let quiet = || lens(PASSES * 3, [0.0; 5]);
    assert!(
        offered(&[
            ("rust:safety", quiet()),
            ("general:security", quiet()),
            ("rust:security", quiet())
        ])
        .is_empty()
    );
    assert_eq!(
        offered(&[("general:concurrency", quiet())]),
        [("general:concurrency".to_owned(), vec![State::FirstRound])]
    );
    assert!(offered(&[("rust:no-such-lens", quiet())]).is_empty());
}

#[test]
fn a_cli_row_is_summed_under_its_own_name_and_a_row_naming_no_profile_passed_over() {
    let rows: BTreeMap<String, Lens> = [
        ("rust:money (cli)", lens(12, [0.0, 0.0, 0.0, 1.0, 0.0])),
        ("rust:money", lens(8, [0.0; 5])),
        ("money", lens(50, [0.0; 5])),
    ]
    .into_iter()
    .map(|(n, l)| (n.to_owned(), l))
    .collect();
    let y = yields(&rows);
    assert_eq!(y.len(), 1, "{y:?}");
    assert_eq!((y[0].lens.as_str(), y[0].runs), ("rust:money", 20));
    assert_eq!(y[0].confirmed["Low"], 1.0);
}
