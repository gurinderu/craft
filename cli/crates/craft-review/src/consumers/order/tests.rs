//! The list's order: the symbol's own crate first, another crate next, tests last.

use super::rank;
use crate::consumers::Site;
use crate::consumers::symbols::Symbol;

fn site(file: &str, line: u32) -> Site {
    Site {
        file: file.into(),
        line,
        text: "f()".into(),
        from: vec!["name search".into()],
        kind: String::new(),
    }
}

#[test]
fn a_symbol_s_own_crate_comes_first_another_crate_next_and_tests_last() {
    let t = tempfile::tempdir().unwrap();
    for c in ["a", "aa"] {
        std::fs::create_dir_all(t.path().join(c).join("src")).unwrap();
        std::fs::write(t.path().join(c).join("Cargo.toml"), "").unwrap();
    }
    let sym = Symbol {
        name: "f".into(),
        file: "a/src/lib.rs".into(),
        line: 1,
    };
    // `aa/` shares the crate's name as a prefix, not its directory: it sorts with `0z/`, after
    // it, not before it with the crate's own lines.
    let mut sites = vec![
        site("a/tests/it.rs", 3),
        site("0z/src/x.rs", 1),
        site("aa/src/use.rs", 7),
        site("a/src/use.rs", 9),
    ];
    rank(t.path(), &sym, &mut sites);
    let got: Vec<&str> = sites.iter().map(|s| s.file.as_str()).collect();
    assert_eq!(
        got,
        [
            "a/src/use.rs",
            "0z/src/x.rs",
            "aa/src/use.rs",
            "a/tests/it.rs"
        ]
    );
}
