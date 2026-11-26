//! The mutants' launch, worker and join over a real repository, cargo-mutants a stand-in script
//! that writes the `outcomes.json` 27.1.0 writes (realm @nick/craft, node #624).

use std::path::Path;
use std::time::Duration;

use super::super::tests::{exe, git};
use super::super::{Gate, Status, Track};
use super::worker::{self, Came};
use super::{Launch, Mutants, MutantsSetup, abandon, join, launch};

/// A workspace whose first commit is on `main`; a side branch moves `main` on by a commit to
/// `add`, and the branch under review, cut before that, changes `big` on line 2 of `src/lib.rs`.
/// The review's base is `main`: its merge-base with the branch is the first commit.
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
    let lib = |add: &str, big: &str| {
        format!("pub fn add(a: i32) -> i32 {{ {add} }}\npub fn big(x: i32) -> bool {{ {big} }}\n")
    };
    std::fs::write(d.join("src/lib.rs"), lib("a + 1", "x > 10")).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["checkout", "-q", "-b", "change"]);
    git(d, &["checkout", "-q", "main"]);
    std::fs::write(d.join("src/lib.rs"), lib("a + 2", "x > 10")).unwrap();
    git(d, &["commit", "-qam", "main moves on"]);
    git(d, &["checkout", "-q", "change"]);
    std::fs::write(d.join("src/lib.rs"), lib("a + 1", "x >= 10")).unwrap();
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

/// A stand-in cargo: `mutants --version` answers; `mutants … -o <out> …` names itself in
/// `<bin>/cargo.pid`, waits `sleep` seconds, writes `outcomes` under `<out>/mutants.out/` and
/// exits `code`.
fn cargo(bin: &Path, outcomes: &str, sleep: u32, code: i32) -> String {
    let path = bin.join("cargo");
    std::fs::write(bin.join("outcomes.json"), outcomes).unwrap();
    let script = format!(
        "#!/bin/sh\n[ \"$2\" = --version ] && {{ echo 'cargo-mutants 27.1.0'; exit 0; }}\necho $$ > '{bin}/cargo.pid'\nwhile [ \"$1\" != -o ]; do shift; done\nmkdir -p \"$2/mutants.out\"\nsleep {sleep}\ncp '{bin}/outcomes.json' \"$2/mutants.out/outcomes.json\"\nexit {code}\n",
        bin = bin.display()
    );
    exe::write_executable(&path, &script).unwrap();
    path.display().to_string()
}

const MISSED_BIG: &str = r#"{"outcomes":[{"scenario":"Baseline","summary":"Success"},{"scenario":{"Mutant":{"name":"src/lib.rs:2:32: replace >= with < in big","file":"src/lib.rs","function":{"function_name":"big","return_type":"-> bool","span":{"start":{"line":2,"column":1},"end":{"line":2,"column":40}}},"span":{"start":{"line":2,"column":32},"end":{"line":2,"column":34}},"replacement":"<","genre":"BinaryOperator"}},"summary":"MissedMutant"},{"scenario":{"Mutant":{"name":"src/lib.rs:1:30: replace + with * in add","file":"src/lib.rs","function":{"function_name":"add","return_type":"-> i32","span":{"start":{"line":1,"column":1},"end":{"line":1,"column":36}}},"span":{"start":{"line":1,"column":30},"end":{"line":1,"column":31}},"replacement":"*","genre":"BinaryOperator"}},"summary":"MissedMutant"}],"total_mutants":2,"end_time":"t"}"#;

fn launched(top: &Path, run: &Path) -> Mutants {
    Mutants {
        dir: run.join("mutants").display().to_string(),
        top: top.display().to_string(),
        workspace: String::new(),
        base: "main".into(),
        joined: false,
        short: String::new(),
    }
}

/// Writes the request the launch would for `top` with `cargo`.
fn request(top: &Path, run: &Path, cargo: &str, budget_secs: u64) -> std::path::PathBuf {
    let dir = run.join("mutants");
    std::fs::create_dir_all(&dir).unwrap();
    let req = worker::Request {
        top: top.to_owned(),
        workspace: String::new(),
        base: "main".into(),
        inside: false,
        budget_secs,
        cargo: cargo.into(),
        nix: "nix".into(),
    };
    std::fs::write(
        dir.join(worker::REQUEST),
        serde_json::to_string(&req).unwrap(),
    )
    .unwrap();
    dir
}

