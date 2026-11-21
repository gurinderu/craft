//! The SQL lenses in a plan: the SQL profile's two always, and the queries lens added to another
//! profile only by the embedded-SQL signal (realm @nick/craft, node #536).

use serde_json::json;

use super::{PlanInput, plan};
use crate::profile::Profile;

fn input<'a>(p: &'a Profile, files: &'a [String], embedded_sql: bool) -> PlanInput<'a> {
    PlanInput {
        profile: p,
        scout: None,
        changed_files: files,
        spec: "feat: x",
        light: false,
        strict: false,
        metrics: false,
        optional: &[],
        embedded_sql,
    }
}

#[test]
fn a_sql_diff_plans_both_sql_lenses_whatever_the_scout_picked() {
    let p = Profile::load("sql").unwrap();
    let files = ["db/migrations/0002_add.sql".to_owned()];
    let scout =
        json!({"sizeBucket": "small", "lenses": ["sql-queries"], "securitySensitive": false});
    let got = plan(PlanInput {
        scout: Some(&scout),
        light: true,
        ..input(&p, &files, false)
    });
    assert_eq!(got.lenses, ["sql-queries", "sql-migrations"]);
    assert_eq!(got.max_rounds, 1);
}

#[test]
fn the_queries_lens_joins_a_rust_or_general_plan_only_on_the_embedded_signal() {
    for (id, file) in [("rust", "src/db.rs"), ("general", "app/db.py")] {
        let p = Profile::load(id).unwrap();
        let files = [file.to_owned()];
        let with = plan(input(&p, &files, true));
        assert!(
            with.lenses.iter().any(|l| l == "sql-queries"),
            "{id}: {:?}",
            with.lenses
        );
        let without = plan(input(&p, &files, false));
        assert!(
            !without.lenses.iter().any(|l| l == "sql-queries"),
            "{id}: no blanket fill or security floor buys it: {:?}",
            without.lenses
        );
    }
    let nix = Profile::load("nix").unwrap();
    let files = ["flake.nix".to_owned()];
    assert!(
        !plan(input(&nix, &files, true))
            .lenses
            .iter()
            .any(|l| l == "sql-queries")
    );
}

#[test]
fn a_light_pass_keeps_the_embedded_queries_lens() {
    let p = Profile::rust().unwrap();
    let files = ["src/db.rs".to_owned()];
    let scout = json!({"sizeBucket": "small", "lenses": ["errors"], "securitySensitive": false});
    let got = plan(PlanInput {
        scout: Some(&scout),
        light: true,
        ..input(&p, &files, true)
    });
    assert!(
        got.lenses.iter().any(|l| l == "sql-queries"),
        "{:?}",
        got.lenses
    );
}

#[test]
fn a_rust_diff_can_plan_the_general_lenses_complexity_behind_its_index() {
    let p = Profile::rust().unwrap();
    let files = ["src/billing.rs".to_owned()];
    let scout = json!({"sizeBucket": "medium", "securitySensitive": false,
        "lenses": ["correctness", "security", "money", "complexity"]});
    let with = plan(PlanInput {
        scout: Some(&scout),
        metrics: true,
        ..input(&p, &files, false)
    });
    for l in ["correctness", "security", "money", "complexity"] {
        assert!(with.lenses.iter().any(|x| x == l), "{l}: {:?}", with.lenses);
    }
    let without = plan(PlanInput {
        scout: Some(&scout),
        ..input(&p, &files, false)
    });
    assert!(!without.lenses.iter().any(|l| l == "complexity"));
    assert_eq!(without.metrics_dropped, ["complexity"]);
}

#[test]
fn a_general_diff_can_plan_the_lenses_it_gained() {
    let p = Profile::load("general").unwrap();
    let files = ["web/app.ts".to_owned()];
    let gained = ["tests", "maintainability", "compat", "invariants"];
    let scout = json!({"sizeBucket": "large", "securitySensitive": false, "lenses": gained});
    let got = plan(PlanInput {
        scout: Some(&scout),
        ..input(&p, &files, false)
    });
    for l in gained
        .iter()
        .chain(&["intent", "correctness", "negative-space"])
    {
        assert!(got.lenses.iter().any(|x| x == l), "{l}: {:?}", got.lenses);
    }
}
