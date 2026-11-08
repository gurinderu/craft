use super::*;

#[test]
fn a_manifest_names_its_dependencies_as_cargo_matches_them() {
    let m: Table = r#"
[package]
name = "my-crate"
[dependencies]
serde = "1"
core-a = { path = "../a" }
renamed = { package = "real-name", version = "1" }
[dev-dependencies]
tempfile = "3"
[target.'cfg(unix)'.dependencies]
nix-sys = "0.1"
[workspace.dependencies]
ignored = "1"
"#
    .parse()
    .unwrap();
    assert_eq!(
        deps_of(&m),
        ["core_a", "nix_sys", "real_name", "serde", "tempfile"]
    );
    assert_eq!(dir_of("Cargo.toml"), ".");
    assert_eq!(dir_of("crates/a/Cargo.toml"), "crates/a");
}
