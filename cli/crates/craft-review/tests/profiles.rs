//! The profiles of one run: each changed file to one profile (Rust, Nix, or the general lenses for
//! any other source), a scout and a plan per profile over its own files, the lens rounds shared,
//! and one dedup, one verification and one verdict over every profile's findings.

mod common;

use std::path::Path;

use common::{git, ids, lens, opts, prompt_of, scout, submit, titled, verdict};
use craft_review::step;
use serde_json::{Value, json};

/// A repository whose `origin/main` is its first commit, with `files` added after it.
#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn repo_with(files: &[&str]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("README.md"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    for f in files {
        let path = d.join(f);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x = 1\n").unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: add f, which never fails"]);
    dir
}

/// The task of `step` with `id`.
#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn task<'a>(step: &'a Value, id: &str) -> &'a Value {
    step["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(id))
        .unwrap()
}

/// Starts a run over `repo` into `out`; its run directory and first step.
#[expect(
    clippy::unwrap_used,
    reason = "a step of the tests, failing loudly like them"
)]
fn start(repo: &Path, out: &Path) -> (std::path::PathBuf, Value) {
    let s = step::start(&opts(repo, out)).unwrap();
    (out.join("run"), s)
}

#[test]
fn a_typescript_only_diff_is_reviewed_by_the_general_lenses() {
    let repo = repo_with(&["web/app.ts"]);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = start(repo.path(), out.path());
    assert_eq!(ids(&s), ["scout-general"], "planned, not INCOMPLETE: {s}");
    let p = prompt_of(task(&s, "scout-general"));
    for want in [
        "You are scouting a source diff",
        "-- ':(literal)web/app.ts'",
        "payments/amounts/ledger → money",
    ] {
        assert!(p.contains(want), "{want}: {p}");
    }

    let s = submit(
        &run,
        json!({"scout-general": scout("small", &["security"])}),
    );
    assert_eq!(
        ids(&s),
        ["lens-general-security-r1", "lens-general-correctness-r1"]
    );
    assert!(
        task(&s, "lens-general-security-r1")
            .get("agentType")
            .is_none(),
        "the general lenses run on the host's default agent"
    );
    let p = prompt_of(task(&s, "lens-general-security-r1"));
    for want in [
        "You are the **security** review lens for a source diff",
        "Load the review-rules skill for the rubric.",
        "SLICE: security: injection, authz/authn gaps",
        "-- ':(literal)web/app.ts'",
    ] {
        assert!(p.contains(want), "{want}: {p}");
    }

    let mut f = titled("High", 1, "token logged");
    f["file"] = json!("web/app.ts");
    let s = submit(
        &run,
        json!({"lens-general-security-r1": lens("security", &[f]), "lens-general-correctness-r1": lens("correctness", &[])}),
    );
    assert_eq!(ids(&s), ["verify-0-v0", "verify-0-v1"]);
    let v = prompt_of(task(&s, "verify-0-v0"));
    assert!(
        v.contains("SHARED EXCLUSION CATALOG") && !v.contains("skill's fp-rules.md"),
        "no profile catalogue for a profile that ships none: {v}"
    );
    let s = submit(
        &run,
        json!({"verify-0-v0": verdict(false), "verify-0-v1": verdict(false)}),
    );
    assert_eq!(s["verdict"], json!("Block"));
    assert_eq!(s["uncovered"], json!([]));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("1 changed file(s), 1 source.") && report.contains("`web/app.ts:1`"),
        "{report}"
    );
}

#[test]
fn a_nix_only_diff_runs_the_nix_lenses_on_the_nix_reviewer() {
    let repo = repo_with(&["flake.nix"]);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = start(repo.path(), out.path());
    assert_eq!(ids(&s), ["scout-nix"]);
    let s = submit(&run, json!({"scout-nix": scout("small", &["purity"])}));
    assert_eq!(ids(&s), ["lens-nix-purity-r1", "lens-nix-intent-r1"]);
    for id in ids(&s) {
        assert_eq!(task(&s, &id)["agentType"], json!("nix-reviewer"), "{id}");
    }
    let p = prompt_of(task(&s, "lens-nix-purity-r1"));
    for want in [
        "for a Nix diff",
        "Load the nix-review skill for the rubric.",
        "-- '*.nix' 'flake.lock'",
    ] {
        assert!(p.contains(want), "{want}: {p}");
    }
    let s = submit(
        &run,
        json!({"lens-nix-purity-r1": lens("purity", &[]), "lens-nix-intent-r1": lens("intent", &[])}),
    );
    assert_eq!(s["verdict"], json!("Approve"));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("Plan: small diff, full review, at most 1 round(s). Lenses planned: purity, intent; ran: purity, intent."),
        "{report}"
    );
}

