//! `craft init`: the reviewer's project profile (realm @nick/craft, node #467), asked for inside an
//! agent session, where the binary cannot prompt. `--propose` prints what the profile holds and
//! the candidates the repository's deployment manifests name (the discovery of
//! `lib/craft-externals.mjs`, node #435) as JSON; the host session asks the reviewer which systems
//! the code talks to and at which deployed tag or commit, then `--write` stores exactly those.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use anyhow::{Context, Result};
use craft_review::git;
use craft_review::project::{self, IntegrationPoint, ProjectProfile};
use craft_review::sources::{self, Git, SourcesSetup};
use serde_json::{Value, json};

use crate::review::find_craft_root;

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
    /// craft's plugin root, whose `lib/craft-externals.mjs` finds the candidates; found above the
    /// executable when absent.
    #[arg(long, env = "CRAFT_ROOT")]
    pub craft_root: Option<PathBuf>,
}

/// `~/.craft`, from `HOME`.
fn craft_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| Path::new(&h).join(".craft"))
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
    let projects = craft_home().context("HOME is not set")?.join("projects");
    let (path, common) = project::profile_path(&projects, &args.cwd)
        .with_context(|| format!("reading the repository {}", args.cwd.display()))?;
    if args.write {
        let points = args
            .points
            .iter()
            .map(|p| IntegrationPoint::parse(p).map_err(anyhow::Error::msg))
            .collect::<Result<Vec<_>>>()?;
        let profile = ProjectProfile::new(common, points)?;
        project::save(&path, &profile)?;
        return print(&json!({"profile": path, "integrations": profile.integrations}));
    }
    let held = project::load(&path)?;
    let integrations = held
        .as_ref()
        .map(|p| p.integrations.clone())
        .unwrap_or_default();
    let root = args.craft_root.clone().or_else(find_craft_root);
    let discovery = discover(root.as_deref(), &args.cwd, &integrations);
    print(&json!({
        "profile": path,
        "exists": held.is_some(),
        "integrations": integrations,
        "discovery": discovery,
        "write": "craft init --write --point <name>=<git url>@<tag or full commit> … (every point to keep; a branch is refused when a review prepares the sources)",
    }))
}

/// The discovery's answer over the repository at `cwd`, the profile's points left out as known;
/// `{"ran": false, "why": …}` when it cannot run (no plugin root, no node).
fn discover(root: Option<&Path>, cwd: &Path, known: &[IntegrationPoint]) -> Value {
    match run_discovery(root, cwd, known) {
        Ok(mut v) => {
            if let Some(o) = v.as_object_mut() {
                o.insert("ran".into(), Value::Bool(true));
            }
            v
        }
        Err(e) => json!({"ran": false, "why": format!("{e:#}")}),
    }
}

fn run_discovery(root: Option<&Path>, cwd: &Path, known: &[IntegrationPoint]) -> Result<Value> {
    let root = root.context("no craft plugin root: pass --craft-root")?;
    let script = root.join("lib/craft-externals.mjs");
    anyhow::ensure!(
        script.is_file(),
        "no lib/craft-externals.mjs under {}",
        root.display()
    );
    let top = git::toplevel(cwd)?;
    let records: Vec<Value> = known
        .iter()
        .map(|p| json!({"system": p.name, "repo": p.repo, "version": p.rev}))
        .collect();
    let mut child = Command::new("node")
        .arg(&script)
        .args(["discover", "--repo-root"])
        .arg(&top)
        .args(["--known", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("running node")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(serde_json::to_string(&records)?.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    let answer: Value = serde_json::from_slice(&out.stdout).with_context(|| {
        format!(
            "the discovery printed no JSON: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })?;
    match answer.get("error") {
        Some(e) => anyhow::bail!("the discovery refused: {e}"),
        None => Ok(answer),
    }
}
