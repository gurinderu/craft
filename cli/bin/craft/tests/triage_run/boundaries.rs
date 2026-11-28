use super::fixture::{Bench, read, result};
use serde_json::json;

#[test]
fn an_invalid_plugin_root_is_refused_before_the_host_or_any_run_state() {
    let b = Bench::new();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["triage", "run", "--backend", "codex", "--craft-root"])
        .arg(b.path("absent-plugin"))
        .arg("--host-bin")
        .arg(b.path("absent-host"))
        .arg("--report")
        .arg(b.path("report.md"))
        .arg("--run-dir")
        .arg(b.path("run"))
        .arg("--cwd")
        .arg(b.path("repo"))
        .env("HOME", b.path("home"))
        .output()
        .unwrap();
    b.expect(&out, 2);
    assert!(String::from_utf8_lossy(&out.stdout).contains("no craft plugin root"));
    assert!(b.calls().is_empty());
    assert!(!b.path("run/state.json").exists());
}

#[test]
fn a_refusal_before_the_host_ends_in_the_event_stream_too() {
    let b = Bench::new();
    let out = b
        .command("opencode", "ok")
        .args([
            "--delegate",
            "--agents",
            "review-task",
            "--prior-ledger",
            "-",
            "--report",
            "r",
        ])
        .output()
        .unwrap();
    b.expect(&out, 2);
    // The refusal is the stream's one event, its answer on stdout: the same end as the review's
    // (realm @nick/craft, node #690).
    let event = result(&out);
    assert_eq!(event["exit_code"], 2);
    assert!(event["run"].is_null(), "{event}");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).lines().count(),
        1,
        "the refusal is the stream's one event"
    );
    let answer = String::from_utf8_lossy(&out.stdout);
    assert!(answer.contains("Triage refused"), "{answer}");
    assert!(answer.contains("--delegate cannot share stdin"), "{answer}");
    assert!(answer.contains("Nothing ran"), "{answer}");
    assert!(b.calls().is_empty());
}

#[test]
fn invalid_or_missing_terminal_plan_is_failure_without_a_fallback_record() {
    for broken in [
        "missing",
        "directory",
        "{bad",
        "{}",
        "{\"plan_markdown\":\"x\",\"summary\":\"x\",\"ledger\":[{}]}",
    ] {
        let b = Bench::new();
        b.expect(&b.start("codex", "ok"), 0);
        let before = std::fs::read(b.path("run/record.json")).unwrap();
        let path = b.path("run/plan.json");
        std::fs::remove_file(&path).unwrap();
        match broken {
            "missing" => {}
            "directory" => std::fs::create_dir(&path).unwrap(),
            text => std::fs::write(&path, text).unwrap(),
        }
        let out = b.resume("codex", "ok");
        b.expect(&out, 1);
        assert_eq!(b.index().len(), 1);
        assert_eq!(std::fs::read(b.path("run/record.json")).unwrap(), before);
        assert_eq!(b.calls().len(), 2);
    }
}

#[test]
fn delegate_stdin_conflict_and_run_dir_conflict_are_refused_before_host() {
    let stdin = "--delegate cannot share stdin";
    for (args, said) in [
        (
            vec![
                "--delegate",
                "--agents",
                "review-task",
                "--prior-ledger",
                "-",
                "--report",
                "r",
            ],
            Some(stdin),
        ),
        (vec!["--run", "r", "--run-dir", "s"], Some("--run-dir")),
        (vec!["--repo", "relative", "--report", "r"], None),
        (
            vec![
                "--report",
                "r",
                "--prior-decisions",
                "-",
                "--delegate",
                "--agents",
                "review-task",
            ],
            Some(stdin),
        ),
    ] {
        let b = Bench::new();
        let out = b.command("opencode", "ok").args(&args).output().unwrap();
        b.expect(&out, 2);
        if let Some(said) = said {
            let said_out =
                [&out.stdout, &out.stderr].map(|o| String::from_utf8_lossy(o).into_owned());
            assert!(
                said_out.iter().any(|o| o.contains(said)),
                "{args:?}: {said_out:?}"
            );
        }
        assert!(b.calls().is_empty());
    }
}

#[test]
fn old_step_state_without_runtime_retains_claude_code_when_resumed_natively() {
    let b = Bench::new();
    b.expect(&b.start("codex", "limit"), 1);
    let path = b.path("run/state.json");
    let mut old = read(&path);
    old["args"].as_object_mut().unwrap().remove("runtime");
    std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();
    b.expect(&b.resume("pi", "ok"), 0);
    assert_eq!(
        read(&b.path("run/record.json"))["runtime"],
        json!("claude-code")
    );
    assert!(read(&path)["args"].get("runtime").is_none());
}

#[test]
fn relative_report_is_pinned_to_the_caller_before_repo_selection_and_survives_resume_elsewhere() {
    for flag in ["--repo", "--cwd"] {
        let b = Bench::new();
        std::fs::write(b.path("caller/input.md"), "No findings.").unwrap();
        std::fs::write(b.path("repo/input.md"), "wrong report").unwrap();
        let out = b
            .command("codex", "limit")
            .args(["--report", "input.md"])
            .arg(flag)
            .arg(b.path("repo"))
            .arg("--run-dir")
            .arg(b.path("run"))
            .output()
            .unwrap();
        b.expect(&out, 1);
        let report = read(&b.path("run/state.json"))["args"]["report"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(std::path::Path::new(&report).is_absolute(), "{report}");
        assert_eq!(
            std::fs::canonicalize(report).unwrap(),
            b.path("caller/input.md")
        );
        let out = b
            .command("pi", "nonempty")
            .arg("--run")
            .arg(b.path("run"))
            .current_dir(b.path("home"))
            .output()
            .unwrap();
        b.expect(&out, 0);
        assert_eq!(read(&b.path("run/record.json"))["triage"]["gathered"], 1);
    }
}
