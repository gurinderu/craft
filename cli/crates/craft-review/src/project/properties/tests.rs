//! The section read as written, its paths matched as globs or directories, and its report line.

use super::{NONE, Properties, of};

fn read(text: &str) -> Result<Properties, String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let path = dir.path().join("review.toml");
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    of(&path).map_err(|e| e.to_string())
}

#[test]
fn the_section_reads_each_property_and_none_when_absent() {
    assert!(read("version = 1\n").unwrap().is_empty());
    let p = read(
        "version = 1\n[project]\nlibrary = false\nrules = [\"AGENTS.md\"]\ncontrollers = true\nsecurity_paths = [\"src/auth\"]\ncontracts = [\"proto/**/*.proto\"]\n",
    )
    .unwrap();
    assert_eq!(p.library, Some(false));
    assert_eq!(p.rules.as_deref(), Some(&["AGENTS.md".to_owned()][..]));
    assert!(p.controllers && !p.is_empty());
    let e = read("version = 1\n[project]\nlibary = true\n").unwrap_err();
    assert!(e.contains("[project]"), "{e}");
}

#[test]
fn a_path_matches_as_a_glob_or_as_a_directory_above_the_file() {
    let p = Properties {
        security_paths: vec!["src/auth/".into(), "**/secrets.rs".into()],
        contracts: vec!["proto/*.proto".into()],
        ..Properties::new()
    };
    assert!(p.security("src/auth/token.rs"));
    assert!(p.security("src/auth/deep/token.rs"));
    assert!(p.security("crates/x/src/secrets.rs"));
    assert!(
        !p.security("src/authz.rs"),
        "a sibling with the same prefix is not under it"
    );
    assert!(p.contract("proto/api.proto"));
    assert!(!p.contract("proto/v1/api.proto"));
    assert!(!NONE.security("src/auth/token.rs"));
}

#[test]
fn the_report_line_names_what_the_profile_set() {
    assert_eq!(NONE.line(), None);
    let p = Properties {
        library: Some(true),
        rules: Some(Vec::new()),
        controllers: true,
        ..Properties::new()
    };
    let line = p.line().unwrap();
    assert!(
        line.contains("library: yes")
            && line.contains("rule files: none")
            && line.contains("controllers: yes"),
        "{line}"
    );
}
