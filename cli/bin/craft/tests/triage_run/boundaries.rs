use super::fixture::{Bench, read};
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
    for args in [
        vec![
            "--delegate",
            "--agents",
            "review-task",
            "--prior-ledger",
            "-",
            "--report",
            "r",
        ],
        vec!["--run", "r", "--run-dir", "s"],
        vec!["--repo", "relative", "--report", "r"],
        vec![
            "--report",
            "r",
            "--prior-decisions",
            "-",
            "--delegate",
            "--agents",
            "review-task",
        ],
    ] {
        let b = Bench::new();
        let out = b.command("opencode", "ok").args(args).output().unwrap();
        b.expect(&out, 2);
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
