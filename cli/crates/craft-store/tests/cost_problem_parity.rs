//! The binary's cost rule held to the cases the JavaScript `costProblem` is held to
//! and a run filed in parts priced as `foldStoppedParts` prices it
//! (`content/parity/cost-problem-cases.json`, edited by hand; realm @nick/craft, node #658).
use std::path::Path;

use craft_store::cost::problem;
use craft_store::js::{Js, Obj, parse};
use craft_store::parts::Parts;

#[test]
fn every_case_gets_the_problem_the_javascript_rule_gives_it() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/parity/cost-problem-cases.json");
    let doc = parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = doc
        .as_obj()
        .unwrap()
        .get("cases")
        .and_then(Js::as_arr)
        .unwrap();
    assert!(cases.len() > 30, "the cases are read");
    for c in cases {
        let c = c.as_obj().unwrap();
        let name = c.get("name").and_then(Js::as_str).unwrap();
        let want = c.get("problem").and_then(Js::as_str);
        let got = problem::problem(c.get("cost")).map(problem::Problem::as_str);
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn a_run_filed_in_parts_is_priced_as_the_javascript_fold_prices_it() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../content/parity/cost-problem-cases.json");
    let doc = parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let folds = doc
        .as_obj()
        .unwrap()
        .get("folds")
        .and_then(Js::as_arr)
        .unwrap();
    assert!(folds.len() > 5, "the folds are read");
    for f in folds {
        let f = f.as_obj().unwrap();
        let name = f.get("name").and_then(Js::as_str).unwrap();
        let records: Vec<Obj> = f
            .get("parts")
            .and_then(Js::as_arr)
            .unwrap()
            .iter()
            .map(|p| {
                let mut r = p.as_obj().unwrap().clone();
                for (k, v) in [("kind", "workflow"), ("name", "review"), ("driver", "cli")] {
                    r.set(k, Js::str(v));
                }
                r.set("project", Js::str("/p"));
                r.set("cliRun", Js::str("/r/1"));
                r
            })
            .collect();
        let mut parts = Parts::default();
        for r in &records {
            parts.note(r);
        }
        let standing = f.get("standing").and_then(Js::as_num).unwrap();
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a part's index"
        )]
        let Some(r) = records.get(standing as usize) else {
            panic!("{name}: no part {standing}");
        };
        let want = f.get("cost").filter(|c| **c != Js::Null).map(Js::compact);
        assert_eq!(parts.cost_of(r).map(|c| c.compact()), want, "{name}");
        assert_eq!(
            parts.cost_of(r).map(|c| c.compact()),
            r.get("cost").map(Js::compact),
            "{name}: a record of the same time and stop priced again is not the standing one"
        );
    }
}
