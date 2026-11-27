//! The plan's gate on yield (realm @nick/craft, node #625): a signal-gated lens runs exactly on its
//! signal, whoever picked it, and stays the completeness critic's to name; a general part of only
//! data is read by the whole-diff lenses alone.

use serde_json::json;

use super::{PlanInput, plan};
use crate::profile::Profile;

fn input<'a>(p: &'a Profile, files: &'a [String], signals: Option<&'a [String]>) -> PlanInput<'a> {
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
        embedded_sql: false,
        design: false,
        signals,
        changed_lines: None,
        project: &crate::project::properties::NONE,
    }
}

fn owned(s: &[&str]) -> Vec<String> {
    s.iter().map(|x| (*x).to_owned()).collect()
}

const GATED: [&str; 3] = ["money", "performance", "maintainability"];

#[test]
fn a_gated_lens_runs_on_its_signal_and_on_no_pick_without_it() {
    for (id, file) in [("rust", "src/lib.rs"), ("general", "web/app.ts")] {
        gated_on_its_signal(&Profile::load(id).unwrap(), file);
    }
}

/// Each of `p`'s gated lenses, over a change to `file`, runs on its signal and on nothing else.
fn gated_on_its_signal(p: &Profile, file: &str) {
    let files = owned(&[file]);
    let scout = json!({"sizeBucket": "large", "securitySensitive": true, "lenses": GATED});
    let none = plan(PlanInput {
        scout: Some(&scout),
        ..input(p, &files, Some(&[]))
    });
    for l in GATED {
        assert!(
            !none.lenses.iter().any(|x| x == l),
            "{l}: {:?}",
            none.lenses
        );
    }
    assert_eq!(none.signal_skipped, GATED, "named, in roster order");
    for (signal, lens) in [
        ("money", "money"),
        ("loop-io", "performance"),
        ("new-or-large-file", "maintainability"),
    ] {
        let fired = owned(&[signal]);
        let got = plan(input(p, &files, Some(&fired)));
        assert!(
            got.lenses.iter().any(|x| x == lens),
            "{signal}: {:?}",
            got.lenses
        );
        assert!(!got.signal_skipped.iter().any(|x| x == lens), "{signal}");
        let others: Vec<&str> = GATED.iter().copied().filter(|l| *l != lens).collect();
        assert_eq!(got.signal_skipped, others, "{signal}");
    }
}

#[test]
fn unknown_signals_admit_every_gated_lens() {
    let p = Profile::rust().unwrap();
    let files = owned(&["src/lib.rs"]);
    let got = plan(input(&p, &files, None));
    for l in GATED {
        assert!(got.lenses.iter().any(|x| x == l), "{l}: {:?}", got.lenses);
    }
    assert!(got.signal_skipped.is_empty());
}

#[test]
fn strict_mode_keeps_maintainability_without_its_signal() {
    let p = Profile::load("general").unwrap();
    let files = owned(&["web/app.ts"]);
    let got = plan(PlanInput {
        strict: true,
        ..input(&p, &files, Some(&[]))
    });
    assert!(
        got.lenses.iter().any(|l| l == "maintainability"),
        "{:?}",
        got.lenses
    );
    assert!(!got.signal_skipped.iter().any(|l| l == "maintainability"));
    let plain = plan(input(&p, &files, Some(&[])));
    assert!(!plain.lenses.iter().any(|l| l == "maintainability"));
}

#[test]
fn a_held_lens_stays_a_candidate_the_full_review_critic_may_name() {
    let p = Profile::rust().unwrap();
    let files = owned(&["src/lib.rs"]);
    let scout = json!({"sizeBucket": "large", "securitySensitive": true, "lenses": ["errors"]});
    let got = plan(PlanInput {
        scout: Some(&scout),
        ..input(&p, &files, Some(&[]))
    });
    let open = crate::critic::candidates(&p, &got, false, &files);
    for l in GATED {
        assert!(open.iter().any(|x| x == l), "{l}: {open:?}");
    }
}

