//! The mutants' launch, worker and join over a real repository, cargo-mutants a stand-in script
//! that writes the `outcomes.json` 27.1.0 writes (realm @nick/craft, node #624).

use std::path::Path;
use std::time::Duration;

use super::super::tests::{exe, git};
use super::super::{Gate, Status, Track};
use super::worker::{self, Came};
use super::{Launch, Mutants, MutantsSetup, join, launch};

/// A workspace whose second commit changes `big` on line 2 of `src/lib.rs`.
fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(
        d.join("Cargo.toml"),
        "[package]\nname = \"p\"\n\n[workspace]\n",
    )
    .unwrap();
    std::fs::create_dir(d.join("src")).unwrap();
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn add(a: i32) -> i32 { a + 1 }\npub fn big(x: i32) -> bool { x > 10 }\n",
    )
    .unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn add(a: i32) -> i32 { a + 1 }\npub fn big(x: i32) -> bool { x >= 10 }\n",
    )
    .unwrap();
    git(d, &["commit", "-qam", "feat: big"]);
    dir
}

fn passed(dev_shell: bool) -> Gate {
    Gate {
        tracks: vec![Track {
            profile: "rust".into(),
            status: Status::Pass,
            dev_shell,
            ..Track::default()
        }],
        ..Gate::default()
    }
}

/// A stand-in cargo: `mutants … -o <out> …` writes `outcomes` under `<out>/mutants.out/` after
/// `sleep` seconds and exits `code`.
fn cargo(bin: &Path, outcomes: &str, sleep: u32, code: i32) -> String {
    let path = bin.join("cargo");
    std::fs::write(bin.join("outcomes.json"), outcomes).unwrap();
    let script = format!(
        "#!/bin/sh\nwhile [ \"$1\" != -o ]; do shift; done\nmkdir -p \"$2/mutants.out\"\nsleep {sleep}\ncp '{}' \"$2/mutants.out/outcomes.json\"\nexit {code}\n",
        bin.join("outcomes.json").display()
    );
    exe::write_executable(&path, &script).unwrap();
    path.display().to_string()
}

const MISSED_BIG: &str = r#"{"outcomes":[{"scenario":"Baseline","summary":"Success"},{"scenario":{"Mutant":{"name":"src/lib.rs:2:32: replace >= with < in big","file":"src/lib.rs","function":{"function_name":"big","return_type":"-> bool","span":{"start":{"line":2,"column":1},"end":{"line":2,"column":40}}},"span":{"start":{"line":2,"column":32},"end":{"line":2,"column":34}},"replacement":"<","genre":"BinaryOperator"}},"summary":"MissedMutant"},{"scenario":{"Mutant":{"name":"src/lib.rs:1:30: replace + with * in add","file":"src/lib.rs","function":{"function_name":"add","return_type":"-> i32","span":{"start":{"line":1,"column":1},"end":{"line":1,"column":36}}},"span":{"start":{"line":1,"column":30},"end":{"line":1,"column":31}},"replacement":"*","genre":"BinaryOperator"}},"summary":"MissedMutant"}],"total_mutants":2,"end_time":"t"}"#;

fn launched(top: &Path, run: &Path, workspace: &str) -> Mutants {
    let dir = run.join("mutants");
    Mutants {
        dir: dir.display().to_string(),
        top: top.display().to_string(),
        workspace: workspace.into(),
        base: "HEAD~1".into(),
        joined: false,
    }
}

/// Runs the worker over `top` in `run`'s mutants directory with `cargo`, in this process.
fn work(top: &Path, run: &Path, cargo: &str, budget_secs: u64) -> Came {
    let dir = run.join("mutants");
    std::fs::create_dir_all(&dir).unwrap();
    let req = worker::Request {
        top: top.to_owned(),
        workspace: String::new(),
        base: "HEAD~1".into(),
        inside: false,
        budget_secs,
        cargo: cargo.into(),
    };
    std::fs::write(
        dir.join(worker::REQUEST),
        serde_json::to_string(&req).unwrap(),
    )
    .unwrap();
    worker::work(&dir).unwrap();
    // The in-process worker wrote this process's id: no join below may stop it.
    std::fs::remove_file(dir.join(worker::PID)).unwrap();
    serde_json::from_str(&std::fs::read_to_string(dir.join(worker::RESULT)).unwrap()).unwrap()
}

