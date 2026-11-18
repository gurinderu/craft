//! A changed path that is not UTF-8 is left out of the review whole and named as not reviewed,
//! under git's default quoting and under `core.quotePath=false`; the rest of the change is
//! reviewed as it would be without it — its gate seeds and its consumers list included.
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use common::{assert_contains_all, git, ids, lens, opts, prompt_of, scout, submit};
use craft_review::gate::GateSetup;
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// The one consumer line of the change.
const SITE: &str = "src/user.rs:2";
const SEED: &str = "src/lib.rs:2 a warning of the gate";
const NOT_REVIEWED: &str = r#"Not reviewed — path not UTF-8: "src/caf\351.rs""#;

/// A Cargo package whose change returns 2 from `shared_target`, which `src/user.rs:2` calls, and
/// adds `src/caf\xe9.rs`; git's `core.quotePath` set to `quote_path`.
fn repo(d: &Path, quote_path: &str) {
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "core.quotePath", quote_path]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    let package = "[package]\nname = \"f\"\nversion = \"0.1.0\"\n";
    std::fs::write(d.join("Cargo.toml"), package).unwrap();
    let lib = "pub fn shared_target() -> u8 {\n    1\n}\n";
    std::fs::write(d.join("src/lib.rs"), lib).unwrap();
    let user = "pub fn user() -> u8 {\n    crate::shared_target()\n}\n";
    std::fs::write(d.join("src/user.rs"), user).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(d.join("src/lib.rs"), lib.replace('1', "2")).unwrap();
    let odd = d.join(std::ffi::OsStr::from_bytes(b"src/caf\xe9.rs"));
    std::fs::write(odd, "pub fn odd() -> u8 {\n    3\n}\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "fix: return 2"]);
}

/// A directory holding a `cargo` that prints, as clippy's JSON, one warning on `src/lib.rs:2`.
fn fake_cargo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let warning = json!({"reason": "compiler-message", "message": {"level": "warning",
        "code": {"code": "clippy::own"}, "message": "a warning of the gate",
        "spans": [{"file_name": "src/lib.rs", "line_start": 2, "is_primary": true}]}});
    let script = format!(
        "#!/bin/sh\ncase \"$*\" in *pedantic*) : ;; *) printf '%s\\n' '{warning}' ;; esac\n"
    );
    common::exe::write_executable(&dir.path().join("cargo"), &script).unwrap();
    dir
}

/// Every task's answer: a small plan, each lens marking the consumer line and finding nothing.
fn answer(id: &str) -> Value {
    if id.starts_with("scout-") {
        scout("small", &["errors"])
    } else if let Some(rest) = id.strip_prefix("lens-rust-") {
        let mut a = lens(rest.split('-').next().unwrap(), &[]);
        a["consumers"] = json!([{"site": SITE, "status": "checked"}]);
        a
    } else if id.starts_with("dedup-") {
        json!({"groups": []})
    } else {
        common::verdict(false)
    }
}

fn reviews_the_rest(quote_path: &str) {
    let checkout = tempfile::tempdir().unwrap();
    repo(checkout.path(), quote_path);
    let out = tempfile::tempdir().unwrap();
    let tools = fake_cargo();
    let run = out.path().join("run");
    let options = StartOptions {
        gate: Some(GateSetup {
            path: Some(tools.path().as_os_str().to_owned()),
            ..GateSetup::default()
        }),
        ..opts(checkout.path(), out.path())
    };
    let s = step::start(&options).unwrap();
    assert_eq!(ids(&s), ["scout-rust"], "quotePath={quote_path}: {s}");
    let mut s = submit(&run, json!({"scout-rust": answer("scout-rust")}));
    let errors = s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!("lens-rust-errors-r1"))
        .unwrap_or_else(|| panic!("{:?}", ids(&s)));
    let p = prompt_of(errors);
    assert_contains_all(&p, &[SEED, "- src/user.rs:2: crate::shared_target()"]);
    assert!(!p.contains("caf"), "the lens is not shown the path: {p}");
    while s["done"] == json!(false) {
        let answers = ids(&s).into_iter().map(|id| {
            let a = answer(&id);
            (id, a)
        });
        s = submit(&run, Value::Object(answers.collect()));
    }
    assert!(
        s["verdict"]
            .as_str()
            .unwrap()
            .ends_with("(PARTIAL COVERAGE)"),
        "quotePath={quote_path}: {s}"
    );
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert_contains_all(&report, &[NOT_REVIEWED, "a warning of the gate"]);
    assert!(!report.contains("no lens marked"), "{report}");
}

#[test]
fn a_path_that_is_not_utf8_is_named_not_reviewed_and_the_rest_is_reviewed() {
    reviews_the_rest("true");
}

#[test]
fn so_too_when_git_prints_paths_unquoted() {
    reviews_the_rest("false");
}
