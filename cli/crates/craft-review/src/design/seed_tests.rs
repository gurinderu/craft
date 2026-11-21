use std::collections::BTreeMap;

use super::{Seed, lens_block};

fn seed() -> Seed {
    Seed {
        structure: BTreeMap::from([
            (
                "rust".to_owned(),
                vec!["new crate: c/Cargo.toml".to_owned()],
            ),
            (
                "general".to_owned(),
                vec!["new format: api/v1.proto".to_owned()],
            ),
        ]),
        crates: vec!["new edge: c -> a".into()],
        note: String::new(),
    }
}

#[test]
fn each_profiles_design_lens_reads_its_own_lines_and_only_rust_the_crate_delta() {
    assert_eq!(lens_block(&Seed::default(), "rust").unwrap(), "");
    let rust = lens_block(&seed(), "rust").unwrap();
    assert!(rust.contains("DESIGN SEED"), "{rust}");
    assert!(rust.contains("- new crate: c/Cargo.toml"), "{rust}");
    assert!(
        !rust.contains("api/v1.proto"),
        "another profile's line: {rust}"
    );
    assert!(
        rust.contains("CRATE GRAPH DELTA") && rust.contains("- new edge: c -> a"),
        "{rust}"
    );
    let general = lens_block(&seed(), "general").unwrap();
    assert!(general.contains("- new format: api/v1.proto"), "{general}");
    assert!(
        !general.contains("c/Cargo.toml") && !general.contains("CRATE GRAPH"),
        "{general}"
    );
    assert_eq!(
        lens_block(&seed(), "nix").unwrap(),
        "",
        "no line of its own"
    );
}

#[test]
fn a_crate_delta_that_could_not_be_read_says_so_to_rust_alone() {
    let unread = Seed {
        crates: Vec::new(),
        note: "the crate graph could not be read (boom)".into(),
        ..seed()
    };
    let rust = lens_block(&unread, "rust").unwrap();
    assert!(rust.contains("- not read: the crate graph"), "{rust}");
    assert!(!lens_block(&unread, "general").unwrap().contains("not read"));
}
