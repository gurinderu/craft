use std::path::Path;

use super::*;
use crate::profile::Profile;
use crate::state::Track;

#[test]
fn a_profile_without_units_or_a_failed_discovery_keeps_the_normal_mode_with_its_reason() {
    let profiles = [
        Profile::load("nix").unwrap(),
        Profile::load("rust").unwrap(),
    ];
    let tracks = [
        Track::new("nix", Vec::new()),
        Track::new("rust", Vec::new()),
    ];
    let none = Path::new("/nonexistent/craft-units");
    let units = open(true, none, "origin/main", &[], &tracks, &profiles);
    assert!(units.tracks.is_empty());
    assert_eq!(
        units.notices[0],
        "Unit mode not available for Nix: its profile finds no units — the review ran in the normal mode."
    );
    assert!(
        units.notices[1]
            .starts_with("Unit mode skipped, the crate probe failed on the Rust change ("),
        "{}",
        units.notices[1]
    );
    assert_eq!(
        open(false, none, "origin/main", &[], &tracks, &profiles),
        Units::default()
    );
}

#[test]
fn the_general_profile_s_slices_carry_no_project_configuration_and_the_rust_ones_keep_their_manifests()
 {
    let py: Vec<String> = (0..12)
        .map(|i| format!("{}/m/f{i}.py", if i % 2 == 0 { "a" } else { "b" }))
        .collect();
    let rs: Vec<String> = (0..12)
        .map(|i| format!("{}/m/f{i}.rs", if i % 2 == 0 { "c" } else { "d" }))
        .collect();
    let shared = ["package.json".to_owned(), "Cargo.toml".to_owned()];
    let files = [py.clone(), rs.clone(), shared.to_vec()].concat();
    let profiles = [
        Profile::load("rust").unwrap(),
        Profile::load("general").unwrap(),
    ];
    let tracks = [
        Track::new("rust", [rs, vec!["Cargo.toml".into()]].concat()),
        Track::new("general", py),
    ];
    let units = open(
        false,
        Path::new("/nonexistent"),
        "origin/main",
        &files,
        &tracks,
        &profiles,
    );
    let general = &units.directory["general"];
    assert_eq!(general.len(), 2);
    assert!(
        general
            .iter()
            .flat_map(|s| &s.files)
            .all(|f| f.ends_with(".py")),
        "{general:?}"
    );
    let rust = &units.directory["rust"];
    assert!(
        rust.iter()
            .all(|s| s.files.contains(&"Cargo.toml".to_owned())),
        "{rust:?}"
    );
    assert!(
        rust.iter()
            .flat_map(|s| &s.files)
            .all(|f| !f.ends_with(".py")),
        "{rust:?}"
    );
}

/// The general profile slices over no data file (realm @nick/craft, node #625): its schemas,
/// fixtures and golden files neither ride on a slice nor make one of their own, and a part of
/// nothing but data is not sliced at all.
#[test]
fn the_general_profile_slices_over_source_only() {
    let py: Vec<String> = (0..12)
        .map(|i| format!("{}/m/f{i}.py", if i % 2 == 0 { "a" } else { "b" }))
        .collect();
    let data: Vec<String> = (0..20)
        .map(|i| format!("content/{}/c{i}.json", if i % 2 == 0 { "p" } else { "s" }))
        .chain(["tests/fixtures/x.py".to_owned(), "data/rows.csv".to_owned()])
        .collect();
    let profiles = [Profile::load("general").unwrap()];
    let slices = |files: Vec<String>| {
        let tracks = [Track::new("general", files.clone())];
        let none = Path::new("/nonexistent");
        open(false, none, "origin/main", &files, &tracks, &profiles).directory
    };
    let units = slices([py, data.clone()].concat());
    let general = &units["general"];
    assert_eq!(general.len(), 2, "{general:?}");
    assert!(
        general
            .iter()
            .flat_map(|s| &s.files)
            .all(|f| f.ends_with(".py") && !f.contains("fixtures")),
        "{general:?}"
    );
    assert!(slices(data).is_empty(), "nothing but data is not sliced");
}
