use craft_store::retro::{Apart, Retro, Round};

use super::{json, text};

fn printed(r: &Retro, f: fn(&mut dyn std::io::Write, &Retro) -> std::io::Result<()>) -> String {
    let mut out = Vec::new();
    f(&mut out, r).unwrap();
    String::from_utf8(out).unwrap()
}

fn round(raw: f64, new_unique: f64, confirmed: f64, plus: f64) -> Round {
    Round {
        runs: 2,
        raw,
        new_unique,
        confirmed,
        confirmed_medium_plus: plus,
    }
}

#[test]
fn each_round_prints_raw_new_unique_confirmed_and_medium_plus_then_the_rest() {
    let mut r = Retro::default();
    r.rounds.insert(1, round(16.0, 6.0, 3.0, 2.0));
    r.rounds.insert(2, round(14.0, 1.0, 0.0, 0.0));
    r.apart = Apart {
        seed_runs: 2,
        seed_confirmed: 4.0,
        seed_medium_plus: 1.0,
        unattributed_runs: 2,
        unattributed_confirmed: 3.0,
    };
    assert_eq!(
        printed(&r, text),
        "\nLens rounds (raw → new unique → confirmed, Medium+)\nround 1: 16 → 6 → 3, Medium+ 2 over 2 run(s)\nround 2: 14 → 1 → 0, Medium+ 0 over 2 run(s)\nseeds: 4 confirmed, Medium+ 1 over 2 run(s) · no lens round: 3 confirmed over 2 run(s)\n"
    );
    let lines: Vec<serde_json::Value> = printed(&r, json)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(
        lines[0],
        serde_json::json!({"section": "lensRound", "round": 1, "runs": 2, "raw": 16, "newUnique": 6, "confirmed": 3, "confirmedMediumPlus": 2})
    );
    assert_eq!(
        lines[2],
        serde_json::json!({"section": "roundYieldApart", "seedRuns": 2, "seedConfirmed": 4, "seedConfirmedMediumPlus": 1,
                           "unattributedRuns": 2, "unattributedConfirmed": 3})
    );
}

#[test]
fn a_retro_with_no_round_yield_prints_nothing_for_it() {
    let r = Retro::default();
    assert_eq!(
        (printed(&r, text), printed(&r, json)),
        (String::new(), String::new())
    );
}
