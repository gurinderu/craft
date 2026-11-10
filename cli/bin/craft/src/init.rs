//! `craft init`: the reviewer's project profile (realm @nick/craft, node #467), asked for inside an
//! agent session, where the binary cannot prompt. `--propose` prints what the profile holds, the
//! project memory's `external` records the session pipes in, each with the revision its version
//! file names now (node #470, option (a); [`memory`]), and the candidates the repository's
//! deployment manifests name (the discovery of `lib/craft-externals.mjs`, node #435) as JSON; the
//! host session asks the reviewer which systems the code talks to and at which deployed tag or
//! commit, then `--write` stores exactly those. Beside them, the CI map (node #482): the checks
//! of the repository's workflows that carry clippy, test, fmt or build, which the gate reads when
//! it cannot build the head itself; `--propose` prints their candidates, the session confirms each
//! with the reviewer (node #483), and `--write --ci` records them ([`ci`]).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use anyhow::{Context, Result};
use craft_review::git;
use craft_review::project::{self, IntegrationPoint, ProjectProfile};
use craft_review::sources::{self, Git, SourcesSetup};
use serde_json::{Value, json};

use crate::review::find_craft_root;

mod ci;
mod memory;

#[derive(Debug, clap::Args)]
#[command(group(clap::ArgGroup::new("mode").required(true).args(["propose", "write"])))]
pub struct InitArgs {
    /// The repository the profile is for.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// Print the profile as it stands and the candidates found in the repository, as JSON; write
    /// nothing.
    #[arg(long)]
    pub propose: bool,
    /// Write the profile with exactly the integration points `--point` names (none: an empty
    /// list), replacing the ones it held.
    #[arg(long)]
    pub write: bool,
    /// An integration point: `<name>=<git url>@<tag or full commit>`; repeatable.
    #[arg(long = "point", requires = "write", value_name = "NAME=URL@REF")]
    pub points: Vec<String>,
    /// A CI map entry as JSON: a fresh confirmation `{"check","signal","command","workflow",
    /// "sources"}`, its files hashed at the write, or a held entry exactly as `--propose` prints it
    /// in `ci`, its hashes kept (one printed with `unusable` is dropped or replaced, never passed
    /// back); repeatable. The map is replaced like the points.
    #[arg(long = "ci", requires = "write", value_name = "JSON")]
    pub ci: Vec<String>,
    /// The project memory's `external` records as JSON on stdin (`-`, the only value): each one is
    /// proposed as an integration point with the revision its version file names now.
    #[arg(long = "memory-externals", requires = "propose", value_name = "-")]
    pub memory_externals: Option<String>,
    /// craft's plugin root, whose `lib/craft-externals.mjs` finds the candidates; found above the
    /// executable when absent.
    #[arg(long, env = "CRAFT_ROOT")]
    pub craft_root: Option<PathBuf>,
}

/// `~/.craft`, from `HOME`.
fn craft_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| Path::new(&h).join(".craft"))
}

/// `~/.craft/projects`, where each repository's profile is.
pub fn projects_dir() -> Option<PathBuf> {
    craft_home().map(|h| h.join("projects"))
}

/// Where a run started from this process finds the reviewer's profile and the sources cache.
pub fn sources_setup() -> Option<SourcesSetup> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let set = std::env::var("CRAFT_SOURCES_DIR").ok();
    Some(SourcesSetup {
        projects: craft_home()?.join("projects"),
        cache: sources::cache_root(set.as_deref(), home.as_deref()),
        git: Git::prompt_free(),
    })
}

fn print(value: &Value) -> Result<ExitCode> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", serde_json::to_string(value)?)?;
    Ok(ExitCode::SUCCESS)
}

