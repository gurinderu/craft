//! The process that runs cargo-mutants for a review (realm @nick/craft, node #648): started by
//! `review start` and left to run beside the lens rounds in a session of its own, so the step
//! that started it ends without it. cargo-mutants runs in a session of its own too, so one stop of
//! its group reaches every test it runs; the worker stops it past its budget, or once the join
//! asks by writing `stop` — only the worker signals it, holding it as its child, so no process id
//! is signalled after another took it. What it came to it writes last, as `result.json`, beside
//! cargo-mutants' own `mutants.out/`; a request it cannot read is a result too.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::MutantsError;

/// How often the running cargo-mutants is checked for having exited or being asked to stop.
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
    /// What the review's change is against; the diff starts at its merge-base, as the review's.
    pub base: String,
    /// Whether cargo runs inside the flake's dev shell, as the gate's did.
    pub inside: bool,
    pub budget_secs: u64,
    /// The program cargo is: `cargo`, or a stand-in under test.
    pub cargo: String,
    /// The program nix is, for the dev shell: `nix`, or a stand-in under test.
    #[serde(default = "nix")]
    pub nix: String,
}

fn nix() -> String {
    "nix".into()
}

/// What the worker came to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "ran")]
pub(crate) enum Came {
    /// cargo-mutants exited with `code` (2: some mutant survived; 0: none did).
    Exited { code: Option<i32> },
    /// cargo-mutants is not installed.
    Missing,
    /// Its budget ran out after `secs`.
    TimedOut { secs: u64 },
    /// The join asked it to stop.
    Stopped,
    /// cargo-mutants found no mutant in the change's lines: it exits 0 and writes no
    /// `mutants.out/` (27.1.0: `INFO No mutants to filter`).
    NoMutants,
    /// It could not be started, or the request or the diff not read.
    Broken { message: String },
}

pub(crate) const REQUEST: &str = "request.json";
pub(crate) const RESULT: &str = "result.json";
pub(crate) const STOP: &str = "stop";
pub(crate) const ERR: &str = "worker.err";
pub(crate) const DIFF: &str = "change.diff";
/// What cargo-mutants 27.1.0 says on stderr when the diff holds no mutant.
const NO_MUTANTS: &str = "No mutants to filter";

/// Runs the request in `dir` (the run's mutants directory) to its end and writes what it came to.
///
/// # Errors
/// When the result cannot be written.
pub fn work(dir: &Path) -> Result<(), MutantsError> {
    let came = match request(dir) {
        Ok(req) => run(dir, &req),
        Err(e) => Came::Broken {
            message: e.to_string(),
        },
    };
    write_result(dir, &came)
}

fn request(dir: &Path) -> Result<Request, MutantsError> {
    let path = dir.join(REQUEST);
    let text = std::fs::read_to_string(&path).map_err(|source| MutantsError::Io {
        what: format!("reading {}", path.display()),
        source,
    })?;
    serde_json::from_str(&text).map_err(|source| MutantsError::Json {
        what: format!("reading {}", path.display()),
        source,
    })
}

fn write_result(dir: &Path, came: &Came) -> Result<(), MutantsError> {
    let text = serde_json::to_string(came).map_err(|source| MutantsError::Json {
        what: "the result".into(),
        source,
    })?;
    let (tmp, to) = (dir.join(format!("{RESULT}.tmp")), dir.join(RESULT));
    let io = |source| MutantsError::Io {
        what: format!("writing {}", to.display()),
        source,
    };
    std::fs::write(&tmp, text).map_err(io)?;
    std::fs::rename(&tmp, &to).map_err(io)
}

fn run(dir: &Path, req: &Request) -> Came {
    let diff = dir.join(DIFF);
    if let Err(message) = write_diff(req, &diff) {
        return Came::Broken { message };
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
        (&req.nix, super::super::devshell::inside(&req.cargo, &args))
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
        .env("CARGO_TERM_COLOR", "never");
    cmd.stdin(Stdio::null()).stdout(o).stderr(e);
    crate::cancel::detached(&mut cmd);
    match cmd.spawn() {
        Ok(child) => watch(child, dir, Duration::from_secs(req.budget_secs)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Came::Missing,
        Err(e) => Came::Broken {
            message: format!("{program} could not start: {e}"),
        },
    }
}

/// Waits for cargo-mutants, stopping its group past `budget` or once `stop` appears in `dir`.
fn watch(mut child: std::process::Child, dir: &Path, budget: Duration) -> Came {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return exited(status.code(), dir),
            Ok(None) if dir.join(STOP).exists() => {
                crate::cancel::kill_group(&mut child);
                return Came::Stopped;
            }
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
    if dir.join("mutants.out").join("outcomes.json").is_file() {
        return Came::Exited { code };
    }
    let err = std::fs::read_to_string(dir.join("cargo-mutants.err")).unwrap_or_default();
    if err.contains("no such command") {
        return Came::Missing;
    }
    if code == Some(0) && err.contains(NO_MUTANTS) {
        return Came::NoMutants;
    }
    let last = super::super::check::last_line(&err);
    Came::Broken {
        message: format!("cargo-mutants wrote no outcomes (exit {code:?}): {last}"),
    }
}

/// The change from its merge-base with `base`, its paths from the workspace's root, written to
/// `to`: what the review's own diff holds, printed whatever the user's git config says.
fn write_diff(req: &Request, to: &Path) -> Result<(), String> {
    let diff = crate::git::relative_diff(&req.top, &req.base, &req.workspace)
        .map_err(|e| format!("the change's diff could not be read: {e}"))?;
    std::fs::write(to, diff).map_err(|e| format!("the diff could not be written: {e}"))
}
