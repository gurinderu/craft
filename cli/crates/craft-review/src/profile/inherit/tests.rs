use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::content::ContentError;
use crate::profile::Profile;

fn lens(id: &str, brief: &str) -> Value {
    json!({"id": id, "brief": brief, "model": "opus"})
}

/// A whole profile `id`, every field its own, extending nothing.
fn base(id: &str) -> Value {
    json!({
        "id": id, "lang": "source", "detect": {"suffixes": [], "names": [], "rest": true},
        "diffGlobs": [], "rubricSkill": "review-rules", "fpRules": "", "ruleCatalog": false,
        "navSkill": "", "securityHints": "input", "usesLibrary": false,
        "alwaysLenses": ["a"], "safetyLens": "b", "scoutRules": "scout-rules-general",
        "scoutModel": "haiku", "dedupModel": "haiku", "rollupRuleIds": [],
        "negativeSpace": {"newSurface": "fn", "shapeUses": "calls"},
        "lenses": [lens("a", "base-a"), lens("b", "base-b"), lens("c", "base-c")],
        "floorLenses": [lens("negative-space", "base-ns")]
    })
}

/// A profile `id` extending `general`, with only what a child must say of itself plus `extra`.
fn child(id: &str, extra: &Value) -> Value {
    let mut v = json!({
        "id": id, "lang": "Lang", "extends": "general",
        "detect": {"suffixes": [".x"], "names": []}
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

fn load(id: &str, files: &[&Value]) -> Result<Profile, ContentError> {
    let by_id: BTreeMap<String, String> = files
        .iter()
        .map(|v| (v["id"].as_str().unwrap().to_owned(), v.to_string()))
        .collect();
    Profile::load_with(id, &|id: &str| {
        by_id
            .get(id)
            .cloned()
            .ok_or_else(|| ContentError::UnknownFile(format!("profiles/{id}.json")))
    })
}

fn briefs(lenses: &[crate::profile::Lens]) -> Vec<(String, String)> {
    lenses
        .iter()
        .map(|l| (l.id.clone(), l.brief.clone()))
        .collect()
}

fn refused(id: &str, files: &[&Value]) -> String {
    let err = load(id, files).unwrap_err();
    assert!(matches!(err, ContentError::BadProfile(..)), "{err:?}");
    err.to_string()
}

#[test]
fn the_lenses_are_the_bases_minus_excluded_each_own_replacing_in_place_or_appended() {
    let general = base("general");
    let x = child(
        "x",
        &json!({
            "exclude": ["b"], "safetyLens": "c",
            "lenses": [lens("d", "x-d"), lens("a", "x-a")]
        }),
    );
    let p = load("x", &[&general, &x]).unwrap();
    assert_eq!(
        briefs(&p.lenses),
        [("a", "x-a"), ("c", "base-c"), ("d", "x-d")].map(|(i, b)| (i.to_owned(), b.to_owned())),
        "a replaced at its place, b excluded, d appended"
    );
    assert_eq!(
        briefs(&p.floor_lenses),
        [("negative-space".to_owned(), "base-ns".to_owned())],
        "the floor inherited"
    );
}

#[test]
fn a_floor_lens_replaces_the_bases_floor_lens_of_its_id() {
    let general = base("general");
    let x = child(
        "x",
        &json!({"floorLenses": [lens("negative-space", "x-ns")]}),
    );
    let p = load("x", &[&general, &x]).unwrap();
    assert_eq!(p.lens("negative-space").unwrap().brief, "x-ns");
    assert_eq!(p.floor_lenses.len(), 1);
}

#[test]
fn the_rest_is_inherited_unless_said_and_the_identity_never() {
    let general = base("general");
    let x = child("x", &json!({"alwaysLenses": ["c"]}));
    let p = load("x", &[&general, &x]).unwrap();
    assert_eq!(
        (p.id.as_str(), p.lang.as_str(), p.detect.rest),
        ("x", "Lang", false)
    );
    assert_eq!(p.always_lenses, ["c"], "its own");
    assert_eq!(p.safety_lens, "b", "the base's");
    assert_eq!(
        p.negative_space.as_ref().unwrap().new_surface,
        "fn",
        "the base's"
    );
    assert_eq!(
        (p.rubric_skill.as_str(), p.rule_catalog),
        ("review-rules", false),
        "the base's rubric, whole"
    );
    let own = child("y", &json!({"rubricSkill": "y-review"}));
    let p = load("y", &[&general, &own]).unwrap();
    assert_eq!(
        (p.rubric_skill.as_str(), p.fp_rules.as_str(), p.rule_catalog),
        ("y-review", "", true),
        "a rubric of its own takes none of the base's exclusions or catalog flag"
    );
    let mut bare = child("z", &json!({}));
    bare.as_object_mut().unwrap().remove("detect");
    assert!(
        load("z", &[&general, &bare])
            .unwrap_err()
            .to_string()
            .contains("detect"),
        "what files it takes is never inherited"
    );
}

#[test]
fn a_chain_resolves_root_first() {
    let general = base("general");
    let mid = child(
        "mid",
        &json!({"lenses": [lens("b", "mid-b"), lens("m", "mid-m")]}),
    );
    let leaf = json!({
        "id": "leaf", "lang": "Leaf", "extends": "mid", "detect": {"suffixes": [], "names": []},
        "exclude": ["c"], "lenses": [lens("m", "leaf-m")]
    });
    let p = load("leaf", &[&general, &mid, &leaf]).unwrap();
    assert_eq!(p.roster(), ["a", "b", "m"]);
    assert_eq!(p.lens("b").unwrap().brief, "mid-b");
    assert_eq!(p.lens("m").unwrap().brief, "leaf-m");
}

#[test]
fn a_cycle_is_refused_naming_it() {
    let mut a = child("a", &json!({}));
    a["extends"] = json!("b");
    let mut b = child("b", &json!({}));
    b["extends"] = json!("a");
    let why = refused("a", &[&a, &b]);
    assert!(
        why.contains("cycle") && why.contains("a -> b -> a"),
        "{why}"
    );
}

#[test]
fn an_unknown_base_is_refused() {
    let mut x = child("x", &json!({}));
    x["extends"] = json!("go");
    let why = refused("x", &[&x]);
    assert!(why.contains("extends") && why.contains("go"), "{why}");
}

#[test]
fn an_exclude_naming_no_lens_of_the_base_is_refused() {
    let general = base("general");
    let x = child("x", &json!({"exclude": ["money"]}));
    let why = refused("x", &[&general, &x]);
    assert!(why.contains("exclude") && why.contains("money"), "{why}");
}

#[test]
fn an_exclude_without_a_base_is_refused() {
    let mut x = base("x");
    x["exclude"] = json!(["a"]);
    let why = refused("x", &[&x]);
    assert!(why.contains("exclude") && why.contains("extends"), "{why}");
}

#[test]
fn excluding_a_lens_and_declaring_it_is_refused() {
    let general = base("general");
    let x = child(
        "x",
        &json!({"exclude": ["c"], "lenses": [lens("c", "x-c")]}),
    );
    let why = refused("x", &[&general, &x]);
    assert!(why.contains("excludes") && why.contains("\"c\""), "{why}");
}

#[test]
fn a_replacement_flipping_metrics_is_refused() {
    let mut general = base("general");
    general["lenses"][2]["metrics"] = json!(true);
    let x = child("x", &json!({"lenses": [lens("c", "x-c")]}));
    let why = refused("x", &[&general, &x]);
    assert!(why.contains("\"c\"") && why.contains("metrics"), "{why}");
}

#[test]
fn a_replacement_dropping_the_bases_own_rubric_is_refused() {
    let mut general = base("general");
    general["lenses"][2]["rubric"] = json!("sql-review");
    let x = child("x", &json!({"lenses": [lens("c", "x-c")]}));
    let why = refused("x", &[&general, &x]);
    assert!(why.contains("\"c\"") && why.contains("rubric"), "{why}");
}

#[test]
fn a_replacement_moving_a_lens_between_roster_and_floor_is_refused() {
    let general = base("general");
    let x = child("x", &json!({"lenses": [lens("negative-space", "x-ns")]}));
    let why = refused("x", &[&general, &x]);
    assert!(
        why.contains("negative-space") && why.contains("floorLenses"),
        "{why}"
    );
}

#[test]
fn a_required_lens_the_merged_roster_lacks_is_refused() {
    let general = base("general");
    for (extra, named) in [
        (json!({"exclude": ["a"]}), "alwaysLenses"),
        (json!({"exclude": ["b"], "alwaysLenses": []}), "safetyLens"),
    ] {
        let x = child("x", &extra);
        let why = refused("x", &[&general, &x]);
        assert!(why.contains(named), "{why}");
    }
}
