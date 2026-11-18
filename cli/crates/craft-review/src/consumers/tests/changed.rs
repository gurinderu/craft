//! Which changed symbols the list takes: every one past the limit said, a name changed in two
//! files kept per file, a file it cannot read said, a test item left out.

use std::path::{Path, PathBuf};

use super::{diff_of, git};
use crate::consumers::{build, lens_block, section};

/// A repository whose base holds `base` and whose head commit writes `head`, each `(path, text)`.
fn repo(t: &Path, base: &[(&str, &str)], head: &[(&str, &str)]) -> PathBuf {
    let repo = t.join("repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README"), "r\n").unwrap();
    for (p, text) in base {
        std::fs::write(repo.join(p), text).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    for (p, text) in head {
        std::fs::write(repo.join(p), text).unwrap();
    }
    git(&repo, &["add", "."]);
    git(
        &repo,
        &["commit", "-q", "--allow-empty", "-m", "feat: change"],
    );
    repo
}

#[test]
fn every_symbol_past_the_limit_is_named_in_both_outputs() {
    let t = tempfile::tempdir().unwrap();
    let text: String = (0..45)
        .map(|i| format!("pub fn sym_{i:02}() -> u8 {{\n    {i}\n}}\n"))
        .collect();
    let repo = repo(t.path(), &[], &[("src/lib.rs", &text)]);
    let c = build(&repo, &diff_of(&repo), Err("no graph".into()));
    assert_eq!(c.symbols.len(), 40);
    let past: Vec<String> = (40..45).map(|i| format!("sym_{i} (src/lib.rs)")).collect();
    assert_eq!(c.unlisted, past);
    let (s, block) = (section(&c), lens_block(&c).unwrap());
    for name in &past {
        assert!(s.contains(name.as_str()), "{s}");
        assert!(block.contains(name.as_str()), "{block}");
    }
    assert!(s.contains("past the 40-symbol limit"), "{s}");
    assert!(block.contains("past the 40-symbol limit"), "{block}");
}

#[test]
fn a_name_changed_in_two_files_is_kept_for_each() {
    let t = tempfile::tempdir().unwrap();
    let a = "pub fn shared_name() -> u8 {\n    1\n}\n";
    let b = "pub fn shared_name() -> u8 {\n    2\n}\n";
    let repo = repo(t.path(), &[], &[("src/a.rs", a), ("src/b.rs", b)]);
    let c = build(&repo, &diff_of(&repo), Err(String::new()));
    let listed: Vec<(&str, &str)> = c
        .symbols
        .iter()
        .map(|s| (s.name.as_str(), s.file.as_str()))
        .collect();
    assert_eq!(
        listed,
        vec![("shared_name", "src/a.rs"), ("shared_name", "src/b.rs")]
    );
}

#[cfg(unix)]
#[test]
fn a_changed_file_that_is_a_link_is_said_not_read_through() {
    let t = tempfile::tempdir().unwrap();
    let outside = t.path().join("outside.rs");
    std::fs::write(&outside, "pub fn far_away() {}\n").unwrap();
    let repo = repo(t.path(), &[], &[]);
    std::os::unix::fs::symlink(&outside, repo.join("src/linked.rs")).unwrap();
    std::os::unix::fs::symlink("/dev/zero", repo.join("src/zero.rs")).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "feat: links"]);
    let c = build(&repo, &diff_of(&repo), Err(String::new()));
    assert!(c.symbols.is_empty(), "{:?}", c.symbols);
    assert_eq!(
        c.unreadable,
        vec![
            "src/linked.rs (not a regular file)",
            "src/zero.rs (not a regular file)"
        ]
    );
    let s = section(&c);
    assert!(s.contains("src/linked.rs (not a regular file)"), "{s}");
}

#[test]
fn a_file_that_is_not_utf8_or_too_large_is_said() {
    let t = tempfile::tempdir().unwrap();
    let top = t.path();
    std::fs::create_dir_all(top.join("src")).unwrap();
    std::fs::write(top.join("src/bad.rs"), b"pub fn bad() {}\n\xff\xfe\n").unwrap();
    let big = "// x\n".repeat(1 << 20);
    std::fs::write(top.join("src/big.rs"), format!("pub fn big() {{}}\n{big}")).unwrap();
    let ranges = [("src/bad.rs", vec![(1, 1)]), ("src/big.rs", vec![(1, 1)])]
        .into_iter()
        .map(|(f, r)| (f.to_owned(), r))
        .collect();
    let lines = crate::gate::lines::Lines::of(ranges);
    let files = vec!["src/bad.rs".to_owned(), "src/big.rs".to_owned()];
    let got = crate::consumers::symbols::changed(top, &files, &lines, 40);
    assert!(got.symbols.is_empty(), "{:?}", got.symbols);
    assert_eq!(got.unreadable.len(), 2, "{:?}", got.unreadable);
    assert!(got.unreadable[0].starts_with("src/bad.rs (not UTF-8"));
    assert!(got.unreadable[1].starts_with("src/big.rs (larger than"));
}

#[test]
fn a_test_item_is_left_out_whatever_its_attribute_looks_like() {
    let text = "#[tokio::test(\n    flavor = \"multi_thread\"\n)]\nasync fn t1() {\n    a();\n}\n#[test_case(1)]\nfn t2(x: u8) {\n    b();\n}\n#[rstest]\n/// doc\nfn t3() {\n    c();\n}\n#[cfg(test)]\nmod tests {\n    fn helper() {\n        d();\n    }\n}\n#[inline]\nfn kept() {\n    e();\n}\n";
    let (found, _) = crate::consumers::symbols::of_file("a.rs", text, &[(1, 26)]);
    let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["kept"]);
}
