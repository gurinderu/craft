//! The lines a change added or rewrote, per file, read from its zero-context diff: a tool's
//! diagnostic is this change's when it sits on one of them, pre-existing debt otherwise.

use std::collections::BTreeMap;
use std::path::Path;

mod path;

pub(crate) use path::header_path;

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
    /// sign of its hunk range. A file's headers are read only between its `diff --git` line and its
    /// first hunk: inside a hunk a removed `-- x` prints as `--- x` and an added `++ y` as `+++ y`,
    /// content that no header must be read from.
    fn side(diff: &str, (header, prefix, sign): (&str, &str, char)) -> Self {
        let mut out: BTreeMap<String, Vec<(u32, u32)>> = BTreeMap::new();
        let mut file: Option<String> = None;
        let mut in_header = false;
        for l in diff.lines() {
            if l.starts_with("diff --git ") {
                (file, in_header) = (None, true);
            } else if let Some(rest) = l.strip_prefix("@@ ") {
                in_header = false;
                if let (Some(f), Some(range)) = (&file, range(rest, sign)) {
                    out.entry(f.clone()).or_default().push(range);
                }
            } else if let Some(path) = l.strip_prefix(header).filter(|_| in_header) {
                file = header_path(path, prefix);
            }
        }
        Self(out)
    }

    /// The ranges given, by file.
    #[cfg(test)]
    pub(crate) fn of(ranges: BTreeMap<String, Vec<(u32, u32)>>) -> Self {
        Self(ranges)
    }

    /// Each file's added ranges, by path.
    pub(crate) fn ranges(&self) -> impl Iterator<Item = (&str, &[(u32, u32)])> {
        self.0.iter().map(|(f, rs)| (f.as_str(), rs.as_slice()))
    }

    /// The lines of `file` the change added, as the working tree at `top` holds them, each with
    /// its number; none when the file cannot be read.
    pub(crate) fn added_text(&self, top: &Path, file: &str) -> Vec<(u32, String)> {
        let Some(ranges) = self.0.get(file) else {
            return Vec::new();
        };
        let Ok(text) = std::fs::read_to_string(top.join(file)) else {
            return Vec::new();
        };
        text.lines()
            .zip(1u32..)
            .filter(|(_, n)| ranges.iter().any(|&(a, b)| (a..=b).contains(n)))
            .map(|(l, n)| (n, l.to_owned()))
            .collect()
    }

    /// Whether `line` of `file` is one the change added.
    pub(crate) fn touches(&self, file: &str, line: u32) -> bool {
        self.0
            .get(file)
            .is_some_and(|rs| rs.iter().any(|&(a, b)| (a..=b).contains(&line)))
    }
}

/// A hunk of a zero-context diff that only removes lines: the new file's path, the new-side line
/// the removed lines sat after (0 at the top of the file), and their text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Removal {
    pub file: String,
    pub after: u32,
    pub text: Vec<String>,
}

/// The pure deletions `git diff -U0` prints in `diff` (a hunk whose new count is 0), in a file
/// the change keeps; a deleted file's are none. Headers are read as [`Lines::parse`] reads them.
pub(crate) fn removals(diff: &str) -> Vec<Removal> {
    let mut out: Vec<Removal> = Vec::new();
    let (mut file, mut in_header, mut open) = (None::<String>, false, false);
    for l in diff.lines() {
        if l.starts_with("diff --git ") {
            (file, in_header, open) = (None, true, false);
        } else if let Some(rest) = l.strip_prefix("@@ ") {
            in_header = false;
            open = false;
            if let (Some(f), Some(after)) = (&file, removed_after(rest)) {
                out.push(Removal {
                    file: f.clone(),
                    after,
                    text: Vec::new(),
                });
                open = true;
            }
        } else if in_header {
            if let Some(path) = l.strip_prefix("+++ ") {
                file = header_path(path, "b/");
            }
        } else if let (true, Some(t), Some(r)) = (open, l.strip_prefix('-'), out.last_mut()) {
            r.text.push(t.to_owned());
        }
    }
    out
}