#[test]
fn a_survivor_in_the_changed_function_is_pooled_and_one_in_its_neighbour_is_counted_out() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let cargo = cargo(bin.path(), MISSED_BIG, 0, 2);
    assert_eq!(
        work(top.path(), run.path(), &cargo, 30),
        Came::Exited { code: Some(2) }
    );
    let diff = std::fs::read_to_string(run.path().join("mutants").join(worker::DIFF)).unwrap();
    assert!(
        diff.contains("+pub fn big(x: i32) -> bool { x >= 10 }"),
        "{diff}"
    );
    let (found, line) = join(&mut launched(top.path(), run.path(), ""), Duration::ZERO);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(
        (found[0]["file"].as_str(), found[0]["line"].as_u64()),
        (Some("src/lib.rs"), Some(2))
    );
    let line = line.unwrap();
    assert!(
        line.contains("1 survived of 2 tested")
            && line.contains("1 more survived in neighbouring functions"),
        "{line}"
    );
}

#[test]
fn a_worker_past_its_budget_stops_cargo_mutants_and_says_how_long_it_ran() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let cargo = cargo(bin.path(), MISSED_BIG, 30, 2);
    let start = std::time::Instant::now();
    assert!(matches!(
        work(top.path(), run.path(), &cargo, 1),
        Came::TimedOut { .. }
    ));
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "cargo-mutants was left to run"
    );
    let (found, line) = join(&mut launched(top.path(), run.path(), ""), Duration::ZERO);
    assert!(found.is_empty());
    assert!(
        line.unwrap().contains("budget ran out"),
        "a stopped run is said, not silent"
    );
}

#[test]
fn a_cargo_without_mutants_is_named_as_not_installed() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let path = bin.path().join("cargo");
    exe::write_executable(
        &path,
        "#!/bin/sh\necho 'error: no such command: `mutants`' >&2\nexit 101\n",
    )
    .unwrap();
    assert_eq!(
        work(top.path(), run.path(), &path.display().to_string(), 30),
        Came::Missing
    );
    let (_, line) = join(&mut launched(top.path(), run.path(), ""), Duration::ZERO);
    assert!(line.unwrap().contains("not installed"));
}

#[test]
fn a_run_that_chose_no_mutant_on_changed_rust_points_at_the_paths_not_at_a_clean_run() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let none = r#"{"outcomes":[{"scenario":"Baseline","summary":"Success"}],"total_mutants":0,"end_time":"t"}"#;
    work(top.path(), run.path(), &cargo(bin.path(), none, 0, 0), 30);
    let (_, line) = join(&mut launched(top.path(), run.path(), ""), Duration::ZERO);
    assert!(line.unwrap().contains("check the diff's paths"));
}

#[test]
fn a_worker_still_running_at_the_join_is_stopped_with_its_group() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let exe_path = bin.path().join("worker");
    // A stand-in worker that never writes a result: it names itself and waits.
    exe::write_executable(
        &exe_path,
        "#!/bin/sh\necho $$ > \"$2/worker.pid\"\nexec sleep 60\n",
    )
    .unwrap();
    let setup = MutantsSetup {
        exe: exe_path,
        budget: Duration::from_secs(60),
        off: false,
        cargo: "cargo".into(),
        note: String::new(),
    };
    let gate = passed(false);
    let files = ["src/lib.rs".to_owned()];
    let (mut m, line) = launch(&Launch {
        run_dir: run.path(),
        top: top.path(),
        base: "HEAD~1",
        rust_files: &files,
        other_profiles: false,
        gate: &gate,
        setup: Some(&setup),
    });
    assert!(line.is_empty(), "{line:?}");
    let pid_file = run.path().join("mutants").join(worker::PID);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !pid_file.is_file() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let (_, line) = join(&mut m, Duration::from_millis(100));
    assert!(line.unwrap().contains("stopped at the join"));
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists()
            || std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .unwrap()
                .contains(") Z "),
        "the worker outlived the join"
    );
    assert!(!m.running());
}

