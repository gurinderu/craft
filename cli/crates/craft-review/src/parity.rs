//! The verification rules held to `content/parity/verify-cases.json`, a golden file this crate owns
//! ([`crate::golden`]; `lib/verify-parity.test.mjs` holds the engines to it too while they ship).

use serde_json::{Value, json};

use crate::golden::Golden;
use crate::harm::LEVELS;
use crate::settle::{Tier, agree, demote, finalize, tier_from_votes};
use crate::verify::{BATCH_SIZE, CRITICAL_TIER_RULES, route};

const FILE: &str = "verify-cases.json";

#[test]
fn the_constants_are_the_engines() {
    let mut g = Golden::open(FILE);
    let c = g.file();
    g.check("/batchSize", BATCH_SIZE);
    g.check("/criticalTierRules", json!(CRITICAL_TIER_RULES));
    for from in c["demote"].as_object().unwrap().keys() {
        g.check(&format!("/demote/{from}"), json!(demote(from)));
    }
    let ceilings: Vec<[&str; 2]> = LEVELS.iter().map(|(l, c)| [*l, *c]).collect();
    g.check("/harmCeiling", json!(ceilings));
}

/// The votes of a case as they came back: `null` for a voter that returned nothing.
fn votes(raw: &Value) -> Vec<Option<Value>> {
    raw.as_array()
        .unwrap()
        .iter()
        .map(|v| Some(v.clone()).filter(|v| !v.is_null()))
        .collect()
}

/// What `got` settled to at `at`: the tier, the final severity and, where the case names them, the
/// discarded votes, the verified harm and the whole `why`.
fn holds(g: &mut Golden, at: &str, got: &Value, want: &Value) {
    g.check(&format!("{at}/tier"), Tier::of(got).name());
    g.check(&format!("{at}/severity"), got["severity"].clone());
    for k in ["votesDiscarded", "harmVerified", "why"] {
        if want.get(k).is_some() {
            g.check(&format!("{at}/{k}"), got[k].clone());
        }
    }
}

#[test]
fn every_case_settles_as_the_engines_settle_it() {
    let mut g = Golden::open(FILE);
    let c = g.file();
    let all = c["cases"].as_array().unwrap();
    assert!(!all.is_empty());
    for (i, case) in all.iter().enumerate() {
        let vote: Vec<Option<Value>> = Some(case["vote"].clone())
            .filter(|v| !v.is_null())
            .into_iter()
            .map(Some)
            .collect();
        let f = finalize(&tier_from_votes(&case["finding"], &vote));
        let at = format!("/cases/{i}/expected");
        holds(&mut g, &at, &f, &case["expected"]);
        g.check(&format!("{at}/route"), route(&case["finding"]).name());
    }
}

#[test]
fn every_panel_settles_as_the_engines_settle_it() {
    let mut g = Golden::open(FILE);
    let c = g.file();
    let all = c["panelCases"].as_array().unwrap();
    assert!(all.len() >= 3);
    for (i, case) in all.iter().enumerate() {
        let f = finalize(&tier_from_votes(&case["finding"], &votes(&case["votes"])));
        holds(
            &mut g,
            &format!("/panelCases/{i}/expected"),
            &f,
            &case["expected"],
        );
    }
}

#[test]
fn a_deciding_pair_stands_only_when_it_agrees_as_the_engines_read_it() {
    let mut g = Golden::open(FILE);
    let c = g.file();
    for (i, case) in c["agreeCases"].as_array().unwrap().iter().enumerate() {
        let pair = case["pair"].as_array().unwrap();
        g.check(&format!("/agreeCases/{i}/agree"), agree(&pair[0], &pair[1]));
    }
}
