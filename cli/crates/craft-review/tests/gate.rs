//! The mechanical gate end to end over a fixture repository, its tools stand-ins on a PATH of
//! their own: a tool's seed reaches the lenses, the verdict's report and the ledger with its own
//! rule; a red check blocks before any lens; a tool not installed is named and the review goes on.

#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::{Path, PathBuf};

use common::{fixture, git, ids, lens, opts, prompt_of, scout, submit};
use craft_review::gate::GateSetup;
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

/// A warning clippy prints, in its JSON form, at `src/lib.rs:<line>`.
fn warning(code: &str, message: &str, line: u32) -> String {
    json!({"reason": "compiler-message", "message": {"level": "warning", "code": {"code": code}, "message": message,
        "spans": [{"file_name": "src/lib.rs", "line_start": line, "is_primary": true}]}})
    .to_string()
}

/// A compile error rustc prints, in its JSON form, at `src/lib.rs:1`.
fn error(message: &str) -> String {
    json!({"reason": "compiler-message", "message": {"level": "error", "code": {"code": "E0308"}, "message": message,
        "spans": [{"file_name": "src/lib.rs", "line_start": 1, "is_primary": true}]}})
    .to_string()
}

/// A directory holding a `cargo` that prints `gate` on the gate's run and `pedantic` on the
/// pedantic pass, as clippy's JSON lines.
fn fake_cargo(gate: &[String], pedantic: &[String]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let lines = |ls: &[String]| {
        ls.iter()
            .map(|l| format!("printf '%s\\n' '{l}'"))
            .collect::<Vec<_>>()
            .join("; ")
    };
    let script = format!(
        "#!/bin/sh\ncase \"$*\" in *pedantic*) {} ;; *) {} ;; esac\n",
        if pedantic.is_empty() {
            ":".into()
        } else {
            lines(pedantic)
        },
        if gate.is_empty() {
            ":".into()
        } else {
            lines(gate)
        },
    );
    write_tool(dir.path(), "cargo", &script);
    dir
}

fn write_tool(dir: &Path, name: &str, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// The fixture repository with a Cargo package at its top, so clippy has a package to lint.
fn package() -> tempfile::TempDir {
    let repo = fixture(true);
    std::fs::write(
        repo.path().join("Cargo.toml"),
        "[package]\nname = \"f\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-qm", "chore: the package"]);
    repo
}

fn gated(repo: &Path, out: &Path, path: &Path) -> StartOptions {
    StartOptions {
        gate: Some(GateSetup {
            path: Some(path.as_os_str().to_owned()),
            ..GateSetup::default()
        }),
        ..opts(repo, out)
    }
}

/// Answers every task until the run is done: a small plan, no lens finding.
fn drive(run: &Path, mut s: Value) -> Value {
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else if id.starts_with("dedup-") {
                json!({"groups": []})
            } else {
                let name = id.strip_prefix("lens-rust-").unwrap();
                lens(name.split('-').next().unwrap(), &[])
            };
            answers.insert(id, a);
        }
        s = submit(run, Value::Object(answers));
    }
    s
}

fn report(done: &Value) -> String {
    std::fs::read_to_string(done["report"].as_str().unwrap()).unwrap()
}

#[test]
fn a_gate_seed_reaches_the_lenses_the_report_and_the_ledger_with_its_tool_rule() {
    let repo = package();
    let out = tempfile::tempdir().unwrap();
    let tools = fake_cargo(
        &[
            warning("clippy::needless_return", "unneeded `return` statement", 1),
            warning("clippy::other_place", "left alone", 7),
        ],
        &[warning(
            "clippy::must_use_candidate",
            "this function could have a `#[must_use]` attribute",
            1,
        )],
    );
    let run: PathBuf = out.path().join("run");
    let s = step::start(&gated(repo.path(), out.path(), tools.path())).unwrap();
    assert_eq!(ids(&s), ["scout-rust"]);
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    let p = prompt_of(&s["tasks"][0]);
    assert!(
        p.contains("src/lib.rs:1 unneeded `return` statement")
            && p.contains("src/lib.rs:1 this function could have a `#[must_use]` attribute"),
        "the lens is told what the gate found: {p}"
    );
    assert!(
        !p.contains("left alone"),
        "a line the change left alone seeds nothing"
    );
    let done = drive(&run, s);
    let ledger = done["ledger"].as_array().unwrap();
    let rule = |r: &str| ledger.iter().find(|row| row["toolRule"] == json!(r));
    let seed = rule("clippy::needless_return").unwrap();
    assert_eq!(
        (&seed["source"], &seed["line"], &seed["disposition"]),
        (&json!("clippy"), &json!(1), &json!("open"))
    );
    assert_eq!(
        rule("clippy::must_use_candidate").unwrap()["source"],
        json!("clippy-pedantic")
    );
    let r = report(&done);
    common::assert_contains_all(
        &r,
        &[
            "## Gate\n\n- **rust**: pass — `cargo clippy --manifest-path Cargo.toml --all-targets`: pass",
            "2 tool finding(s) seeded for the lenses and the verifiers",
            "unneeded `return` statement (clippy)",
        ],
    );
    assert!(
        !r.contains("the gate and its tool seeds"),
        "the gate ran: {r}"
    );
}

