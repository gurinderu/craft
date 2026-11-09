//! The lines a change added or rewrote, per file, read from its zero-context diff: a tool's
//! diagnostic is this change's when it sits on one of them, pre-existing debt otherwise.

use std::collections::BTreeMap;

/// Each changed file's added line ranges, inclusive, by its repository-relative path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Lines(BTreeMap<String, Vec<(u32, u32)>>);

impl Lines {
    /// The ranges `git diff -U0` prints in `diff`: each hunk's `+start,count`, a count of 0 (a
    /// pure deletion) adding none.
    pub(crate) fn parse(diff: &str) -> Self {
        Self::side(diff, ("+++ ", "b/", '+'))
    }

    /// The other side of `diff`: each hunk's `-start,count`, the lines of the old file the change
    /// rewrote or removed, by the old file's path; a pure insertion (a count of 0) adds none.
    pub(crate) fn parse_old(diff: &str) -> Self {
        Self::side(diff, ("--- ", "a/", '-'))
    }

    /// The ranges of one side: the file header it reads its path from, that path's prefix, and the
    /// sign of its hunk range.
    fn side(diff: &str, (header, prefix, sign): (&str, &str, char)) -> Self {
        let mut out: BTreeMap<String, Vec<(u32, u32)>> = BTreeMap::new();
        let mut file: Option<String> = None;
        for l in diff.lines() {
            if let Some(path) = l.strip_prefix(header) {
                file = path.strip_prefix(prefix).map(str::to_owned);
            } else if let (Some(f), Some(range)) =
                (&file, l.strip_prefix("@@ ").and_then(|r| range(r, sign)))
            {
                out.entry(f.clone()).or_default().push(range);
            }
        }
        Self(out)
    }

    /// The ranges given, by file.
    #[cfg(test)]
    pub(crate) fn of(ranges: BTreeMap<String, Vec<(u32, u32)>>) -> Self {
        Self(ranges)
    }

    /// Whether `line` of `file` is one the change added.
    pub(crate) fn touches(&self, file: &str, line: u32) -> bool {
        self.0
            .get(file)
            .is_some_and(|rs| rs.iter().any(|&(a, b)| (a..=b).contains(&line)))
    }
}

/// The range of one side (`sign`) of a hunk header's rest (`-a,b +c,d @@ …`), `None` for none.
fn range(rest: &str, sign: char) -> Option<(u32, u32)> {
    let new = rest
        .split_whitespace()
        .take(2)
        .find_map(|w| w.strip_prefix(sign))?;
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

    #[test]
    fn the_old_side_holds_the_rewritten_and_removed_lines_and_no_insertion() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -3 +3 @@ fn x\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n@@ -20,2 +22,0 @@\n-e\n-f\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-g\n--- /dev/null\n+++ b/new.rs\n@@ -0,0 +1 @@\n+h\n";
        let l = Lines::parse_old(diff);
        assert!(l.touches("src/a.rs", 3) && l.touches("src/a.rs", 20) && l.touches("src/a.rs", 21));
        assert!(!l.touches("src/a.rs", 10) && !l.touches("src/a.rs", 11));
        assert!(l.touches("gone.rs", 1) && !l.touches("new.rs", 1));
    }
}
