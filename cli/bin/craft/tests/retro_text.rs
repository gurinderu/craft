//! What `craft runs retro`, `hooks` and `round-pairs` print as tables over the parity store
//! (`content/parity/retro-cases.json`), held to the texts in `tests/retro_text/`; with
//! `CRAFT_UPDATE_TEXT=1` the test writes them instead, after a change of the tables' form.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn laid() -> tempfile::TempDir {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(root.join("../../../content/parity/retro-cases.json")).unwrap();
    let cases: Value = serde_json::from_str(&text).unwrap();
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("runs")).unwrap();
    for (name, r) in cases.get("store").and_then(Value::as_object).unwrap() {
        std::fs::write(
            d.path().join("runs").join(name),
            serde_json::to_string(r).unwrap(),
        )
        .unwrap();
    }
    std::fs::write(
        d.path().join("hooks.jsonl"),
        cases.get("hooks").and_then(Value::as_str).unwrap(),
    )
    .unwrap();
    d
}

fn printed(d: &Path, args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .arg("runs")
        .args(args)
        .arg("--store")
        .arg(d.join("runs"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn held(name: &str, text: &str) {
    let file: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/retro_text")
        .join(name);
    if std::env::var_os("CRAFT_UPDATE_TEXT").is_some() {
        std::fs::write(&file, text).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&file).unwrap();
    assert!(
        want == text,
        "{name} differs:\n--- want\n{want}\n--- printed\n{text}"
    );
}

#[test]
fn the_retro_prints_its_tables() {
    let d = laid();
    held("retro.txt", &printed(d.path(), &["retro"]));
    held(
        "retro-engine.txt",
        &printed(
            d.path(),
            &["retro", "0.9.0", "--engine", "claude-code 0.9.0 r4"],
        ),
    );
}

#[test]
fn the_hooks_and_the_round_pairs_print_their_lines() {
    let d = laid();
    let log = d.path().join("hooks.jsonl");
    held(
        "hooks.txt",
        &printed(d.path(), &["hooks", "--log", log.to_str().unwrap()]),
    );
    held("round-pairs.txt", &printed(d.path(), &["round-pairs"]));
}

#[test]
fn an_empty_store_says_what_it_does_not_hold() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("runs")).unwrap();
    held("empty-retro.txt", &printed(d.path(), &["retro"]));
    held("empty-pairs.txt", &printed(d.path(), &["round-pairs"]));
    let log = d.path().join("none.jsonl");
    held(
        "empty-hooks.txt",
        &printed(d.path(), &["hooks", "--log", log.to_str().unwrap()])
            .replace(log.to_str().unwrap(), "<log>"),
    );
}