pub fn init(args: &InitArgs) -> Result<ExitCode> {
    let projects = projects_dir().context("HOME is not set")?;
    let (path, common) = project::profile_path(&projects, &args.cwd)
        .with_context(|| format!("reading the repository {}", args.cwd.display()))?;
    if args.write {
        let points = args
            .points
            .iter()
            .map(|p| IntegrationPoint::parse(p).map_err(anyhow::Error::msg))
            .collect::<Result<Vec<_>>>()?;
        let entries = ci::confirmed(&args.ci, &args.cwd)?;
        let profile = ProjectProfile::new(common, points, entries)?;
        project::save(&path, &profile)?;
        return print(
            &json!({"profile": path, "integrations": profile.integrations, "ci": profile.ci}),
        );
    }
    let held = project::load(&path)?;
    let integrations = held
        .as_ref()
        .map(|p| p.integrations.clone())
        .unwrap_or_default();
    let held_ci = held.as_ref().map(|p| p.ci.clone()).unwrap_or_default();
    let root = args.craft_root.clone().or_else(find_craft_root);
    let recalled = memory::recalled(args.memory_externals.as_deref())?;
    let imported = memory::import(root.as_deref(), &args.cwd, &recalled, &integrations);
    let discovery = discover(root.as_deref(), &args.cwd, &integrations, &recalled);
    print(&json!({
        "profile": path,
        "exists": held.is_some(),
        "integrations": integrations,
        "memory": imported,
        "discovery": discovery,
        "ci": ci::held(&held_ci, &args.cwd),
        "ciCandidates": ci::proposed(&args.cwd),
        "write": "craft init --write --point <name>=<git url>@<tag or full commit> … --ci '<entry JSON>' … (every point and CI entry to keep, a held entry as `ci` prints it, one with `unusable` dropped or replaced; a branch is refused when a review prepares the sources)",
    }))
}

/// `answer` marked as having run, or `{"ran": false, "why": …}` when it could not (no plugin root,
/// no node).
fn ran(answer: Result<Value>) -> Value {
    match answer {
        Ok(mut v) => {
            if let Some(o) = v.as_object_mut() {
                o.insert("ran".into(), Value::Bool(true));
            }
            v
        }
        Err(e) => json!({"ran": false, "why": format!("{e:#}")}),
    }
}

/// The discovery's answer over the repository at `cwd`, the profile's points and the memory's
/// `recalled` records left out as known.
fn discover(
    root: Option<&Path>,
    cwd: &Path,
    known: &[IntegrationPoint],
    recalled: &memory::Recalled,
) -> Value {
    let mut records: Vec<Value> = known
        .iter()
        .map(|p| json!({"system": p.name, "repo": p.repo, "version": p.rev}))
        .collect();
    records.extend(memory::listed(recalled));
    ran(externals(
        root,
        cwd,
        &["discover", "--known", "-"],
        &Value::Array(records),
    ))
}

/// What `lib/craft-externals.mjs <verb> --repo-root <top> <rest…>` prints, `stdin` handed to it as
/// JSON; its `{"error"}` is an error.
fn externals(root: Option<&Path>, cwd: &Path, args: &[&str], stdin: &Value) -> Result<Value> {
    let root = root.context("no craft plugin root: pass --craft-root")?;
    let script = root.join("lib/craft-externals.mjs");
    anyhow::ensure!(
        script.is_file(),
        "no lib/craft-externals.mjs under {}",
        root.display()
    );
    let top = git::toplevel(cwd)?;
    let (verb, rest) = args.split_first().context("no verb")?;
    let mut child = Command::new("node")
        .arg(&script)
        .args([verb, "--repo-root"])
        .arg(&top)
        .args(rest)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("running node")?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(serde_json::to_string(stdin)?.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    let answer: Value = serde_json::from_slice(&out.stdout).with_context(|| {
        format!(
            "lib/craft-externals.mjs {verb} printed no JSON: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })?;
    match answer.get("error") {
        Some(e) => anyhow::bail!("lib/craft-externals.mjs {verb} refused: {e}"),
        None => Ok(answer),
    }
}
