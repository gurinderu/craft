use std::fs;
use std::path::Path;

use super::index::{self, POINTER};
use super::{Outcome, reindex};

fn record(dir: &Path, id: &str, title: &str, scope: &str, status: &str) {
    let kind = id.split('-').next().unwrap();
    let text = format!(
        "---\nname: {id}\ndescription: \"{kind}: {title}\"\nmetadata:\n  type: project\n  craft_kind: {kind}    # the kind\n  craft_scope: {scope}\n  craft_status: {status}\n  modified: 2026-10-06\n---\n\nwhy\n"
    );
    fs::write(dir.join(format!("{id}.md")), text).unwrap();
}

const USER_LINES: &str = "# Memory\n\n- [my own note](note.md) — keep me\n";

/// A directory laid out as an earlier release left it: craft's lines in `MEMORY.md` among the
/// user's, one of them for a superseded record and one for a record file that is not craft's.
fn old_layout() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    record(
        d.path(),
        "decision-0123456789",
        "unwrap is fine #12",
        "src/parse.rs",
        "active",
    );
    record(d.path(), "rule-abcdef0123", "no rollback", ".", "active");
    record(
        d.path(),
        "lesson-1111111111",
        "old lesson",
        "src",
        "superseded",
    );
    fs::write(
        d.path().join("question-2222222222.md"),
        "---\nname: x\n---\nnot craft's\n",
    )
    .unwrap();
    fs::write(d.path().join("note.md"), "mine").unwrap();
    let harness = format!(
        "{USER_LINES}- [decision: unwrap is fine #12](decision-0123456789.md) — src/parse.rs\n- [rule: no rollback](rule-abcdef0123.md) — .\n- [lesson: old lesson](lesson-1111111111.md) — src\n- [question: not craft's](question-2222222222.md) — src\n\nA closing paragraph of the user's.\n"
    );
    fs::write(d.path().join("MEMORY.md"), harness).unwrap();
    d
}

#[test]
fn the_migration_moves_only_crafts_lines_and_a_second_run_changes_nothing() {
    let d = old_layout();
    let first = reindex(d.path()).unwrap();
    assert_eq!(
        first,
        Outcome {
            indexed: 2,
            moved: 3,
            index_written: true,
            harness_written: true,
            skipped: Vec::new()
        }
    );
    let harness = fs::read_to_string(d.path().join("MEMORY.md")).unwrap();
    assert_eq!(
        harness,
        format!(
            "{USER_LINES}- [question: not craft's](question-2222222222.md) — src\n\nA closing paragraph of the user's.\n{POINTER}\n"
        )
    );
    let craft = fs::read_to_string(d.path().join("craft-memory.md")).unwrap();
    assert!(
        craft.contains(
            "\n## src/parse.rs\n\n- [decision: unwrap is fine #12](decision-0123456789.md)\n"
        ),
        "{craft}"
    );
    assert!(
        craft.ends_with("\n## .\n\n- [rule: no rollback](rule-abcdef0123.md)\n"),
        "the whole-repo scope last: {craft}"
    );
    assert!(
        !craft.contains("old lesson"),
        "a superseded record leaves the index"
    );
    let second = reindex(d.path()).unwrap();
    assert_eq!(
        second,
        Outcome {
            indexed: 2,
            moved: 0,
            index_written: false,
            harness_written: false,
            skipped: Vec::new()
        }
    );
    assert_eq!(
        fs::read_to_string(d.path().join("MEMORY.md")).unwrap(),
        harness
    );
    assert_eq!(
        fs::read_to_string(d.path().join("craft-memory.md")).unwrap(),
        craft
    );
}

#[test]
fn a_directory_without_memory_md_gets_the_pointer_and_a_missing_directory_is_refused() {
    let d = tempfile::tempdir().unwrap();
    record(d.path(), "decision-0123456789", "t", "src", "active");
    reindex(d.path()).unwrap();
    assert_eq!(
        fs::read_to_string(d.path().join("MEMORY.md")).unwrap(),
        format!("{POINTER}\n")
    );
    let err = reindex(&d.path().join("absent")).unwrap_err().to_string();
    assert!(err.contains("not found"), "{err}");
}

