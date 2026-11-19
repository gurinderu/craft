//! `craft hook pr-opened`: the `PostToolUse` hook on the Bash tool that says, once a pull request
//! is opened, when the run store holds no finished full craft review of its head and whole change
//! (realm @nick/craft, node #541; in the binary, not Node: #537; after the command, since a hook's
//! context reaches the model only then anyway: #289). It reads Claude Code's `PostToolUse` input on
//! stdin — `tool_name`, `tool_input.command`, `tool_response` (Bash's `stdout`/`stderr`), `cwd` —
//! takes the PR's URL from the command's output, asks GitHub for its head and base (`gh pr view`),
//! and prints the hook's JSON output or nothing. Silence means that review exists or the call opened
//! no PR; whatever stops the check from telling is said as a line, never as silence. It warns,
//! never blocks: every way out is exit 0, a write to a closed stdout included.

mod bounded;
mod counts;
mod github;
mod input;
mod record;
mod repo;
mod runs;
mod said;

use std::io::{Read, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::Result;
use serde_json::Value;

use input::Input;

#[derive(Debug, clap::Args)]
pub struct PrOpenedArgs {
    /// The run store to read; `~/.craft/runs`, where craft's record writer files, when absent.
    #[arg(long)]
    pub store: Option<PathBuf>,
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "every subcommand returns Result to main"
)]
pub fn pr_opened(args: &PrOpenedArgs) -> Result<ExitCode> {
    let mut stdin = String::new();
    let out = match std::io::stdin().read_to_string(&mut stdin) {
        Ok(_) => check(&stdin, args.store.as_deref()),
        Err(e) => Some(said::could_not(
            None,
            &format!("the hook input could not be read ({e})"),
        )),
    };
    if let Some(out) = out {
        // A reader gone (the harness's timeout) leaves no one to tell; the exit stays 0.
        writeln!(std::io::stdout().lock(), "{out}").unwrap_or_default();
    }
    Ok(ExitCode::SUCCESS)
}

/// The output for the hook input `stdin`; `None` when it opened no PR, or the PR's head has its
/// review.
fn check(stdin: &str, store: Option<&Path>) -> Option<Value> {
    let (url, cwd) = match input::read(stdin) {
        Input::Silent => return None,
        Input::Unreadable(why) => return Some(said::could_not(None, &why)),
        Input::Opened { url, cwd } => (url, cwd),
    };
    Some(match judge(&url, cwd, store) {
        Ok(out) => out?,
        Err(why) => said::could_not(Some(&url), &why),
    })
}

/// What to say of the PR at `url`, opened from `cwd`; `Ok(None)` when its head has its review.
fn judge(url: &str, cwd: Option<PathBuf>, store: Option<&Path>) -> Result<Option<Value>, String> {
    let dir = match cwd {
        Some(d) => d,
        None => std::env::current_dir()
            .map_err(|e| format!("the hook's directory is unreadable ({e})"))?,
    };
    let pr = github::view(&dir, url)?;
    let (here, checkout) = repo::read(&dir, &pr)?;
    let store = store
        .map(Path::to_path_buf)
        .or_else(|| home().map(|h| h.join(".craft/runs")))
        .ok_or("HOME is not set, so there is no ~/.craft/runs")?;
    Ok(said::said(
        &runs::look(&store, &here, &checkout),
        url,
        &here,
    ))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}