/// Runs the worker over `top` in `run`'s mutants directory with `cargo`, in this process.
fn work(top: &Path, run: &Path, cargo: &str, budget_secs: u64) -> Came {
    let dir = request(top, run, cargo, budget_secs);
    worker::work(&dir).unwrap();
    serde_json::from_str(&std::fs::read_to_string(dir.join(worker::RESULT)).unwrap()).unwrap()
}

/// Whether the process `pid` is gone, its zombie aside.
fn gone(pid: &str) -> bool {
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid.trim())).unwrap_or_default();
    stat.is_empty() || stat.contains(") Z ")
}

#[test]
fn the_mutants_diff_is_the_change_from_its_merge_base_not_from_where_main_moved_to() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    work(
        top.path(),
        run.path(),
        &cargo(bin.path(), MISSED_BIG, 0, 2),
        30,
    );
    let diff = std::fs::read_to_string(run.path().join("mutants").join(worker::DIFF)).unwrap();
    assert!(
        diff.contains("+pub fn big(x: i32) -> bool { x >= 10 }"),
        "{diff}"
    );
    assert!(
        !diff.contains("a + 2"),
        "main's own move is no part of the change: {diff}"
    );
    assert!(
        diff.contains("--- a/src/lib.rs") && diff.contains("+++ b/src/lib.rs"),
        "{diff}"
    );
}

#[test]
fn a_survivor_in_the_changed_function_is_pooled_and_one_in_its_neighbour_is_counted_out() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    assert_eq!(
        work(
            top.path(),
            run.path(),
            &cargo(bin.path(), MISSED_BIG, 0, 2),
            30
        ),
        Came::Exited { code: Some(2) }
    );
    let mut m = launched(top.path(), run.path());
    let (found, line) = join(&mut m, Duration::ZERO);
    assert_eq!(m.degraded_note(), None, "a whole answer degrades nothing");
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
    assert!(!line.contains("run short"), "{line}");
}

#[test]
fn a_worker_past_its_budget_stops_cargo_mutants_and_says_how_long_it_ran() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let start = std::time::Instant::now();
    assert!(matches!(
        work(
            top.path(),
            run.path(),
            &cargo(bin.path(), MISSED_BIG, 30, 2),
            1
        ),
        Came::TimedOut { .. }
    ));
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "cargo-mutants was left to run"
    );
    assert!(gone(
        &std::fs::read_to_string(bin.path().join("cargo.pid")).unwrap()
    ));
    let mut m = launched(top.path(), run.path());
    let (found, line) = join(&mut m, Duration::ZERO);
    assert!(found.is_empty());
    assert!(
        line.unwrap().contains("budget ran out"),
        "a stopped run is said, not silent"
    );
    let degraded = m
        .degraded_note()
        .expect("a run with no outcome degrades the review");
    assert!(degraded.contains("budget ran out"), "{degraded}");
}

#[test]
fn a_change_with_no_mutant_in_its_lines_is_an_answer_not_a_broken_run() {
    for said in [
        "No mutants to filter",
        "Diff changes no Rust source files",
        "Diff file is empty",
    ] {
        no_mutant_is_an_answer(said);
    }
}

/// A cargo-mutants that says `said` on stderr, exits 0 and writes no `mutants.out/`.
fn no_mutant_is_an_answer(said: &str) {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let path = bin.path().join("cargo");
    exe::write_executable(
        &path,
        &format!("#!/bin/sh\n[ \"$2\" = --version ] && {{ echo 'cargo-mutants 27.1.0'; exit 0; }}\necho 'INFO {said}' >&2\nexit 0\n"),
    )
    .unwrap();
    assert_eq!(
        work(top.path(), run.path(), &path.display().to_string(), 30),
        Came::NoMutants
    );
    let mut m = launched(top.path(), run.path());
    let (found, line) = join(&mut m, Duration::ZERO);
    assert!(found.is_empty());
    let line = line.unwrap();
    assert!(
        line.contains("found no mutant in the change") && !line.contains("did not run"),
        "{line}"
    );
    assert_eq!(m.degraded_note(), None);
}

