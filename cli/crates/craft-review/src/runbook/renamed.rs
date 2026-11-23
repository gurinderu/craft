//! The renames a zero-context `git diff` prints: each file's new path to its old one, read from the
//! `--- a/` and `+++ b/` headers between a `diff --git` line and its first hunk, so the old side of a
//! renamed runbook is matched under the path the base holds it at.

use std::collections::BTreeMap;

use crate::gate::lines::header_path;

/// Each renamed file's old path, by its new one.
pub(super) fn renames(diff: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let (mut old, mut in_header) = (None::<String>, false);
    for l in diff.lines() {
        if l.starts_with("diff --git ") {
            (old, in_header) = (None, true);
        } else if l.starts_with("@@ ") {
            in_header = false;
        } else if let Some(rest) = l.strip_prefix("--- ").filter(|_| in_header) {
            old = header_path(rest, "a/");
        } else if let Some(rest) = l.strip_prefix("+++ ").filter(|_| in_header)
            && let (Some(o), Some(n)) = (old.take(), header_path(rest, "b/"))
            && o != n
        {
            out.insert(n, o);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::renames;

    #[test]
    fn a_rename_maps_the_new_path_to_the_old_and_a_plain_change_maps_nothing() {
        let diff = "diff --git a/docs/drain.md b/docs/ops/drain.md\nsimilarity index 90%\nrename from docs/drain.md\nrename to docs/ops/drain.md\n--- a/docs/drain.md\n+++ b/docs/ops/drain.md\n@@ -6 +5,0 @@\n---- a/x\n+++ b/y\ndiff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-x\n+y\n";
        let got = renames(diff);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(
            got.get("docs/ops/drain.md").map(String::as_str),
            Some("docs/drain.md")
        );
    }
}