#[test]
fn a_red_check_blocks_before_any_lens() {
    let repo = package();
    let out = tempfile::tempdir().unwrap();
    let tools = fake_cargo(&[error("mismatched types")], &[]);
    let done = step::start(&gated(repo.path(), out.path(), tools.path())).unwrap();
    assert_eq!(done["done"], json!(true), "no scout, no lens: {done}");
    assert_eq!(done["verdict"], json!("Block"));
    common::assert_contains_all(
        &report(&done),
        &[
            "⛔ Block — mechanical gate is red (rust).",
            "  - Failed: clippy (Cargo.toml): mismatched types at src/lib.rs:1",
        ],
    );
}

#[test]
fn a_tool_not_installed_is_named_and_the_review_goes_on() {
    let repo = package();
    let out = tempfile::tempdir().unwrap();
    let empty = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(repo.path().join(".semgrep")).unwrap();
    let run = out.path().join("run");
    let s = step::start(&gated(repo.path(), out.path(), empty.path())).unwrap();
    assert_eq!(ids(&s), ["scout-rust"], "the review goes on");
    let done = drive(&run, s);
    assert_eq!(
        done["verdict"],
        json!("Approve"),
        "an absent tool is no failure"
    );
    common::assert_contains_all(
        &report(&done),
        &[
            "- **rust**: unknown — `cargo clippy --manifest-path Cargo.toml --all-targets`: not installed",
            "  - Not installed, skipped (the review went on without them): cargo, semgrep",
        ],
    );
}

#[test]
fn a_red_gate_on_a_re_review_still_adjudicates_the_priors_and_plans_no_lens() {
    let repo = package();
    let out = tempfile::tempdir().unwrap();
    let quiet = fake_cargo(&[], &[]);
    let r1 = out.path().join("run");
    step::start(&gated(repo.path(), out.path(), quiet.path())).unwrap();
    let s = submit(&r1, json!({"scout-rust": scout("small", &["errors"])}));
    let mut answers = serde_json::Map::new();
    for id in ids(&s) {
        let name = id.strip_prefix("lens-rust-").unwrap();
        let name = name.split('-').next().unwrap();
        let found = if name == "errors" {
            vec![common::titled("High", 1, "f returns 1")]
        } else {
            Vec::new()
        };
        answers.insert(id.clone(), lens(name, &found));
    }
    let s = submit(&r1, Value::Object(answers));
    let votes: serde_json::Map<String, Value> = ids(&s)
        .into_iter()
        .map(|id| (id, common::verdict(false)))
        .collect();
    let done = submit(&r1, Value::Object(votes));
    assert_eq!(done["verdict"], json!("Block"));

    std::fs::write(repo.path().join("src/lib.rs"), "pub fn f() -> u8 { 0 }\n").unwrap();
    git(repo.path(), &["commit", "-qam", "fix: f returns 0"]);
    let red = fake_cargo(&[error("mismatched types")], &[]);
    let r2 = out.path().join("r2");
    let s = step::start(&StartOptions {
        run_dir: r2.clone(),
        ..gated(repo.path(), out.path(), red.path())
    })
    .unwrap();
    assert_eq!(ids(&s), ["adjudicate-0"], "no scout, no lens, no seed");
    let done = submit(
        &r2,
        json!({"adjudicate-0": {"status": "still-open", "currentLine": 1, "note": "", "invariant": "f never returns 1", "attack": "it still does"}}),
    );
    assert_eq!(done["done"], json!(true), "{done}");
    assert_eq!(done["verdict"], json!("Block"));
    let r = report(&done);
    assert!(r.contains("mechanical gate is red (rust)"), "{r}");
    assert!(!r.contains("scout classification"), "{r}");
}