type Case<'a> = (
    &'a [String],
    bool,
    &'a Gate,
    Option<&'a MutantsSetup>,
    &'a str,
);

fn why(rust: &[String], other: bool, gate: &Gate, setup: Option<&MutantsSetup>) -> Option<String> {
    let top = repo();
    let run = tempfile::tempdir().unwrap();
    let (m, line) = launch(&Launch {
        run_dir: run.path(),
        top: top.path(),
        base: "HEAD~1",
        rust_files: rust,
        other_profiles: other,
        gate,
        setup,
    });
    assert!(!m.running(), "nothing may be launched when they do not run");
    line.into_iter().next()
}

#[test]
fn each_reason_they_do_not_run_is_said_never_silent() {
    let rust = ["src/lib.rs".to_owned()];
    let setup = MutantsSetup {
        exe: "/nonexistent".into(),
        budget: Duration::from_secs(1),
        off: false,
        cargo: "cargo".into(),
        note: String::new(),
    };
    let off = MutantsSetup {
        off: true,
        ..setup.clone()
    };
    let red = Gate {
        tracks: vec![Track {
            profile: "rust".into(),
            status: Status::Fail,
            ..Track::default()
        }],
        ..Gate::default()
    };
    let cases: [Case<'_>; 5] = [
        (&[], true, &passed(false), Some(&setup), "no Rust"),
        (&rust, false, &passed(false), None, "no gate of its own"),
        (
            &rust,
            false,
            &passed(false),
            Some(&off),
            "off in the reviewer's profile",
        ),
        (&rust, false, &red, Some(&setup), "the Rust gate is red"),
        (
            &rust,
            false,
            &Gate::default(),
            Some(&setup),
            "the Rust gate did not run",
        ),
    ];
    for (files, other, gate, setup, said) in cases {
        let line = why(files, other, gate, setup).unwrap_or_default();
        assert!(
            line.contains("did not run") && line.contains(said),
            "{said}: {line}"
        );
    }
    assert_eq!(
        why(&[], false, &passed(false), Some(&setup)),
        None,
        "a change of nothing says nothing"
    );
}

#[test]
fn the_workspace_is_the_topmost_declared_one_holding_most_changed_files() {
    let top = tempfile::tempdir().unwrap();
    let d = top.path();
    for dir in ["cli/crates/a/src", "cli/crates/b/src", "tool/src"] {
        std::fs::create_dir_all(d.join(dir)).unwrap();
    }
    std::fs::write(
        d.join("cli/Cargo.toml"),
        "[workspace]\nmembers = [\"crates/*\"]\n",
    )
    .unwrap();
    std::fs::write(
        d.join("cli/crates/a/Cargo.toml"),
        "[package]\nname = \"a\"\n",
    )
    .unwrap();
    std::fs::write(
        d.join("cli/crates/b/Cargo.toml"),
        "[package]\nname = \"b\"\n",
    )
    .unwrap();
    std::fs::write(d.join("tool/Cargo.toml"), "[package]\nname = \"tool\"\n").unwrap();
    let files = [
        "cli/crates/a/src/lib.rs",
        "cli/crates/b/src/lib.rs",
        "tool/src/main.rs",
    ]
    .map(String::from);
    assert_eq!(super::workspace(d, &files).as_deref(), Some("cli"));
    let tool = ["tool/src/main.rs".to_owned()];
    assert_eq!(
        super::workspace(d, &tool).as_deref(),
        Some("tool"),
        "a package with no workspace is its own"
    );
    assert_eq!(super::workspace(d, &["loose.rs".to_owned()]), None);
}

