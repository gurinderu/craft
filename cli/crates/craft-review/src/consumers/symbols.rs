//! The Rust symbols a change adds or changes: an item declared on a changed line, and the item
//! whose body a changed line sits in — the nearest declaration above it, indented less, with no
//! closing brace of its level between. Test functions and test files are left out.

use std::sync::LazyLock;

use regex::Regex;

use crate::gate::lines::Lines;

/// A Rust item declaration and its name.
static DECL: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r#"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|default|extern(?:\s+"[^"]*")?)\s+)*(?:fn|struct|enum|trait|type|const|static|union|macro_rules!)\s*([A-Za-z_][A-Za-z0-9_]*)"#,
    )
    .ok()
});

/// How far above a changed line its enclosing item is looked for.
const SCAN_MAX: usize = 400;

/// A changed symbol: its name and where it is declared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub file: String,
    pub line: u32,
}

/// The name `line` declares, if it declares an item.
pub(super) fn declared(line: &str) -> Option<&str> {
    let re = DECL.as_ref()?;
    Some(re.captures(line)?.get(1)?.as_str())
}

/// Whether `path` is a test file: under a `tests` directory, or named `tests.rs`, `*_tests.rs`
/// or `*_test.rs`.
pub(super) fn is_test_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    path.split('/').any(|s| s == "tests" || s == "benches")
        || name == "tests.rs"
        || name.ends_with("_tests.rs")
        || name.ends_with("_test.rs")
}

fn indent(l: &str) -> usize {
    l.len() - l.trim_start().len()
}

/// Whether the declaration at `at` carries a test attribute on the lines above it.
fn is_test_fn(lines: &[&str], at: usize) -> bool {
    lines
        .get(..at)
        .unwrap_or_default()
        .iter()
        .rev()
        .take_while(|l| {
            let t = l.trim_start();
            t.starts_with("#[") || t.starts_with("///")
        })
        .any(|l| l.contains("test]") || l.contains("test("))
}

/// The declaration line index enclosing `at` (0-based), the line itself when it declares.
fn enclosing(lines: &[&str], at: usize) -> Option<usize> {
    let here = lines.get(at)?;
    if declared(here).is_some() {
        return Some(at);
    }
    let level = indent(here);
    let above = lines.get(at.saturating_sub(SCAN_MAX)..at)?;
    for (i, l) in above.iter().enumerate().rev() {
        let t = l.trim_start();
        if t.is_empty() || indent(l) >= level {
            continue;
        }
        if declared(l).is_some() {
            return Some(at.saturating_sub(SCAN_MAX) + i);
        }
        if t.starts_with('}') {
            return None;
        }
    }
    None
}

/// The symbols of one file's text `text` that its changed `ranges` (1-based, inclusive) add or
/// change, in order, each once.
pub(super) fn of_file(file: &str, text: &str, ranges: &[(u32, u32)]) -> Vec<Symbol> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<Symbol> = Vec::new();
    for &(a, b) in ranges {
        for n in a..=b {
            let Some(at) = usize::try_from(n).ok().and_then(|n| n.checked_sub(1)) else {
                continue;
            };
            let Some(d) = enclosing(&lines, at) else {
                continue;
            };
            let name = lines.get(d).and_then(|l| declared(l)).unwrap_or_default();
            if name.is_empty() || is_test_fn(&lines, d) || out.iter().any(|s| s.name == name) {
                continue;
            }
            out.push(Symbol {
                name: name.to_owned(),
                file: file.to_owned(),
                line: u32::try_from(d + 1).unwrap_or(u32::MAX),
            });
        }
    }
    out
}

/// The symbols the change `lines` adds or changes in the Rust files of `files` under `top`, each
/// name once, at most `max`.
pub(super) fn changed(
    top: &std::path::Path,
    files: &[String],
    lines: &Lines,
    max: usize,
) -> Vec<Symbol> {
    let mut out: Vec<Symbol> = Vec::new();
    for (file, ranges) in lines.ranges() {
        if !file.ends_with(".rs") || is_test_path(file) || !files.iter().any(|f| f == file) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(top.join(file)) else {
            continue;
        };
        for s in of_file(file, &text, ranges) {
            if !out.iter().any(|o| o.name == s.name) {
                out.push(s);
            }
        }
    }
    out.truncate(max);
    out
}