/// Every task of `step` answered: each lens with what `found` gives it, nothing for the rest.
fn round(step: &Value, found: &dyn Fn(&str) -> Vec<Value>) -> Value {
    let pairs: serde_json::Map<String, Value> = ids(step)
        .into_iter()
        .map(|id| {
            let a = lens(&id, &found(&id));
            (id, a)
        })
        .collect();
    Value::Object(pairs)
}

#[test]
fn a_mixed_diff_plans_each_profile_over_its_own_files_and_settles_one_pool() {
    let repo = repo_with(&["src/lib.rs", "flake.nix", "web/app.ts", "Makefile"]);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = start(repo.path(), out.path());
    assert_eq!(ids(&s), ["scout-rust", "scout-nix", "scout-general"]);
    let general = prompt_of(task(&s, "scout-general"));
    assert!(
        general.contains("-- ':(literal)web/app.ts'") && !general.contains("lib.rs"),
        "the general scout reads only its own files: {general}"
    );

    // Rust plans two rounds, Nix and general one: round 2 is Rust's alone.
    let s = submit(
        &run,
        json!({"scout-rust": scout("medium", &["errors"]), "scout-nix": scout("small", &["purity"]),
               "scout-general": scout("small", &["security"])}),
    );
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r1",
            "lens-rust-intent-r1",
            "lens-rust-tests-r1",
            "lens-nix-purity-r1",
            "lens-nix-intent-r1",
            "lens-general-security-r1",
            "lens-general-correctness-r1"
        ]
    );
    let found = |id: &str| -> Vec<Value> {
        match id {
            "lens-rust-errors-r1" => vec![titled("High", 1, "f returns 1")],
            "lens-general-security-r1" => {
                let mut f = titled("Medium", 1, "token logged");
                f["file"] = json!("web/app.ts");
                vec![f]
            }
            _ => Vec::new(),
        }
    };
    let s = submit(&run, round(&s, &found));
    assert_eq!(
        ids(&s),
        [
            "lens-rust-errors-r2",
            "lens-rust-intent-r2",
            "lens-rust-tests-r2"
        ],
        "only the profile with rounds left and new findings runs again"
    );
    let s = submit(&run, round(&s, &|_| Vec::new()));
    assert_eq!(
        ids(&s),
        ["dedup-rust-nix-general"],
        "one dedup over every profile's findings"
    );

    let s = submit(&run, json!({"dedup-rust-nix-general": {"groups": []}}));
    assert_eq!(ids(&s), ["verify-0-v0", "verify-0-v1", "verify-batch-0"]);
    let rust = prompt_of(task(&s, "verify-0-v0"));
    assert!(rust.contains("rust-review skill's fp-rules.md"), "{rust}");
    let batch = prompt_of(task(&s, "verify-batch-0"));
    assert!(
        batch.contains("INDEPENDENT source review findings"),
        "{batch}"
    );

    let s = submit(
        &run,
        json!({"verify-0-v0": verdict(false), "verify-0-v1": verdict(false),
               "verify-batch-0": {"verdicts": [{"index": 0, "refuted": false, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "seen"}]}}),
    );
    assert_eq!(
        s["verdict"],
        json!("Block"),
        "one verdict over every profile"
    );
    assert_eq!(s["uncovered"], json!(["Makefile"]));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    for want in [
        "4 changed file(s), 1 Rust, 1 Nix, 1 source.",
        "Plan (rust): medium diff",
        "Plan (nix): small diff",
        "Plan (general): small diff",
        "`src/lib.rs:1`",
        "`web/app.ts:1`",
    ] {
        assert!(report.contains(want), "{want}: {report}");
    }
}
