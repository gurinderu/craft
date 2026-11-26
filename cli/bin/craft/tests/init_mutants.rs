//! `craft init`'s `[mutants]` section (realm @nick/craft, nodes #645, #647): `--propose` shows what
//! the profile holds as the flags a write takes back, `--write --mutants` and `--mutants-budget`
//! record what the reviewer confirmed, replaced on each write; a flag of one mode beside the other is
//! refused, never ignored. HOME is a temporary directory.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

fn repo(t: &Path) -> String {
    let repo = t.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let ok = Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .arg(&repo)
        .output()
        .unwrap();
    assert!(ok.status.success());
    repo.display().to_string()
}

fn craft(t: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env("CRAFT_CODE_GRAPH", "")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

fn json_of(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn held(t: &Path, repo: &str) -> Value {
    json_of(&craft(t, &["init", "--propose", "--cwd", repo]))
        .get("mutants")
        .cloned()
        .unwrap()
}

fn write(t: &Path, repo: &str, more: &[&str]) -> Output {
    let mut args = vec!["init", "--write", "--cwd", repo];
    args.extend(more);
    craft(t, &args)
}

#[test]
fn propose_shows_the_defaults_and_a_write_records_off_or_a_budget_as_named() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let none = held(t, &repo);
    assert_eq!(
        (&none["off"], &none["budgetSecs"], &none["flags"]),
        (&json!(false), &Value::Null, &json!([]))
    );
    assert_eq!(none["defaultBudgetSecs"], 600);

    let wrote = json_of(&write(t, &repo, &["--mutants", "off"]));
    assert_eq!(
        (&wrote["mutants"]["off"], &wrote["mutants"]["flags"]),
        (&json!(true), &json!(["--mutants", "off"])),
        "the write reports what it wrote as propose does"
    );
    assert_eq!(held(t, &repo)["flags"], json!(["--mutants", "off"]));

    json_of(&write(t, &repo, &["--mutants-budget", "900"]));
    let budget = held(t, &repo);
    assert_eq!(
        (&budget["off"], &budget["budgetSecs"]),
        (&json!(false), &json!(900)),
        "the write replaced the held off"
    );
    assert_eq!(budget["flags"], json!(["--mutants-budget", "900"]));

    json_of(&write(t, &repo, &[]));
    assert_eq!(
        held(t, &repo)["flags"],
        json!([]),
        "a write naming none leaves the defaults"
    );
}

#[test]
fn a_budget_beside_off_or_of_no_seconds_is_refused_and_nothing_is_written() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    json_of(&write(t, &repo, &["--mutants-budget", "900"]));
    let both = write(t, &repo, &["--mutants", "off", "--mutants-budget", "60"]);
    assert_ne!(both.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&both.stderr).contains("turned off"),
        "{both:?}"
    );
    assert_ne!(
        write(t, &repo, &["--mutants-budget", "0"]).status.code(),
        Some(0)
    );
    assert_ne!(
        write(t, &repo, &["--mutants", "maybe"]).status.code(),
        Some(0)
    );
    assert_eq!(
        held(t, &repo)["budgetSecs"],
        900,
        "a refused write leaves the profile as it was"
    );
    assert_eq!(write(t, &repo, &["--mutants", "on"]).status.code(), Some(0));
    assert_eq!(held(t, &repo)["flags"], json!([]));
    json_of(&write(
        t,
        &repo,
        &["--mutants", "on", "--mutants-budget", "60"],
    ));
    assert_eq!(held(t, &repo)["flags"], json!(["--mutants-budget", "60"]));
    let huge = write(t, &repo, &["--mutants-budget", "9223372036854775808"]);
    assert_eq!(
        huge.status.code(),
        Some(2),
        "past what the profile can hold, refused as an argument: {huge:?}"
    );
}

#[test]
fn a_hand_written_section_a_write_would_refuse_prints_the_flags_a_review_reads_it_by() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let profile = json_of(&write(t, &repo, &[]))["profile"]
        .as_str()
        .unwrap()
        .to_owned();
    let text = std::fs::read_to_string(&profile).unwrap();
    for (section, flags) in [
        ("off = true\nbudget_secs = 60", json!(["--mutants", "off"])),
        ("budget_secs = 0", json!([])),
    ] {
        std::fs::write(
            &profile,
            text.replace("[mutants]", &format!("[mutants]\n{section}")),
        )
        .unwrap();
        let printed = held(t, &repo)["flags"].clone();
        assert_eq!(printed, flags, "{section}");
        let mut args: Vec<&str> = Vec::new();
        args.extend(
            printed
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f.as_str().unwrap()),
        );
        assert_eq!(write(t, &repo, &args).status.code(), Some(0), "{section}");
    }
}

#[test]
fn a_write_flag_beside_propose_or_a_propose_flag_beside_write_is_refused_not_ignored() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let writes = [
        ["--mutants", "off"],
        ["--mutants-budget", "60"],
        ["--lens", "rust:money=off"],
        ["--point", "sys=https://example.com/s.git@v1"],
        ["--ci", "{}"],
    ];
    for flag in writes {
        let mut args = vec!["init", "--propose", "--cwd", &repo];
        args.extend(flag);
        assert_eq!(craft(t, &args).status.code(), Some(2), "{flag:?}");
    }
    for flag in [["--path", "chart/values.yaml"], ["--memory-externals", "-"]] {
        let mut args = vec!["init", "--write", "--cwd", &repo];
        args.extend(flag);
        assert_eq!(craft(t, &args).status.code(), Some(2), "{flag:?}");
    }
}

#[test]
fn a_section_that_cannot_be_read_is_named_and_its_defaults_shown() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let profile = json_of(&write(t, &repo, &[]))["profile"]
        .as_str()
        .unwrap()
        .to_owned();
    let text = std::fs::read_to_string(&profile).unwrap();
    std::fs::write(
        &profile,
        text.replace("[mutants]", "[mutants]\nskip = true"),
    )
    .unwrap();
    let m = held(t, &repo);
    assert!(m["unread"].as_str().unwrap().contains("[mutants]"), "{m}");
    assert_eq!(m["flags"], json!([]));
}
