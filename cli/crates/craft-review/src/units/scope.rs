//! Which unit owns a changed file (`lib/unit-scope.mjs`): the deepest root that is a directory
//! prefix of it, segment by segment; the key of a unit slice; and the directory slicing of the files
//! in no unit.

use super::Slice;
use super::dirs::slice_diff;

/// Fewer owned files than this and a change is not sliced by unit, as the directory slicing does
/// not slice it (`UNIT_MIN_FILES`).
pub const UNIT_MIN_FILES: usize = 12;
/// How many directory slices the files in no unit are cut into at most.
pub const MAX_SLICES: usize = 6;

/// A unit root as git spells a directory: no `./`, no trailing `/`, the repository root as `.`.
#[must_use]
pub fn unit_root_of(root: &str) -> String {
    let segs: Vec<&str> = root
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segs.is_empty() {
        ".".into()
    } else {
        segs.join("/")
    }
}

/// The unit that owns `file`: the root with the most segments that is a strict directory prefix of
/// it (`crates/a` does not own `crates/ab/x.rs`); `None` when none does.
#[must_use]
pub fn unit_of(file: &str, roots: &[String]) -> Option<String> {
    let parts: Vec<&str> = file.split('/').collect();
    let mut best: Option<(usize, String)> = None;
    for r in roots {
        let root = unit_root_of(r);
        let segs: Vec<&str> = if root == "." {
            Vec::new()
        } else {
            root.split('/').collect()
        };
        let prefix = segs.len() < parts.len() && segs.iter().zip(&parts).all(|(s, p)| s == p);
        if prefix && best.as_ref().is_none_or(|b| segs.len() > b.0) {
            best = Some((segs.len(), root));
        }
    }
    best.map(|b| b.1)
}

/// The units `files` touch, sorted, each once.
#[must_use]
pub fn touched_units(files: &[String], roots: &[String]) -> Vec<String> {
    let mut out: Vec<String> = files.iter().filter_map(|f| unit_of(f, roots)).collect();
    out.sort();
    out.dedup();
    out
}

/// The key of a unit slice: `unit:<root>`, and `unit:<root>//<module>` for one module of an
/// oversized unit — the root stays readable in the task's label.
#[must_use]
pub fn unit_slice_key(root: &str, module_key: &str) -> String {
    let sub = if module_key == root {
        ""
    } else if root == "." {
        module_key
    } else {
        module_key.get(root.len() + 1..).unwrap_or("")
    };
    if sub.is_empty() {
        format!("unit:{root}")
    } else {
        format!("unit:{root}//{sub}")
    }
}

/// The files in no unit keep the directory slicing; too few to split are one slice of their own.
#[must_use]
pub fn loose_groups(
    loose: &[String],
    shared: &[String],
    owns: &dyn Fn(&str) -> bool,
) -> Vec<Slice> {
    if loose.is_empty() {
        return Vec::new();
    }
    let all = [loose, shared].concat();
    let groups = slice_diff(&all, 1, MAX_SLICES, owns);
    if groups.is_empty() {
        vec![Slice::loose("outside units".into(), all)]
    } else {
        groups
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_deepest_root_owns_a_file_by_whole_segments() {
        let roots = vec![
            "crates/a".to_owned(),
            "crates/a/inner".to_owned(),
            "./".to_owned(),
        ];
        assert_eq!(
            unit_of("crates/a/src/x.rs", &roots).as_deref(),
            Some("crates/a")
        );
        assert_eq!(
            unit_of("crates/a/inner/x.rs", &roots).as_deref(),
            Some("crates/a/inner")
        );
        assert_eq!(unit_of("crates/ab/x.rs", &roots).as_deref(), Some("."));
        assert_eq!(unit_of("x.rs", &["crates/a".to_owned()]), None);
        assert_eq!(
            unit_slice_key("crates/a", "crates/a/src"),
            "unit:crates/a//src"
        );
        assert_eq!(unit_slice_key(".", "src"), "unit:.//src");
    }
}
