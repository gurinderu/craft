//! The cargo configs a job may read (realm @nick/craft, node #482): a `cd <dir>` in a run line
//! adds that directory's way up to the root, as `working-directory:` does; an expression is none.

use super::ci_configs::cargo_configs;

#[test]
fn a_cd_in_a_run_line_adds_its_directorys_configs() {
    let t = tempfile::tempdir().unwrap();
    let wf = "jobs:\n  t:\n    steps:\n      - run: cd cli/sub && cargo test\n      - run: cd ${{ matrix.dir }} && cargo test\n      - run: |\n          cd tools; cargo build\n";
    std::fs::write(t.path().join("ci.yml"), wf).unwrap();
    let got = cargo_configs(t.path(), "ci.yml");
    for want in [
        ".cargo/config.toml",
        "cli/.cargo/config.toml",
        "cli/sub/.cargo/config",
        "tools/.cargo/config.toml",
    ] {
        assert!(got.contains(&want.to_owned()), "{want} in {got:?}");
    }
    assert!(!got.iter().any(|c| c.contains("matrix")), "{got:?}");
    assert_eq!(got.len(), 8, "{got:?}");
}
