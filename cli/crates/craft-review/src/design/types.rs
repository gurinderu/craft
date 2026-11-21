//! The public types a file's added lines declare, by the file's language: only where the spelling
//! says the type is public — Rust `pub`, an ES/TS `export class|interface|type`, `public` in the
//! JVM and .NET languages and Swift, a capitalised Go `type` (alone or in a `type (` block), a
//! top-level Python class not named with `_` — and Rust's inline modules. A line heuristic, not a
//! parser.

use std::sync::LazyLock;

use regex::Regex;

fn re(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

static RUST: LazyLock<Option<Regex>> =
    LazyLock::new(|| re(r"^\s*pub\s+(?:struct|enum|trait|type|union)\s+([A-Za-z_]\w*)"));
static ES: LazyLock<Option<Regex>> = LazyLock::new(|| {
    re(r"^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type)\s+([A-Za-z_$][\w$]*)")
});
static PUBLIC: LazyLock<Option<Regex>> = LazyLock::new(|| {
    re(
        r"^\s*public\s+(?:(?:static|final|abstract|sealed|partial)\s+)*(?:class|interface|record|enum|struct|protocol)\s+([A-Za-z_]\w*)",
    )
});
static GO: LazyLock<Option<Regex>> = LazyLock::new(|| re(r"^type\s+([A-Z]\w*)\s+\S"));
/// A spec inside a grouped `type (` block: indented, a capitalised name, then its type.
static GO_SPEC: LazyLock<Option<Regex>> = LazyLock::new(|| re(r"^\s+([A-Z]\w*)\s+\S"));
static PYTHON: LazyLock<Option<Regex>> = LazyLock::new(|| re(r"^class\s+([A-Za-z]\w*)"));

/// The pattern that declares a public type in a file of extension `ext`, if its language has one.
fn pattern(ext: &str) -> Option<&'static Regex> {
    let re = match ext {
        "rs" => &RUST,
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => &ES,
        "java" | "kt" | "cs" | "swift" | "scala" => &PUBLIC,
        "go" => &GO,
        "py" => &PYTHON,
        _ => return None,
    };
    re.as_ref()
}

fn name(re: Option<&Regex>, line: &str) -> Option<String> {
    Some(re?.captures(line)?.get(1)?.as_str().to_owned())
}

/// The public types the added `lines` of a file of extension `ext` declare, each with its line;
/// a Go `type (` block opened on an added line is read spec by spec to its `)`.
pub(super) fn declared(ext: &str, lines: &[(u32, String)]) -> Vec<(u32, String)> {
    let Some(re) = pattern(ext) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut group = false;
    for (n, l) in lines {
        if ext == "go" && group {
            if l.trim_start().starts_with(')') {
                group = false;
            } else if let Some(t) = name(GO_SPEC.as_ref(), l) {
                out.push((*n, t));
            }
        } else if ext == "go" && l.trim_end() == "type (" {
            group = true;
        } else if let Some(t) = name(Some(re), l) {
            out.push((*n, t));
        }
    }
    out
}

/// The `git grep -E` pattern that finds a declaration of the type `name` anywhere in a tree.
pub(super) fn base_pattern(name: &str) -> String {
    let n = regex::escape(name);
    format!(
        "(struct|enum|trait|type|union|class|interface|record|protocol)[[:space:]]+{n}([^[:alnum:]_$]|$)|^[[:space:]]+{n}[[:space:]]+(struct|interface)"
    )
}

/// An inline Rust module, `mod name {`: the one module no new file carries.
static INLINE_MOD: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{").ok());

/// The inline Rust module `line` opens, a test module aside.
pub(super) fn inline_module(line: &str) -> Option<String> {
    let name = INLINE_MOD.as_ref()?.captures(line)?.get(1)?.as_str();
    let test =
        name == "test" || name == "tests" || name.ends_with("_test") || name.ends_with("_tests");
    (!test).then(|| name.to_owned())
}