#[test]
fn a_general_part_of_only_data_is_read_by_its_whole_diff_lenses_and_security() {
    let p = Profile::load("general").unwrap();
    let files = owned(&["content/parity/a.json", "tests/fixtures/rows.csv"]);
    let scout = json!({"sizeBucket": "large", "securitySensitive": true,
        "lenses": ["correctness", "errors", "compat", "invariants"]});
    let got = plan(PlanInput {
        scout: Some(&scout),
        ..input(&p, &files, Some(&[]))
    });
    for l in &got.lenses {
        assert!(
            p.lens(l).unwrap().whole_diff || l == "security",
            "{l}: {:?}",
            got.lenses
        );
    }
    for l in ["compat", "invariants", "intent", "security"] {
        assert!(got.lenses.iter().any(|x| x == l), "{l}: {:?}", got.lenses);
    }
    assert_eq!(
        got.data_skipped,
        ["correctness", "errors", "concurrency"],
        "named, with their reason"
    );
    assert!(
        got.signal_skipped
            .iter()
            .all(|l| GATED.contains(&l.as_str()))
    );
    assert!(got.data_files.is_empty(), "no source to keep them from");
    let open = crate::critic::candidates(&p, &got, false, &files);
    assert!(
        !open
            .iter()
            .any(|l| l == "correctness" || GATED.contains(&l.as_str())),
        "a per-file lens over nothing but data, signal-gated or not, is no critic candidate: \
         {open:?}"
    );
    let empty = plan(input(&p, &[], Some(&[])));
    assert!(
        empty.data_skipped.is_empty() && empty.data_files.is_empty(),
        "an empty part is no data-only one"
    );
    assert!(
        !got.lenses.iter().any(|l| l == "tests"),
        "data is no production code"
    );
}

#[test]
fn a_light_pass_over_only_data_still_has_a_lens_to_read_it() {
    let p = Profile::load("general").unwrap();
    let files = owned(&["schemas/a.json"]);
    let scout =
        json!({"sizeBucket": "small", "securitySensitive": false, "lenses": ["correctness"]});
    let got = plan(PlanInput {
        scout: Some(&scout),
        light: true,
        ..input(&p, &files, Some(&[]))
    });
    assert_eq!(got.lenses, ["intent"]);
}

#[test]
fn a_part_with_source_beside_its_data_or_another_profile_keeps_its_per_file_lenses() {
    let general = Profile::load("general").unwrap();
    let mixed = owned(&["web/app.ts", "web/app.json"]);
    let got = plan(input(&general, &mixed, Some(&[])));
    assert!(
        got.lenses.iter().any(|l| l == "correctness"),
        "{:?}",
        got.lenses
    );
    assert!(got.lenses.iter().any(|l| l == "tests"), "{:?}", got.lenses);
    assert_eq!(
        got.data_files,
        ["web/app.json"],
        "named as kept from the per-file lenses"
    );
    assert!(got.data_skipped.is_empty());
    let config = owned(&[".github/workflows/ci.yml", "deploy/values.yaml"]);
    let got = plan(input(&general, &config, Some(&[])));
    assert!(
        got.lenses.iter().any(|l| l == "correctness") && got.data_files.is_empty(),
        "configuration is no data: {:?}",
        got.lenses
    );
    let rust = Profile::rust().unwrap();
    let manifest = owned(&["Cargo.toml"]);
    let got = plan(input(&rust, &manifest, Some(&[])));
    assert!(
        got.lenses.iter().any(|l| l == "correctness"),
        "{:?}",
        got.lenses
    );
}

/// Data-only is judged over the paths the lenses read, a renamed file's old path among them; the
/// report names only the current data files (realm @nick/craft, node #625).
#[test]
fn a_part_is_judged_data_only_over_the_paths_its_lenses_read() {
    let p = Profile::load("general").unwrap();
    let renamed = owned(&["web/rows.json"]);
    let read = owned(&["web/rows.json", "web/rows.ts"]);
    let got = plan(PlanInput {
        read_paths: &read,
        ..input(&p, &renamed, Some(&[]))
    });
    assert!(
        got.lenses.iter().any(|l| l == "correctness") && got.data_skipped.is_empty(),
        "a source file renamed to data still has its old path read: {:?}",
        got.lenses
    );
    assert_eq!(got.data_files, ["web/rows.json"]);
    let alone = plan(input(&p, &renamed, Some(&[])));
    assert!(
        !alone.data_skipped.is_empty(),
        "judged over its files alone it would be data only"
    );
    let mixed = owned(&["web/app.ts", "web/new.csv"]);
    let read = owned(&["web/app.ts", "web/new.csv", "web/old.csv"]);
    let got = plan(PlanInput {
        read_paths: &read,
        ..input(&p, &mixed, Some(&[]))
    });
    assert_eq!(got.data_files, ["web/new.csv"], "the current paths only");
}
