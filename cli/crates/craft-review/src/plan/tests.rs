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
        profile_files: files,
        read_paths: files,
        spec: "feat: x",
        light: false,
        strict: false,
        metrics: false,
        optional: &[],
        embedded_sql,
        design: false,
        signals: Some(&[]),
        changed_lines: None,
        project: &crate::project::properties::NONE,
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
    let money = ["money".to_owned()];
    let with = plan(PlanInput {
        scout: Some(&scout),
        metrics: true,
        signals: Some(&money),
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
    let fired = ["new-or-large-file".to_owned()];
    let got = plan(PlanInput {
        scout: Some(&scout),
        signals: Some(&fired),
        ..input(&p, &files, false)
    });
    for l in gained
        .iter()
        .chain(&["intent", "correctness", "negative-space"])
    {
        assert!(got.lenses.iter().any(|x| x == l), "{l}: {:?}", got.lenses);
    }
}

/// The lenses `l` holds of `ids`.
fn holds(l: &[String], ids: &[&str]) -> Vec<String> {
    ids.iter()
        .filter(|i| l.iter().any(|x| x == *i))
        .map(|i| (*i).to_owned())
        .collect()
}

#[test]
fn the_security_floor_adds_only_the_profiles_security_lenses() {
    let rust_floor = [
        "security",
        "safety",
        "correctness",
        "errors",
        "concurrency",
        "compat",
        "invariants",
    ];
    let general_floor = [
        "security",
        "correctness",
        "errors",
        "concurrency",
        "compat",
        "invariants",
    ];
    let scout_picked = ["money", "maintainability", "complexity", "performance"];
    for (id, file, floor) in [
        ("rust", "src/lib.rs", rust_floor.as_slice()),
        ("general", "web/app.ts", general_floor.as_slice()),
    ] {
        let p = Profile::load(id).unwrap();
        let files = [file.to_owned()];
        let sensitive =
            json!({"sizeBucket": "small", "lenses": ["errors"], "securitySensitive": true});
        let large =
            json!({"sizeBucket": "large", "lenses": ["errors"], "securitySensitive": false});
        for scout in [Some(&sensitive), Some(&large), None] {
            let got = plan(PlanInput {
                scout,
                metrics: true,
                ..input(&p, &files, false)
            });
            assert_eq!(
                holds(&got.lenses, floor),
                floor,
                "{id} {scout:?}: {:?}",
                got.lenses
            );
            let always: Vec<&str> = p.always_lenses.iter().map(String::as_str).collect();
            let extra: Vec<&str> = scout_picked
                .iter()
                .copied()
                .filter(|l| !always.contains(l))
                .collect();
            assert!(
                holds(&got.lenses, &extra).is_empty(),
                "{id} {scout:?}: left to the scout: {:?}",
                got.lenses
            );
        }
    }
}

#[test]
fn a_documented_invariant_has_an_owner_in_a_small_nix_or_general_plan() {
    for (id, file, pick, owner) in [
        ("general", "web/app.ts", "errors", "correctness"),
        ("nix", "flake.nix", "purity", "intent"),
    ] {
        let p = Profile::load(id).unwrap();
        let files = [file.to_owned()];
        let scout = json!({"sizeBucket": "small", "lenses": [pick], "securitySensitive": false});
        let got = plan(PlanInput {
            scout: Some(&scout),
            ..input(&p, &files, false)
        });
        assert!(!got.lenses.iter().any(|l| l == "invariants"), "{id}");
        assert!(
            got.lenses.iter().any(|l| l == owner),
            "{id}: {:?}",
            got.lenses
        );
        let brief = crate::content::text(&p.lens(owner).unwrap().brief).unwrap();
        assert!(brief.contains("documented invariant"), "{id}: {brief}");
    }
}

#[test]
fn a_general_change_to_production_source_forces_tests_and_a_light_pass_intent() {
    let p = Profile::load("general").unwrap();
    let scout = json!({"sizeBucket": "small", "lenses": ["errors"], "securitySensitive": false});
    let source = ["web/app.ts".to_owned()];
    let got = plan(PlanInput {
        scout: Some(&scout),
        ..input(&p, &source, false)
    });
    assert!(got.lenses.iter().any(|l| l == "tests"), "{:?}", got.lenses);
    let light = plan(PlanInput {
        scout: Some(&scout),
        light: true,
        ..input(&p, &source, false)
    });
    assert!(
        light.lenses.iter().any(|l| l == "intent") && light.lenses.iter().any(|l| l == "tests"),
        "{:?}",
        light.lenses
    );
    for test in ["web/app.test.ts", "web/app.spec.ts", "tests/test_app.py"] {
        let files = [test.to_owned()];
        let got = plan(PlanInput {
            scout: Some(&scout),
            ..input(&p, &files, false)
        });
        assert!(
            !got.lenses.iter().any(|l| l == "tests"),
            "{test}: {:?}",
            got.lenses
        );
    }
}

#[test]
fn a_general_plan_counts_only_its_own_files_as_production() {
    let p = Profile::load("general").unwrap();
    let scout = json!({"sizeBucket": "small", "lenses": ["errors"], "securitySensitive": false});
    let change = ["src/lib.rs".to_owned(), "web/app.test.ts".to_owned()];
    let own = ["web/app.test.ts".to_owned()];
    let got = plan(PlanInput {
        scout: Some(&scout),
        profile_files: &own,
        read_paths: &own,
        ..input(&p, &change, false)
    });
    assert!(
        !got.lenses.iter().any(|l| l == "tests"),
        "the Rust file is Rust's: {:?}",
        got.lenses
    );
}

#[test]
fn the_design_lens_joins_a_plan_on_its_signal_or_its_request_only() {
    for id in ["rust", "nix", "general"] {
        let p = Profile::load(id).unwrap();
        let files = ["src/x".to_owned()];
        let has = |got: &super::Plan| got.lenses.iter().any(|l| l == "design");
        // A large, security-sensitive plan with a scout that picked it: still no signal, no request.
        let scout = json!({"sizeBucket": "large", "lenses": ["design", "correctness"], "securitySensitive": true});
        let without = plan(PlanInput {
            scout: Some(&scout),
            ..input(&p, &files, false)
        });
        assert!(!has(&without), "{id}: {:?}", without.lenses);
        let signalled = plan(PlanInput {
            design: true,
            ..input(&p, &files, false)
        });
        assert!(has(&signalled), "{id}: {:?}", signalled.lenses);
        let asked = [format!("{id}-design")];
        let bought = plan(PlanInput {
            optional: &asked,
            ..input(&p, &files, false)
        });
        assert!(has(&bought), "{id}: {:?}", bought.lenses);
    }
    let sql = Profile::load("sql").unwrap();
    let files = ["db/q.sql".to_owned()];
    assert!(
        !plan(PlanInput {
            design: true,
            ..input(&sql, &files, false)
        })
        .lenses
        .iter()
        .any(|l| l == "design"),
        "the SQL profile does not extend the general lenses"
    );
}

#[test]
fn the_counted_lines_size_the_plan_whatever_the_scout_said_but_a_runbook_keeps_its_scouts() {
    let rust = Profile::load("rust").unwrap();
    let files = ["src/lib.rs".to_owned()];
    let scout = serde_json::json!({"sizeBucket": "small", "lenses": ["errors"]});
    let sized = |p: &Profile, lines: Option<u64>| {
        plan(PlanInput {
            scout: Some(&scout),
            changed_lines: lines,
            ..input(p, &files, false)
        })
    };
    let large = sized(&rust, Some(crate::size::LARGE_ABOVE + 1));
    assert_eq!(
        (
            large.size_bucket.as_str(),
            large.max_rounds,
            large.verify_votes
        ),
        ("large", 3, 3)
    );
    assert_eq!(sized(&rust, Some(100)).size_bucket, "medium");
    assert_eq!(
        sized(&rust, None).size_bucket,
        "small",
        "uncounted: the scout's"
    );
    let runbook = Profile::load("runbook").unwrap();
    assert_eq!(
        sized(&runbook, Some(1000)).size_bucket,
        "small",
        "its steps, not its lines"
    );
}

#[test]
fn the_profiles_facts_beat_the_scout_either_way_and_its_risks_only_add() {
    use crate::project::properties::Properties;
    let rust = Profile::load("rust").unwrap();
    let files = ["src/auth/token.rs".to_owned(), "spec/wire.cddl".to_owned()];
    let scout = serde_json::json!({"lenses": ["errors"], "isLibrary": true, "securitySensitive": false,
                                   "repoRules": ["AGENTS.md"]});
    let planned = |project: &Properties| {
        plan(PlanInput {
            scout: Some(&scout),
            project,
            changed_lines: Some(10),
            ..input(&rust, &files, false)
        })
    };
    let bare = planned(&Properties::new());
    assert!(
        bare.is_library && !bare.security_sensitive,
        "the scout's answer alone"
    );
    assert_eq!(bare.repo_rules, ["AGENTS.md"]);
    assert!(!bare.lenses.contains(&"reconciler".to_owned()));
    assert!(!bare.lenses.contains(&"compat".to_owned()));

    let set = Properties {
        library: Some(false),
        rules: Some(vec!["CONTRIBUTING.md".into()]),
        controllers: true,
        security_paths: vec!["src/auth".into()],
        contracts: vec!["spec/*.cddl".into()],
    };
    let got = planned(&set);
    assert!(
        !got.is_library,
        "a fact the reviewer confirmed beats the scout's guess"
    );
    assert_eq!(got.repo_rules, ["CONTRIBUTING.md"]);
    assert!(
        got.security_sensitive,
        "a change under a security path is sensitive"
    );
    assert_eq!((got.verify_votes, got.max_rounds), (3, 2));
    for l in ["reconciler", "failure-windows", "compat", "security"] {
        assert!(got.lenses.contains(&l.to_owned()), "{l}: {:?}", got.lenses);
    }

    let elsewhere = Properties {
        security_paths: vec!["src/other".into()],
        ..Properties::new()
    };
    let sensitive = serde_json::json!({"lenses": ["errors"], "securitySensitive": true});
    let kept = plan(PlanInput {
        scout: Some(&sensitive),
        project: &elsewhere,
        changed_lines: Some(10),
        ..input(&rust, &files, false)
    });
    assert!(
        kept.security_sensitive,
        "a risk the scout saw is never taken back"
    );
}

#[test]
fn a_contract_the_profile_names_adds_compat_over_the_scouts_surfaces_and_a_light_pass_keeps_its_risks()
 {
    use crate::project::properties::Properties;
    let rust = Profile::load("rust").unwrap();
    let files = ["spec/wire.cddl".to_owned()];
    let scout = serde_json::json!({"lenses": ["errors"], "securitySensitive": false,
                                   "surfaces": {"wireForm": false, "crossBoundarySymbol": false}});
    let planned = |project: &Properties, light: bool| {
        plan(PlanInput {
            scout: Some(&scout),
            project,
            light,
            changed_lines: Some(10),
            ..input(&rust, &files, false)
        })
    };
    let contract = Properties {
        contracts: vec!["spec".into()],
        ..Properties::new()
    };
    assert!(
        !planned(&Properties::new(), false)
            .lenses
            .contains(&"compat".to_owned())
    );
    let got = planned(&contract, false);
    assert!(!got.security_sensitive, "a contract is no security risk");
    assert!(
        got.lenses.contains(&"compat".to_owned()),
        "{:?}",
        got.lenses
    );
    assert!(
        planned(&contract, true)
            .lenses
            .contains(&"compat".to_owned()),
        "a light pass too"
    );
    let controllers = Properties {
        controllers: true,
        ..Properties::new()
    };
    let light = planned(&controllers, true);
    for l in ["reconciler", "failure-windows"] {
        assert!(
            light.lenses.contains(&l.to_owned()),
            "{l}: {:?}",
            light.lenses
        );
    }
}

#[test]
fn a_library_the_profile_confirms_beats_the_scouts_no_on_a_profile_that_has_libraries() {
    use crate::project::properties::Properties;
    let files = ["src/lib.rs".to_owned()];
    let scout = serde_json::json!({"lenses": ["errors"], "isLibrary": false});
    let library = Properties {
        library: Some(true),
        ..Properties::new()
    };
    let rust = Profile::load("rust").unwrap();
    let general = Profile::load("general").unwrap();
    let of = |p: &Profile| {
        plan(PlanInput {
            scout: Some(&scout),
            project: &library,
            ..input(p, &files, false)
        })
        .is_library
    };
    assert!(of(&rust));
    assert!(!of(&general), "a profile with no libraries takes none");
}

#[test]
fn a_file_renamed_out_of_a_security_path_still_makes_its_part_sensitive() {
    use crate::project::properties::Properties;
    let rust = Profile::load("rust").unwrap();
    let files = ["src/moved.rs".to_owned()];
    let read = ["src/moved.rs".to_owned(), "src/auth/old.rs".to_owned()];
    let scout = serde_json::json!({"lenses": ["errors"], "securitySensitive": false});
    let project = Properties {
        security_paths: vec!["src/auth".into()],
        ..Properties::new()
    };
    let got = plan(PlanInput {
        scout: Some(&scout),
        project: &project,
        read_paths: &read,
        ..input(&rust, &files, false)
    });
    assert!(got.security_sensitive);
}
