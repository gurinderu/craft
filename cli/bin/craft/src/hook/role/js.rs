//! The JavaScript regex and string semantics the hooks' words were first written in, so the same
//! input gives the same answer: JS's `\s` (Unicode spaces, U+FEFF in, U+0085 out), its `\b`
//! (ASCII word characters only), its case-insensitive match without the `u` flag (no non-ASCII
//! letter folds onto an ASCII one, as `K`, U+212A, and `ſ`, U+017F, do in Unicode folding), and
//! Node's `path.resolve` spelling.

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

// The members of JS's `\s`, for use inside a character class: the store's, held equal to
// `is_space` by its tests.
use craft_store::js::SPACE_CLASS as SPACE;
/// JS's `\b`: a boundary between `[A-Za-z0-9_]` and anything else.
const BOUNDARY: &str = r"(?-u:\b)";

/// A pattern written with `{S}` for the members of JS's `\s` and `{B}` for its `\b`.
pub struct Re(LazyLock<Option<Regex>>);

impl Re {
    pub const fn new(build: fn() -> Option<Regex>) -> Self {
        Self(LazyLock::new(build))
    }

    pub fn get(&self) -> Option<&Regex> {
        self.0.as_ref()
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.get().is_some_and(|r| r.is_match(text))
    }
}

/// `pattern` with its placeholders spelled out, compiled.
pub fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(&pattern.replace("{S}", SPACE).replace("{B}", BOUNDARY)).ok()
}

// JS's `\s` and `trim` are the store's (`craft_store::js`), one copy for every crate; `SPACE`
// above spells the same set for a regex class.
pub use craft_store::js::is_space;

/// `text` for a case-insensitive pattern JS reads without the `u` flag: the two letters Unicode
/// folding takes onto ASCII ones are put out of any ASCII letter's reach.
pub fn ascii_case(text: &str) -> Cow<'_, str> {
    if text.contains(['\u{212A}', '\u{17F}']) {
        Cow::Owned(text.replace(['\u{212A}', '\u{17F}'], "\u{FFFD}"))
    } else {
        Cow::Borrowed(text)
    }
}

/// Node's `path.resolve(p)` for an absolute `p`, or one under the current directory: `.` and
/// `..` applied, no symlink followed.
pub fn resolve(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other @ (Component::Prefix(_) | Component::RootDir | Component::Normal(_)) => {
                out.push(other.as_os_str());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_boundary_and_space_classes_compile_and_read_as_js_reads_them() {
        let r = compile(r"(?i){B}review{B}").unwrap();
        assert!(r.is_match("éreview it"), "é is no ASCII word character");
        assert!(!r.is_match("reviewer"));
        let s = compile(r"^a[{S}]+b$").unwrap();
        assert!(s.is_match("a\u{FEFF}b"));
        assert!(!s.is_match("a\u{85}b"));
        assert!(!r.is_match(&ascii_case("re\u{17F}view")));
        assert_eq!(craft_store::js::JsStr::js_trim("\u{FEFF} x \u{A0}"), "x");
        assert_eq!(
            resolve(Path::new("/a/b/../c/./d/")),
            PathBuf::from("/a/c/d")
        );
    }
}