#[test]
fn a_long_title_is_shortened_on_its_index_line_only() {
    let long = "x".repeat(300);
    let e = index::entry(
        "decision-0123456789.md",
        &format!("---\ndescription: \"decision: {long}\"\ncraft_kind: decision\n---\n"),
    )
    .unwrap();
    assert_eq!(e.title, long);
    let rendered = index::render(&[e]);
    let line = rendered.lines().find(|l| l.starts_with("- [")).unwrap();
    assert_eq!(line.chars().count(), 150);
    assert!(line.contains("…](decision-0123456789.md)"), "{line}");
}

#[test]
fn only_a_record_files_name_is_crafts() {
    assert!(index::is_record_name("question-0123456789.md"));
    for name in [
        "note.md",
        "decision-0123.md",
        "decision-0123456789.txt",
        "Decision-0123456789.md",
        "decision-012345678G.md",
    ] {
        assert!(!index::is_record_name(name), "{name}");
    }
}

#[test]
fn a_directory_with_no_craft_record_is_left_untouched() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("MEMORY.md"), USER_LINES).unwrap();
    fs::write(d.path().join("note.md"), "mine").unwrap();
    let o = reindex(d.path()).unwrap();
    assert_eq!((o.index_written, o.harness_written), (false, false));
    assert_eq!(
        fs::read_to_string(d.path().join("MEMORY.md")).unwrap(),
        USER_LINES
    );
    assert!(
        !d.path().join("craft-memory.md").exists(),
        "no index, no pointer"
    );
}

#[test]
fn a_memory_md_saying_do_not_write_here_refuses_and_writes_nothing() {
    let d = old_layout();
    let path = d.path().join("MEMORY.md");
    let before = format!(
        "Do not write here: state lives in the repo.\n{}",
        fs::read_to_string(&path).unwrap()
    );
    fs::write(&path, &before).unwrap();
    let err = reindex(d.path()).unwrap_err().to_string();
    assert!(err.contains("says not to write here"), "{err}");
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
    assert!(!d.path().join("craft-memory.md").exists());
}

#[test]
fn a_crlf_memory_md_keeps_its_line_endings() {
    let d = tempfile::tempdir().unwrap();
    record(d.path(), "decision-0123456789", "t", "src", "active");
    let before =
        "# Memory\r\n- [my note](note.md)\r\n- [decision: t](decision-0123456789.md) — src\r\n";
    fs::write(d.path().join("MEMORY.md"), before).unwrap();
    reindex(d.path()).unwrap();
    assert_eq!(
        fs::read_to_string(d.path().join("MEMORY.md")).unwrap(),
        format!("# Memory\r\n- [my note](note.md)\r\n{POINTER}\r\n")
    );
}

#[test]
fn a_record_file_that_is_not_utf8_is_skipped_and_named() {
    let d = tempfile::tempdir().unwrap();
    record(d.path(), "decision-0123456789", "t", "src", "active");
    fs::write(d.path().join("lesson-abcdefabcd.md"), [0xff, 0xfe, 0x00]).unwrap();
    let o = reindex(d.path()).unwrap();
    assert_eq!(o.indexed, 1);
    assert_eq!(o.skipped, ["lesson-abcdefabcd.md: not UTF-8 text"]);
}

#[test]
fn the_no_write_marker_is_a_line_of_its_own_never_part_of_a_sentence_or_a_craft_line() {
    for marked in [
        "Do not write here: state lives in the repo.",
        "- do NOT write here",
        "## Do not write here",
    ] {
        assert!(
            index::forbids_writes(&format!("# Memory\n{marked}\n")),
            "{marked}"
        );
    }
    for plain in [
        "- [note](note.md) — we said do not write here once",
        "- [decision: do not write here without a lock](decision-0123456789.md) — src",
    ] {
        assert!(!index::forbids_writes(plain), "{plain}");
    }
}

#[test]
fn a_memory_md_that_is_not_utf8_is_refused_by_name() {
    let d = tempfile::tempdir().unwrap();
    record(d.path(), "decision-0123456789", "t", "src", "active");
    fs::write(d.path().join("MEMORY.md"), [0xff, 0xfe, b'\n']).unwrap();
    let err = reindex(d.path()).unwrap_err().to_string();
    assert!(err.contains("MEMORY.md is not UTF-8 text"), "{err}");
    assert!(
        !d.path().join("craft-memory.md").exists(),
        "nothing written"
    );
}
