//! The process that runs cargo-mutants for a review (realm @nick/craft, node #648): started by
//! `review start` and left to run beside the lens rounds in a session of its own, so the step
//! that started it ends without it. cargo-mutants runs in a session of its own too, its leader's
//! id written as `group.pid`, so one stop of that group reaches every test it runs. The worker
//! bounds it: past its budget it stops that group and says so. What it came to it writes last, as
//! `result.json`, beside cargo-mutants' own `mutants.out/`.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How often the running cargo-mutants is checked for having exited.
const POLL: Duration = Duration::from_millis(200);

/// What the worker is asked to do, as `review start` writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    /// The checkout's top level: where git and the dev shell run.
    pub top: PathBuf,
    /// The cargo workspace, repository-relative ('' at the top): cargo-mutants reads the diff's
    /// paths from its root (node #624).
    pub workspace: String,
    /// The commit the review's change is against.
    pub base: String,
    /// Whether cargo runs inside the flake's dev shell, as the gate's did.
    pub inside: bool,
    pub budget_secs: u64,
    /// The program cargo is: `cargo`, or a stand-in under test.
    #[serde(default = "cargo")]
    pub cargo: String,
}

fn cargo() -> String {
    "cargo".into()
}

/// What the worker came to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "ran")]
pub(crate) enum Came {
    /// cargo-mutants exited with `code` (2: some mutant survived; 0: none did).
    Exited { code: Option<i32> },
    /// cargo was not found.
    Missing,
    /// Its budget ran out after `secs`.
    TimedOut { secs: u64 },
    /// It could not be started, or the diff not written.
    Broken { message: String },
}

pub(crate) const REQUEST: &str = "request.json";
pub(crate) const RESULT: &str = "result.json";
pub(crate) const PID: &str = "worker.pid";
pub(crate) const GROUP: &str = "group.pid";
pub(crate) const DIFF: &str = "change.diff";

/// Runs the request in `dir` (the run's mutants directory) to its end.
///
/// # Errors
/// When the request cannot be read or the result not written.
pub fn work(dir: &Path) -> Result<(), String> {
    std::fs::write(dir.join(PID), std::process::id().to_string()).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(dir.join(REQUEST)).map_err(|e| e.to_string())?;
    let req: Request = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let result = run(dir, &req);
    write_result(dir, &result)
}

fn write_result(dir: &Path, result: &Came) -> Result<(), String> {
    let text = serde_json::to_string(result).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{RESULT}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(RESULT)).map_err(|e| e.to_string())
}

fn run(dir: &Path, req: &Request) -> Came {
    let diff = dir.join(DIFF);
    if let Err(e) = write_diff(req, &diff) {
        return Came::Broken { message: e };
    }
    let ws = req.top.join(&req.workspace);
    let (diff, out, ws) = (
        diff.display().to_string(),
        dir.display().to_string(),
        ws.display().to_string(),
    );
    let args = [
        "mutants",
        "--in-diff",
        &diff,
        "-o",
        &out,
        "-d",
        &ws,
        "--no-shuffle",
        "--colors",
        "never",
    ];
    let (program, all): (&str, Vec<&str>) = if req.inside {
        ("nix", super::super::devshell::inside(&req.cargo, &args))
    } else {
        (&req.cargo, args.to_vec())
    };
    let logs = (
        File::create(dir.join("cargo-mutants.out")),
        File::create(dir.join("cargo-mutants.err")),
    );
    let (Ok(o), Ok(e)) = logs else {
        return Came::Broken {
            message: "its log files could not be created".into(),
        };
    };
    let mut cmd = Command::new(program);
    cmd.args(&all)
        .current_dir(&req.top)
        .env("CARGO_TERM_COLOR", "never")
        .stdin(Stdio::null())
        .stdout(o)
        .stderr(e);
    crate::cancel::detached(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Came::Missing,
        Err(e) => {
            return Came::Broken {
                message: format!("{program} could not start: {e}"),
            };
        }
    };
    if std::fs::write(dir.join(GROUP), child.id().to_string()).is_err() {
        crate::cancel::kill_group(&mut child);
        return Came::Broken {
            message: "its group could not be written down".into(),
        };
    }
    let (start, budget) = (Instant::now(), Duration::from_secs(req.budget_secs));
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return exited(status.code(), dir),
            Ok(None) if start.elapsed() >= budget => {
                crate::cancel::kill_group(&mut child);
                return Came::TimedOut {
                    secs: start.elapsed().as_secs(),
                };
            }
            Ok(None) => std::thread::sleep(POLL),
            Err(e) => {
                return Came::Broken {
                    message: e.to_string(),
                };
            }
        }
    }
}

/// cargo-mutants' exit, or cargo's own when no `mutants` subcommand is installed: it then exits
/// with an error and writes no `mutants.out/`.
fn exited(code: Option<i32>, dir: &Path) -> Came {
    let wrote = dir.join("mutants.out").join("outcomes.json").is_file();
    if wrote {
        return Came::Exited { code };
    }
    let err = std::fs::read_to_string(dir.join("cargo-mutants.err")).unwrap_or_default();
    if err.contains("no such command") {
        return Came::Missing;
    }
    let last = err
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("no message");
    Came::Broken {
        message: format!(
            "cargo-mutants wrote no outcomes (exit {code:?}): {}",
            last.chars().take(200).collect::<String>()
        ),
    }
}

/// The change against `base`, its paths from the workspace's root, written to `to`.
fn write_diff(req: &Request, to: &Path) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&req.top)
        .arg("diff")
        .arg("--no-color")
        .arg("--no-ext-diff");
    if !req.workspace.is_empty() {
        cmd.arg(format!(
            "--relative={}/",
            req.workspace.trim_end_matches('/')
        ));
    }
    cmd.arg(&req.base).stdin(Stdio::null());
    crate::cancel::no_prompt_env(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("git diff could not start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    std::fs::write(to, &out.stdout).map_err(|e| format!("the diff could not be written: {e}"))
}
