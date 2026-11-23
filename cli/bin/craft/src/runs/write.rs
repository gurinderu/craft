//! `craft runs enrich-cost | sorting-choice | develop-cycle`: the writes made into the run store
//! after a run, by the launcher or a skill, with the binary's own store writer and no node
//! (`craft_store::cost`, `sorting`, `develop`; realm @nick/craft, nodes #393, #281, #39).

use craft_store::js::JsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, anyhow, bail};
use craft_store::adapter::Env;
use craft_store::js::{Js, Obj, parse};

/// Says each warning on stderr.
fn warn(verb: &str, warnings: &[String]) {
    let mut err = std::io::stderr().lock();
    for w in warnings {
        drop(writeln!(err, "craft runs {verb} WARNING: {w}"));
    }
}

/// The repository a write describes: `--project` against the working directory, else it.
pub(crate) fn repo(project: Option<&Path>) -> Result<PathBuf> {
    let cwd = std::env::current_dir().context("reading the working directory")?;
    Ok(project
        .filter(|p| !p.as_os_str().is_empty())
        .map_or_else(|| cwd.clone(), |p| cwd.join(p)))
}

/// What the store writer needs: where, the writing craft's commit, and now.
pub(crate) fn env(store: &Path) -> Env {
    craft_store::begin_write();
    let root = std::env::var_os("CRAFT_ROOT")
        .filter(|r| !r.is_empty())
        .map(PathBuf::from)
        .or_else(crate::review::find_craft_root);
    let commit = root
        .map(|r| craft_store::git::git(&["rev-parse", "--short", "HEAD"], &r))
        .filter(|c| !c.is_empty());
    Env {
        store: store.to_path_buf(),
        craft_commit: commit,
        now: craft_store::time::now_ms(),
    }
}

pub(crate) fn request(repo: &Path, session: Option<&str>) -> Obj {
    Obj::new()
        .with("repo", Js::str(repo.display().to_string()))
        .with("session", Js::str(session.unwrap_or_default()))
}

/// Where Claude Code keeps its transcripts: `--claude-home`, `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn claude_home(given: Option<&Path>) -> Result<PathBuf> {
    if let Some(h) = given.filter(|h| !h.as_os_str().is_empty()) {
        return Ok(h.to_path_buf());
    }
    if let Some(h) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|h| !h.is_empty()) {
        return Ok(PathBuf::from(h));
    }
    craft_store::read::home()
        .map(|h| h.join(".claude"))
        .context("neither HOME nor the passwd entry names a home, so there is no ~/.claude; pass --claude-home")
}

pub fn enrich_cost(store: &Path, run_id: &str, home: Option<&Path>) -> Result<ExitCode> {
    let home = claude_home(home)?;
    let said = craft_store::cost::enrich_run(run_id, &home, store).map_err(|why| anyhow!(why))?;
    said_all(&said)
}

/// Every transcript of `run_dir` summed into `record`.
pub fn enrich_dir(store: &Path, run_dir: &Path, record: &Path) -> Result<ExitCode> {
    let (dir, record) = (repo_relative(run_dir), repo_relative(record));
    let said = craft_store::cost::enrich_dir(&dir, &record, store).map_err(|why| anyhow!(why))?;
    said_all(&said)
}

fn said_all(said: &craft_store::cost::Enriched) -> Result<ExitCode> {
    warn("enrich-cost", &said.warnings);
    let mut out = std::io::stdout().lock();
    for line in &said.lines {
        writeln!(out, "{line}")?;
    }
    Ok(ExitCode::SUCCESS)
}

pub fn sorting_choice(
    store: &Path,
    n: &str,
    choice: &str,
    record: Option<&Path>,
    project: Option<&Path>,
) -> Result<ExitCode> {
    let repo = repo(project)?;
    let number = craft_store::js::number_of_text(n);
    let record = record.map(repo_relative);
    let req = request(&repo, None);
    let (_, line, warned) =
        craft_store::posthoc::sorting_choice(number, choice, record.as_deref(), &req, &env(store))
            .map_err(|why| anyhow!(why))?;
    warn("sorting-choice", &warned);
    writeln!(std::io::stdout().lock(), "{line}")?;
    Ok(ExitCode::SUCCESS)
}

/// A path flag against the working directory, as the JavaScript writer resolved it.
pub(crate) fn repo_relative(p: &Path) -> PathBuf {
    std::env::current_dir().map_or_else(|_| p.to_path_buf(), |cwd| cwd.join(p))
}

pub fn develop_cycle(
    store: &Path,
    project: Option<&Path>,
    session: Option<&str>,
) -> Result<ExitCode> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .context("reading the cycle on stdin")?;
    if text.js_trim().is_empty() {
        bail!("no record on stdin");
    }
    let Js::Obj(cycle) =
        parse(&text).map_err(|e| anyhow!("the cycle on stdin is not JSON: {e}"))?
    else {
        bail!("the cycle on stdin is not a JSON object");
    };
    let repo = repo(project)?;
    let (_, line, _) =
        craft_store::posthoc::develop_cycle(&cycle, &request(&repo, session), &env(store))
            .map_err(|why| anyhow!(why))?;
    writeln!(std::io::stdout().lock(), "{line}")?;
    Ok(ExitCode::SUCCESS)
}