#[test]
fn a_worker_asked_to_stop_at_the_join_stops_cargo_mutants_itself() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let dir = request(
        top.path(),
        run.path(),
        &cargo(bin.path(), MISSED_BIG, 60, 2),
        120,
    );
    let worker = std::thread::spawn(move || worker::work(&dir).unwrap());
    let pid = bin.path().join("cargo.pid");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !pid.is_file() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let (found, line) = join(
        &mut launched(top.path(), run.path()),
        Duration::from_millis(100),
    );
    worker.join().unwrap();
    assert!(found.is_empty());
    assert!(line.unwrap().contains("stopped at the join"));
    assert!(
        gone(&std::fs::read_to_string(&pid).unwrap()),
        "cargo-mutants outlived the join"
    );
}

#[test]
fn a_run_abandoned_before_its_join_has_its_worker_stop() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let dir = request(
        top.path(),
        run.path(),
        &cargo(bin.path(), MISSED_BIG, 60, 2),
        120,
    );
    let worker = std::thread::spawn(move || worker::work(&dir).unwrap());
    let pid = bin.path().join("cargo.pid");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !pid.is_file() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut m = launched(top.path(), run.path());
    abandon(&mut m);
    worker.join().unwrap();
    assert!(!m.running());
    assert!(
        gone(&std::fs::read_to_string(&pid).unwrap()),
        "cargo-mutants outlived the run"
    );
}

#[test]
fn a_worker_that_never_answers_is_said_with_its_last_word() {
    let (top, run) = (repo(), tempfile::tempdir().unwrap());
    let dir = run.path().join("mutants");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(worker::ERR),
        "error: unrecognized subcommand '__craft-mutants'\n",
    )
    .unwrap();
    let (_, line) = join(&mut launched(top.path(), run.path()), Duration::ZERO);
    assert!(line.unwrap().contains("unrecognized subcommand"));
}

#[test]
fn a_request_it_cannot_read_is_a_result_not_silence() {
    let run = tempfile::tempdir().unwrap();
    let dir = run.path().join("mutants");
    std::fs::create_dir_all(&dir).unwrap();
    worker::work(&dir).unwrap();
    let came: Came =
        serde_json::from_str(&std::fs::read_to_string(dir.join(worker::RESULT)).unwrap()).unwrap();
    assert!(matches!(came, Came::Broken { .. }), "{came:?}");
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
    let (_, line) = join(&mut launched(top.path(), run.path()), Duration::ZERO);
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
    let (_, line) = join(&mut launched(top.path(), run.path()), Duration::ZERO);
    assert!(line.unwrap().contains("check the diff's paths"));
}

#[test]
fn a_run_cut_short_is_said_short() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let unended = MISSED_BIG.replace("\"end_time\":\"t\"", "\"end_time\":null");
    work(
        top.path(),
        run.path(),
        &cargo(bin.path(), &unended, 0, 2),
        30,
    );
    let mut m = launched(top.path(), run.path());
    let (_, line) = join(&mut m, Duration::ZERO);
    assert!(line.unwrap().contains("run short: 2 of 2 tested"));
    assert!(m.degraded_note().is_some_and(|n| n.contains("run short")));
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
    let mut m = launched(top.path(), run.path());
    let (found, line) = join(&mut m, Duration::ZERO);
    assert!(
        m.degraded_note()
            .is_some_and(|n| n.contains("baseline.log"))
    );
    let line = line.unwrap();
    assert!(found.is_empty());
    assert!(
        line.contains("outside its workspace") && line.contains("baseline.log"),
        "{line}"
    );
}

#[test]
fn the_join_waits_for_a_result_written_within_its_wait_and_no_longer() {
    let dir = tempfile::tempdir().unwrap();
    let start = std::time::Instant::now();
    assert_eq!(
        super::join::wait_for(dir.path(), Duration::from_millis(300)),
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
        super::join::wait_for(dir.path(), Duration::from_secs(5)),
        Some(Came::Missing)
    );
    writer.join().unwrap();
}

