//! The lines a change added or rewrote, per file, read from its zero-context diff: a tool's
//! diagnostic is this change's when it sits on one of them, pre-existing debt otherwise.

use std::collections::BTreeMap;

/// Each changed file's added line ranges, inclusive, by its repository-relative path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Lines(BTreeMap<String, Vec<(u32, u32)>>);

impl Lines {
    /// The ranges `git diff -U0` prints in `diff`: each hunk's `+start,count`, a count of 0 (a
    /// pure deletion) adding none.
    pub(super) fn parse(diff: &str) -> Self {
        let mut out: BTreeMap<String, Vec<(u32, u32)>> = BTreeMap::new();
        let mut file: Option<String> = None;
        for l in diff.lines() {
            if let Some(path) = l.strip_prefix("+++ ") {
                file = path.strip_prefix("b/").map(str::to_owned);
            } else if let (Some(f), Some(range)) = (&file, l.strip_prefix("@@ ").and_then(added)) {
                out.entry(f.clone()).or_default().push(range);
            }
        }
        Self(out)
    }

    /// Whether `line` of `file` is one the change added.
    pub(super) fn touches(&self, file: &str, line: u32) -> bool {
        self.0
            .get(file)
            .is_some_and(|rs| rs.iter().any(|&(a, b)| (a..=b).contains(&line)))
    }
}

/// The added range of a hunk header's rest (`-a,b +c,d @@ …`), `None` for none.
fn added(rest: &str) -> Option<(u32, u32)> {
    let new = rest.split_whitespace().find_map(|w| w.strip_prefix('+'))?;
    let (start, count) = match new.split_once(',') {
        Some((s, c)) => (s.parse::<u32>().ok()?, c.parse::<u32>().ok()?),
        None => (new.parse::<u32>().ok()?, 1),
    };
    (count > 0).then(|| (start, start + count - 1))
}

#[cfg(test)]
mod tests {
    use super::Lines;

    #[test]
    fn a_hunk_adds_its_new_range_and_a_deletion_adds_none() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -3 +3 @@ fn x\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n@@ -20,2 +22,0 @@\n-e\n-f\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-g\n";
        let l = Lines::parse(diff);
        assert!(l.touches("src/a.rs", 3) && l.touches("src/a.rs", 12));
        assert!(!l.touches("src/a.rs", 13) && !l.touches("src/a.rs", 22));
        assert!(!l.touches("gone.rs", 1) && !l.touches("src/b.rs", 3));
    }
}
