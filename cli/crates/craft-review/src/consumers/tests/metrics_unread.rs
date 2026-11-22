//! The changed files whose functions the metrics read did not take whole are named as unread,
//! each with why, so the lens judges no file it has no numbers for as if it had them.

use std::path::Path;

use super::metrics::{COLS, row, stand_in};
use super::{diff_of, fixture, git};
use crate::consumers::{Consumers, build_for_metrics};

const FN: &str = "pub fn g() -> u8 {\n    1\n}\n";

/// The fixture with `files` more added in a commit of the change, each holding [`FN`].
fn with_files(t: &Path, files: &[String]) -> std::path::PathBuf {
    let repo = fixture(t, "");
    for f in files {
        std::fs::write(repo.join(f), FN).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "feat: more"]);
    repo
}

/// The metrics read of the change in `repo` from a graph answering `rows` (`status` more of its
/// status).
fn read(t: &Path, repo: &Path, status: &str, rows: &str) -> Consumers {
    build_for_metrics(repo, &diff_of(repo), Ok(stand_in(t, (status, rows, false))))
}

fn unread_of<'a>(c: &'a Consumers, file: &str) -> Vec<&'a str> {
    let at = format!("{file} (");
    c.metrics_unread
        .iter()
        .filter(|u| u.starts_with(&at))
        .map(String::as_str)
        .collect()
}

#[test]
fn a_file_the_index_left_out_or_past_the_file_limit_is_named_unread() {
    let t = tempfile::tempdir().unwrap();
    let files: Vec<String> = (0..41).map(|i| format!("src/m{i:02}.rs")).collect();
    let repo = with_files(t.path(), &files);
    let status = r#","not_indexed":{"files":["src/m00.rs"]}"#;
    let rows = format!(r#"echo '{{{COLS},"rows":[{}]}}'"#, row("g", 1, 3));
    let c = read(t.path(), &repo, status, &rows);
    assert!(c.metrics_failed.is_empty(), "{}", c.metrics_failed);
    assert_eq!(
        unread_of(&c, "src/m00.rs"),
        ["src/m00.rs (not indexed by the graph)"]
    );
    // src/lib.rs and src/m01..m39 are asked: 40 files; m40 is past the limit.
    assert_eq!(
        unread_of(&c, "src/m40.rs"),
        ["src/m40.rs (past the 40-file limit)"]
    );
    assert_eq!(c.metrics_unread.len(), 2, "{:?}", c.metrics_unread);
    // The graph answers `g` over lines 1-3 for every file asked: the 40 asked are measured.
    assert_eq!(c.metrics.iter().filter(|m| m.function == "g").count(), 40);
}

#[test]
fn a_cut_an_unreadable_or_an_odd_answer_names_the_file_unread_with_every_reason_and_keeps_what_read()
 {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let one = row("k8s_rule_to_api", 1, 3);
    for (rows, why, kept) in [
        (
            format!(r#"echo '{{{COLS},"rows":[{one}],"has_more":true}}'"#),
            "its functions cut at 500",
            1,
        ),
        (
            format!(r#"echo '{{{COLS},"rows":[{one},["h","x","2"]]}}'"#),
            "1 of its rows did not read as a function",
            1,
        ),
        (
            format!(
                r#"echo '{{{},"rows":[{one}]}}'"#,
                COLS.replace(r#","f.unguarded_recursion""#, "")
            ),
            "the graph's answer names no column f.unguarded_recursion",
            1,
        ),
        (
            format!(
                r#"echo '{{{COLS},"rows":[["k8s_rule_to_api","1","3","many","1","0","0","1","0","false","false","1"]],"truncated":true}}'"#
            ),
            "its functions cut at 500; 1 of its rows hold a metric that did not read",
            1,
        ),
    ] {
        let c = read(t.path(), &repo, "", &rows);
        let unread = unread_of(&c, "src/lib.rs");
        // The file's readable functions are still measured beside its unread note.
        assert_eq!(c.metrics.len(), kept, "{why}: {:?}", c.metrics);
        assert!(
            unread.len() == 1 && unread[0].contains(why),
            "{why}: {:?}",
            c.metrics_unread
        );
        assert!(
            c.metrics_failed.is_empty(),
            "{why}: not a failure of the read"
        );
    }
}

#[test]
fn a_later_files_failed_question_names_it_and_keeps_the_others_numbers() {
    let t = tempfile::tempdir().unwrap();
    let repo = with_files(t.path(), &["src/z.rs".to_owned()]);
    let rows = format!(
        r#"case "$4" in *src/z.rs*) echo '{{"error":"busy"}}'; exit 1;; *) echo '{{{COLS},"rows":[{}]}}';; esac"#,
        row("k8s_rule_to_api", 1, 3)
    );
    let c = read(t.path(), &repo, "", &rows);
    assert!(c.metrics_failed.is_empty(), "{}", c.metrics_failed);
    assert_eq!(c.metrics.len(), 1, "{c:?}");
    let unread = unread_of(&c, "src/z.rs");
    assert!(
        unread.len() == 1 && unread[0].contains("busy"),
        "{:?}",
        c.metrics_unread
    );
}

/// `rows` for the metrics question, `probe` for the graph's probe for any function's numbers.
fn with_probe(probe: &str, rows: &str) -> String {
    format!(
        "case \"$4\" in *'WHERE f.file_path IS NOT NULL AND f.cognitive IS NOT NULL RETURN f.name LIMIT 1'*) {probe};; *) {rows};; esac"
    )
}

#[test]
fn a_file_that_answered_no_function_is_empty_not_unread_when_the_graph_holds_numbers() {
    let t = tempfile::tempdir().unwrap();
    let repo = fixture(t.path(), "");
    let empty = format!(r#"echo '{{{COLS},"rows":[]}}'"#);
    let holds = r#"echo '{"columns":["f.name"],"rows":[["g"]]}'"#;
    let c = read(t.path(), &repo, "", &with_probe(holds, &empty));
    assert!(c.metrics.is_empty() && c.metrics_unread.is_empty(), "{c:?}");
    assert!(c.metrics_failed.is_empty(), "{}", c.metrics_failed);
    assert_eq!(c.metrics_empty, ["src/lib.rs"]);
    for (probe, why) in [
        (
            r#"echo '{"columns":["f.name"],"rows":[]}'"#,
            "the graph holds no function numbers",
        ),
        (r#"echo '{"error":"probe boom"}'; exit 1"#, "probe boom"),
    ] {
        let c = read(t.path(), &repo, "", &with_probe(probe, &empty));
        assert!(
            c.metrics_failed.contains(why),
            "{why}: {}",
            c.metrics_failed
        );
    }
}