#[test]
fn the_workspace_is_the_nearest_declared_one_holding_most_changed_files() {
    let top = tempfile::tempdir().unwrap();
    let d = top.path();
    for dir in ["cli/crates/a/src", "cli/crates/b/src", "tool/src"] {
        std::fs::create_dir_all(d.join(dir)).unwrap();
    }
    std::fs::write(
        d.join("cli/Cargo.toml"),
        "[workspace] # all crates\nmembers = [\"crates/*\"]\n",
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
    assert_eq!(super::launch::workspaces_of(d, &files), ["cli", "tool"]);
    assert_eq!(
        super::launch::workspaces_of(d, &["loose.rs".to_owned()]),
        Vec::<String>::new()
    );
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

fn setup(cargo: String) -> MutantsSetup {
    MutantsSetup {
        exe: "/nonexistent".into(),
        budget: Duration::from_secs(1),
        off: false,
        cargo,
        nix: "nix".into(),
        note: String::new(),
    }
}

type Case<'a> = (
    &'a [String],
    bool,
    &'a Gate,
    Result<&'a MutantsSetup, &'a str>,
    bool,
    &'a str,
);

fn said(c: &Case<'_>) -> (Mutants, Vec<String>) {
    let (top, run) = (repo(), tempfile::tempdir().unwrap());
    let &(files, other, gate, setup, stopped, _) = c;
    let cancel = crate::cancel::Cancel::default();
    if stopped {
        cancel.cancel();
    }
    launch(&Launch {
        run_dir: run.path(),
        top: top.path(),
        base: "main",
        rust_files: files,
        other_profiles: other,
        gate,
        setup,
        cancel: &cancel,
    })
}

#[test]
fn each_reason_they_do_not_run_is_said_never_silent() {
    let rust = ["src/lib.rs".to_owned()];
    let bin = tempfile::tempdir().unwrap();
    let ok = setup(cargo(bin.path(), MISSED_BIG, 0, 2));
    let off = MutantsSetup {
        off: true,
        ..ok.clone()
    };
    let missing = setup(bin.path().join("absent-cargo").display().to_string());
    let red = Gate {
        tracks: vec![Track {
            profile: "rust".into(),
            status: Status::Fail,
            ..Track::default()
        }],
        ..Gate::default()
    };
    let pass = passed(false);
    let cases: [Case<'_>; 7] = [
        (&[], true, &pass, Ok(&ok), false, "no Rust"),
        (
            &rust,
            false,
            &pass,
            Err("no gate of its own"),
            false,
            "no gate of its own",
        ),
        (
            &rust,
            false,
            &pass,
            Ok(&off),
            false,
            "off in the reviewer's profile",
        ),
        (&rust, false, &red, Ok(&ok), false, "the Rust gate is red"),
        (
            &rust,
            false,
            &Gate::default(),
            Ok(&ok),
            false,
            "the Rust gate did not run",
        ),
        (&rust, false, &pass, Ok(&ok), true, "the run was stopped"),
        (
            &rust,
            false,
            &pass,
            Ok(&missing),
            false,
            "cargo is not on the PATH",
        ),
    ];
    for c in &cases {
        let (m, lines) = said(c);
        let line = lines.join(" | ");
        assert!(
            !m.running(),
            "{}: nothing may be launched when they do not run",
            c.5
        );
        assert!(
            line.contains("did not run") && line.contains(c.5),
            "{}: {line}",
            c.5
        );
    }
    let (_, lines) = said(&(&[], false, &pass, Ok(&ok), false, ""));
    assert!(lines.is_empty(), "a change of nothing says nothing");
}

#[test]
fn a_probe_that_finds_cargo_without_mutants_launches_nothing() {
    let bin = tempfile::tempdir().unwrap();
    let path = bin.path().join("cargo");
    exe::write_executable(
        &path,
        "#!/bin/sh\necho 'error: no such command: `mutants`' >&2\nexit 101\n",
    )
    .unwrap();
    let s = setup(path.display().to_string());
    let rust = ["src/lib.rs".to_owned()];
    let (m, lines) = said(&(&rust, false, &passed(false), Ok(&s), false, ""));
    assert!(!m.running());
    assert!(
        lines.join(" ").contains("cargo-mutants is not installed"),
        "{lines:?}"
    );
}

#[test]
fn a_launch_names_the_workspaces_it_leaves_out() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    std::fs::create_dir_all(top.path().join("tool/src")).unwrap();
    std::fs::write(
        top.path().join("tool/Cargo.toml"),
        "[package]\nname = \"tool\"\n\n[workspace]\n",
    )
    .unwrap();
    // A stand-in worker that exits at once: the launch is all this test reads.
    let worker = bin.path().join("worker");
    exe::write_executable(&worker, "#!/bin/sh\nexit 0\n").unwrap();
    let s = MutantsSetup {
        exe: worker,
        ..setup(cargo(bin.path(), MISSED_BIG, 0, 2))
    };
    let files = ["src/lib.rs".to_owned(), "tool/src/main.rs".to_owned()];
    let (m, lines) = launch(&Launch {
        run_dir: run.path(),
        top: top.path(),
        base: "main",
        rust_files: &files,
        other_profiles: false,
        gate: &passed(false),
        setup: Ok(&s),
        cancel: &crate::cancel::Cancel::default(),
    });
    assert!(m.running());
    assert!(
        lines.join(" ").contains("got none") && lines.join(" ").contains("`tool`"),
        "{lines:?}"
    );
}

