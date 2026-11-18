//! `craft hook pre-pr`: the `PreToolUse` hook on the Bash tool that says, before `gh pr create`
//! opens a pull request, when the run store holds no finished full craft review of its head and
//! whole change (realm @nick/craft, node #541; in the binary, not Node: #537). It reads the
//! harness's hook input on stdin — `tool_name`, `tool_input.command`, `cwd`, as Claude Code sends a
//! `PreToolUse` input — and prints the hook's JSON output or nothing. Silence means that review
//! exists; whatever stops the check from telling is said as a line, never as silence. It warns,
//! never blocks: every way out is exit 0, a write to a closed stdout included.

mod command;
mod counts;
mod here;
mod prefix;
mod record;
mod runs;
mod said;
mod split;

use std::io::{Read, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::Result;
use serde_json::Value;

#[derive(Debug, clap::Args)]
pub struct PrePrArgs {
    /// The run store to read; `~/.craft/runs`, where craft's record writer files, when absent.
    #[arg(long)]
    pub store: Option<PathBuf>,
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "every subcommand returns Result to main"
)]
pub fn pre_pr(args: &PrePrArgs) -> Result<ExitCode> {
    let mut input = String::new();
    let out = match std::io::stdin().read_to_string(&mut input) {
        Ok(_) => check(&input, args.store.as_deref(), home().as_deref()),
        Err(e) => Some(said::could_not(&format!(
            "the hook input could not be read ({e})"
        ))),
    };
    if let Some(out) = out {
        // A reader gone (the harness's timeout) leaves no one to tell; the exit stays 0.
        writeln!(std::io::stdout().lock(), "{out}").unwrap_or_default();
    }
    Ok(ExitCode::SUCCESS)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Input that may be a `gh pr create`: what is not cannot be ours, and stays silent unread.
fn may_be_ours(input: &str) -> bool {
    input.contains("gh") && (input.contains("create") || input.contains("new"))
}

/// The output for the hook input `input`; `None` when it is not a `gh pr create`, or the head has
/// its review.
fn check(input: &str, store: Option<&Path>, home: Option<&Path>) -> Option<Value> {
    let parsed: Value = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(e) => {
            return may_be_ours(input)
                .then(|| said::could_not(&format!("the hook input is not JSON ({e})")));
        }
    };
    if parsed.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return None;
    }
    let Some(command) = parsed
        .pointer("/tool_input/command")
        .and_then(Value::as_str)
    else {
        return may_be_ours(input)
            .then(|| said::could_not("the hook input carries no tool_input.command"));
    };
    let cwd = match parsed.get("cwd").and_then(Value::as_str) {
        Some(c) if !c.is_empty() => Ok(PathBuf::from(c)),
        _ => {
            std::env::current_dir().map_err(|e| format!("the hook's directory is unreadable ({e})"))
        }
    };
    let pr = command::pr_create(command, cwd.as_deref().unwrap_or(Path::new("")), home)?;
    judge(pr, cwd.err(), store, home)
}

/// What to say of the PR `pr` opens, `None` when its head has its review; `unknown_cwd` why the directory it runs from is unknown.
fn judge(
    pr: command::PrCreate,
    unknown_cwd: Option<String>,
    store: Option<&Path>,
    home: Option<&Path>,
) -> Option<Value> {
    if let Some(by) = &pr.moved_by {
        return Some(said::moved(by));
    }
    let dir = match (unknown_cwd, pr.dir) {
        (Some(why), _) | (None, Err(why)) => return Some(said::could_not(&why)),
        (None, Ok(dir)) => dir,
    };
    let (here, git) = match here::read(&dir, pr.head.as_deref()) {
        Ok(h) => h,
        Err(why) => return Some(said::could_not(&why)),
    };
    let found = match store
        .map(Path::to_path_buf)
        .or_else(|| home.map(|h| h.join(".craft/runs")))
    {
        Some(store) => runs::look(&store, &here, &git),
        None => runs::Found::NoStore("HOME is not set, so there is no ~/.craft/runs".into()),
    };
    said::said(&found, &here)
}
