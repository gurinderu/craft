use super::{Seed, lens_block};

#[test]
fn the_seed_renders_its_structure_and_crate_delta_and_nothing_when_empty() {
    assert_eq!(lens_block(&Seed::default()).unwrap(), "");
    let seed = Seed {
        structure: vec!["new crate: c/Cargo.toml".into()],
        crates: vec!["new cycle: b -> c -> b (closed by the new edge b -> c)".into()],
        note: String::new(),
    };
    let block = lens_block(&seed).unwrap();
    assert!(block.contains("DESIGN SEED"), "{block}");
    assert!(block.contains("- new crate: c/Cargo.toml"), "{block}");
    assert!(block.contains("CRATE GRAPH DELTA"), "{block}");
    assert!(block.contains("- new cycle: b -> c -> b"), "{block}");
    let general = Seed {
        structure: vec!["new format: api/v1.proto".into()],
        ..Seed::default()
    };
    assert!(!lens_block(&general).unwrap().contains("CRATE GRAPH"));
    let unread = Seed {
        note: "the crate graph could not be read (boom)".into(),
        ..general
    };
    assert!(
        lens_block(&unread)
            .unwrap()
            .contains("- not read: the crate graph")
    );
}