#[test]
fn the_probe_and_the_worker_run_inside_the_dev_shell_when_the_gate_did() {
    let (top, run, bin) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let cargo = cargo(bin.path(), MISSED_BIG, 0, 2);
    let (log, nix) = (bin.path().join("nix.log"), bin.path().join("nix"));
    // A stand-in nix: logs its arguments and runs what follows `-c`.
    let script = format!(
        "#!/bin/sh\necho \"$*\" >> '{}'\nwhile [ \"$1\" != -c ]; do shift; done; shift; exec \"$@\"\n",
        log.display()
    );
    exe::write_executable(&nix, &script).unwrap();
    let worker = bin.path().join("worker");
    exe::write_executable(&worker, "#!/bin/sh\nexit 0\n").unwrap();
    let s = MutantsSetup {
        exe: worker,
        nix: nix.display().to_string(),
        ..setup(cargo.clone())
    };
    let files = ["src/lib.rs".to_owned()];
    let (m, lines) = launch(&Launch {
        run_dir: run.path(),
        top: top.path(),
        base: "main",
        rust_files: &files,
        other_profiles: false,
        gate: &passed(true),
        setup: Ok(&s),
        cancel: &crate::cancel::Cancel::default(),
    });
    assert!(m.running(), "{lines:?}");
    let req: worker::Request = serde_json::from_str(
        &std::fs::read_to_string(run.path().join("mutants").join(worker::REQUEST)).unwrap(),
    )
    .unwrap();
    assert!(req.inside && req.nix == s.nix);
    worker::work(&run.path().join("mutants")).unwrap();
    let calls = std::fs::read_to_string(&log).unwrap();
    let develop = format!("develop --no-write-lock-file . -c {cargo} mutants");
    let lines: Vec<&str> = calls.lines().collect();
    assert_eq!(lines.len(), 2, "the probe and the run: {calls}");
    assert!(lines.iter().all(|l| l.contains(&develop)), "{calls}");
    assert!(
        lines[0].ends_with("mutants --version") && lines[1].contains("--in-diff"),
        "{calls}"
    );
}

#[test]
fn a_nested_workspace_is_its_own_root_and_a_dotted_table_declares_one() {
    let top = tempfile::tempdir().unwrap();
    let d = top.path();
    std::fs::create_dir_all(d.join("crates/inner/src")).unwrap();
    std::fs::create_dir_all(d.join("lib/src")).unwrap();
    std::fs::write(d.join("Cargo.toml"), "[workspace]\nmembers = [\"lib\"]\n").unwrap();
    std::fs::write(
        d.join("crates/inner/Cargo.toml"),
        "[package]\nname = \"inner\"\n\n[workspace.dependencies]\n",
    )
    .unwrap();
    std::fs::write(d.join("lib/Cargo.toml"), "[package]\nname = \"lib\"\n").unwrap();
    let inner = ["crates/inner/src/lib.rs".to_owned()];
    assert_eq!(
        super::launch::workspaces_of(d, &inner),
        ["crates/inner"],
        "nearest, not topmost"
    );
    assert_eq!(
        super::launch::workspaces_of(d, &["lib/src/lib.rs".to_owned()]),
        [""],
        "a member's root is its workspace's"
    );
}

#[test]
fn a_workspace_below_the_top_gets_its_paths_from_its_root_whatever_the_user_git_config_says() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("cli/src")).unwrap();
    std::fs::write(d.join("cli/src/lib.rs"), "pub fn f() {}\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["config", "diff.mnemonicPrefix", "true"]);
    git(d, &["config", "diff.noprefix", "true"]);
    std::fs::write(d.join("cli/src/lib.rs"), "pub fn f() { g(); }\n").unwrap();
    let diff = crate::git::relative_diff(d, "HEAD", "cli").unwrap();
    assert!(
        diff.contains("--- a/src/lib.rs") && diff.contains("+++ b/src/lib.rs"),
        "{diff}"
    );
    assert!(!diff.contains("cli/"), "{diff}");
}