/// The new-side line a hunk header's rest (`-a,b +c,d @@ …`) removes lines after, when its new
/// count is 0.
fn removed_after(rest: &str) -> Option<u32> {
    let new = rest.split_whitespace().nth(1)?.strip_prefix('+')?;
    let (start, count) = new.split_once(',')?;
    (count == "0").then(|| start.parse().ok()).flatten()
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
        let diff = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -3 +3 @@ fn x\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n@@ -20,2 +22,0 @@\n-e\n-f\ndiff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-g\n";
        let l = Lines::parse(diff);
        assert!(l.touches("src/a.rs", 3) && l.touches("src/a.rs", 12));
        assert!(!l.touches("src/a.rs", 13) && !l.touches("src/a.rs", 22));
        assert!(!l.touches("gone.rs", 1) && !l.touches("src/b.rs", 3));
    }

    #[test]
    fn the_old_side_holds_the_rewritten_and_removed_lines_and_no_insertion() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -3 +3 @@ fn x\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n+d\n@@ -20,2 +22,0 @@\n-e\n-f\ndiff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-g\ndiff --git a/new.rs b/new.rs\nnew file mode 100644\n--- /dev/null\n+++ b/new.rs\n@@ -0,0 +1 @@\n+h\n";
        let l = Lines::parse_old(diff);
        assert!(l.touches("src/a.rs", 3) && l.touches("src/a.rs", 20) && l.touches("src/a.rs", 21));
        assert!(!l.touches("src/a.rs", 10) && !l.touches("src/a.rs", 11));
        assert!(l.touches("gone.rs", 1) && !l.touches("new.rs", 1));
    }

    /// A removed line reading `-- x` and an added one reading `++ y` print as `--- x` and `+++ y`
    /// in a zero-context diff: content, not a file header.
    const LOOKALIKES: &str = "diff --git a/q.sql b/q.sql\nindex 1..2 100644\n--- a/q.sql\n+++ b/q.sql\n@@ -2 +1,0 @@\n--- a comment\n@@ -5 +4 @@\n-x\n+y\n@@ -9,0 +9 @@\n+++ counter\n@@ -12 +12 @@\n-z\n+w\n";

    #[test]
    fn a_pure_deletion_is_read_with_where_it_was_and_what_it_removed() {
        let diff = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -3 +3 @@ fn x\n-a\n+b\n@@ -20,2 +22,0 @@\n-e\n--- f\ndiff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-g\n";
        let got = super::removals(diff);
        assert_eq!(
            got,
            vec![super::Removal {
                file: "src/a.rs".into(),
                after: 22,
                text: vec!["e".into(), "-- f".into()],
            }]
        );
    }

    #[test]
    fn a_removed_line_that_reads_like_a_header_keeps_the_hunks_after_it() {
        let l = Lines::parse_old(LOOKALIKES);
        assert!(l.touches("q.sql", 2) && l.touches("q.sql", 5) && l.touches("q.sql", 12));
    }

    #[test]
    fn an_added_line_that_reads_like_a_header_keeps_the_hunks_after_it() {
        let l = Lines::parse(LOOKALIKES);
        assert!(l.touches("q.sql", 4) && l.touches("q.sql", 9) && l.touches("q.sql", 12));
    }

    /// A path holding a space ends its header with a tab; one holding a quote, a backslash or a
    /// control character is quoted, C-style, prefix and all.
    const ODD_PATHS: &str = "diff --git a/my dir/x.rs b/my dir/x.rs\n--- a/my dir/x.rs\t\n+++ b/my dir/x.rs\t\n@@ -1,2 +1 @@\n-a\n-b\n+c\n@@ -5 +4,0 @@\n-d\ndiff --git \"a/q\\\"t.rs\" \"b/q\\\"t.rs\"\n--- \"a/q\\\"t.rs\"\n+++ \"b/q\\\"t.rs\"\n@@ -2 +2 @@\n-e\n+f\n@@ -7 +6,0 @@\n-g\ndiff --git \"a/t\\tx\\303\\251.rs\" \"b/t\\tx\\303\\251.rs\"\n--- \"a/t\\tx\\303\\251.rs\"\n+++ \"b/t\\tx\\303\\251.rs\"\n@@ -3 +3 @@\n-h\n+i\n";

    #[test]
    fn a_header_path_with_a_space_or_a_quote_is_read_as_the_file_s_own() {
        let l = Lines::parse(ODD_PATHS);
        assert!(l.touches("my dir/x.rs", 1), "{l:?}");
        assert!(l.touches("q\"t.rs", 2), "{l:?}");
        assert!(l.touches("t\txé.rs", 3), "{l:?}");
        let old = Lines::parse_old(ODD_PATHS);
        assert!(
            old.touches("my dir/x.rs", 2) && old.touches("q\"t.rs", 7),
            "{old:?}"
        );
    }

    #[test]
    fn a_pure_deletion_under_a_spaced_or_quoted_path_is_read_with_its_path() {
        let files: Vec<String> = super::removals(ODD_PATHS)
            .into_iter()
            .map(|r| r.file)
            .collect();
        assert_eq!(files, vec!["my dir/x.rs".to_owned(), "q\"t.rs".to_owned()]);
    }
}
