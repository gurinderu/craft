//! A function-context diff read into each file's lines: added, removed and context alike, hunks
//! kept apart, a new, deleted, renamed, mode-only or binary file each known by its path.

use super::hunks::{FileChange, parse};

const DIFF: &str = "\
diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,3 +1,3 @@ fn a() {
 fn a() {
-    old();
+    new();
 }
@@ -20,1 +20,2 @@
 x
+y
diff --git a/src/new.rs b/src/new.rs
new file mode 100644
index 0..1
--- /dev/null
+++ b/src/new.rs
@@ -0,0 +1 @@
+fn n() {}
diff --git a/src/gone.rs b/src/gone.rs
deleted file mode 100644
index 1..0
--- a/src/gone.rs
+++ /dev/null
@@ -1 +0,0 @@
-fn g() {}
diff --git a/src/old.rs b/src/moved.rs
similarity index 100%
rename from src/old.rs
rename to src/moved.rs
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git a/img.bin b/img.bin
index 1..2 100644
Binary files a/img.bin and b/img.bin differ
";

fn text(c: &FileChange) -> Vec<String> {
    c.lines
        .as_ref()
        .unwrap()
        .iter()
        .map(|(_, l)| l.clone())
        .collect()
}

#[test]
fn each_file_keeps_its_added_removed_and_context_lines() {
    let got = parse(DIFF);
    let a = &got["src/a.rs"];
    assert_eq!(
        text(a),
        ["fn a() {", "    old();", "    new();", "}", "x", "y"]
    );
    assert_eq!((a.added, a.new), (2, false));
    let pos: Vec<u32> = a.lines.as_ref().unwrap().iter().map(|(p, _)| *p).collect();
    assert_eq!(
        pos,
        [1, 2, 3, 4, 105, 106],
        "one hunk's lines consecutive, the next one 100 on"
    );
    let n = &got["src/new.rs"];
    assert_eq!(
        (text(n), n.added, n.new),
        (vec!["fn n() {}".to_owned()], 1, true)
    );
    let g = &got["src/gone.rs"];
    assert_eq!((text(g), g.added), (vec!["fn g() {}".to_owned()], 0));
}

#[test]
fn a_rename_or_mode_change_is_known_empty_and_a_binary_file_unknown() {
    let got = parse(DIFF);
    assert_eq!(got["src/moved.rs"].lines, Some(Vec::new()));
    assert!(!got.contains_key("src/old.rs"));
    assert_eq!(got["run.sh"].lines, Some(Vec::new()));
    assert_eq!(got["img.bin"], FileChange::default(), "no text: unknown");
    assert_eq!(got.len(), 6);
}

#[test]
fn a_hunk_line_that_looks_like_a_header_is_content() {
    let diff = "\
diff --git a/x.sh b/x.sh
--- a/x.sh
+++ b/x.sh
@@ -1 +1,2 @@
--- a/y
++++ b/z
";
    assert_eq!(text(&parse(diff)["x.sh"]), ["-- a/y", "+++ b/z"]);
}