#[test]
fn a_launched_run_is_kept_in_the_gate_and_none_is_not_written() {
    let none = serde_json::to_value(Gate::default()).unwrap();
    assert!(none.get("mutants").is_none(), "{none}");
    let gate = Gate {
        mutants: Mutants {
            dir: "/r/mutants".into(),
            ..Mutants::default()
        },
        ..Gate::default()
    };
    let kept: Gate = serde_json::from_value(serde_json::to_value(&gate).unwrap()).unwrap();
    assert!(kept.mutants.running());
}

#[test]
fn a_run_short_is_said_short_and_one_with_no_neighbour_names_none() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let only_big = MISSED_BIG
        .replace(
            ",{\"scenario\":{\"Mutant\":{\"name\":\"src/lib.rs:1:30",
            ",{\"scenario\":{\"Mutant\":{\"name\":\"x",
        )
        .replace("\"line\":1,", "\"line\":2,");
    work(
        top.path(),
        run.path(),
        &cargo(bin.path(), &only_big, 0, 2),
        30,
    );
    let (_, line) = join(&mut launched(top.path(), run.path(), ""), Duration::ZERO);
    let line = line.unwrap();
    assert!(
        !line.contains("neighbouring") && !line.contains("run short"),
        "{line}"
    );
    let unended = MISSED_BIG.replace("\"end_time\":\"t\"", "\"end_time\":null");
    let (run, bin) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    work(
        top.path(),
        run.path(),
        &cargo(bin.path(), &unended, 0, 2),
        30,
    );
    let (_, line) = join(&mut launched(top.path(), run.path(), ""), Duration::ZERO);
    assert!(line.unwrap().contains("run short: 2 of 2 tested"));
}

#[test]
fn the_join_waits_for_a_result_written_within_its_wait_and_no_longer() {
    let dir = tempfile::tempdir().unwrap();
    let start = std::time::Instant::now();
    assert_eq!(
        super::wait_for(dir.path(), Duration::from_millis(300)),
        None
    );
    assert!(
        start.elapsed() >= Duration::from_millis(300),
        "it gave up early"
    );
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "it waited past its wait"
    );
    let path = dir.path().join(worker::RESULT);
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(path, r#"{"ran":"missing"}"#).unwrap();
    });
    assert_eq!(
        super::wait_for(dir.path(), Duration::from_secs(5)),
        Some(Came::Missing)
    );
    writer.join().unwrap();
}

#[test]
fn a_run_abandoned_before_its_join_stops_its_worker() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let exe_path = bin.path().join("worker");
    exe::write_executable(
        &exe_path,
        "#!/bin/sh\necho $$ > \"$2/worker.pid\"\nexec sleep 60\n",
    )
    .unwrap();
    let setup = MutantsSetup {
        exe: exe_path,
        budget: Duration::from_secs(60),
        off: false,
        cargo: "cargo".into(),
        note: String::new(),
    };
    let (gate, files) = (passed(false), ["src/lib.rs".to_owned()]);
    let at = Launch {
        run_dir: run.path(),
        top: top.path(),
        base: "HEAD~1",
        rust_files: &files,
        other_profiles: false,
        gate: &gate,
        setup: Some(&setup),
    };
    let (mut m, _) = launch(&at);
    let pid_file = run.path().join("mutants").join(worker::PID);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !pid_file.is_file() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    super::abandon(&mut m);
    std::thread::sleep(Duration::from_millis(200));
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    assert!(
        stat.is_empty() || stat.contains(") Z "),
        "the worker outlived the run"
    );
    assert!(!m.running());
}

#[test]
fn a_baseline_that_failed_in_the_copy_is_said_with_its_cause_and_log() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let failed = r#"{"outcomes":[{"scenario":"Baseline","summary":"Failure"}],"total_mutants":3,"end_time":"t"}"#;
    work(top.path(), run.path(), &cargo(bin.path(), failed, 0, 4), 30);
    let (found, line) = join(&mut launched(top.path(), run.path(), ""), Duration::ZERO);
    let line = line.unwrap();
    assert!(found.is_empty());
    assert!(
        line.contains("outside its workspace") && line.contains("baseline.log"),
        "{line}"
    );
}
