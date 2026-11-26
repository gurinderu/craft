//! `craft init`: the reviewer's project profile (realm @nick/craft, node #467), asked for inside an
//! agent session, where the binary cannot prompt. `--propose` prints what the profile holds, the
//! project memory's `external` records the session pipes in, each with the revision its version
//! file names now (node #470, option (a); [`memory`]), and the candidates the repository's
//! deployment manifests name (the native discovery of `craft_review::externals`, node #435) as JSON; the
//! host session asks the reviewer which systems the code talks to and at which deployed tag or
//! commit, then `--write` stores exactly those. Beside them, the CI map (node #482): the checks
//! of the repository's workflows that carry clippy, test, fmt or build, which the gate reads when
//! it cannot build the head itself; `--propose` prints their candidates, the session confirms each
//! with the reviewer (node #483), and `--write --ci` records them ([`ci`]). And the lens
//! composition (node #647): `--propose` prints each lens's yield over the repository's runs and the
//! lenses it offers to hold or turn off, `--write --lens` records what the reviewer confirmed
//! ([`lenses`]); beside it the `[mutants]` section, shown as held and written by `--mutants` and
//! `--mutants-budget` ([`mutants`]).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use craft_review::consumers::cbm;
use craft_review::git;
use craft_review::project::{self, IntegrationPoint, ProjectProfile};
use craft_review::sources::{self, Git, SourcesSetup};
use serde_json::{Value, json};

mod ci;
mod graph;
mod lenses;
mod memory;
mod mutants;
mod paths;

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
    #[arg(
        long = "point",
        conflicts_with = "propose",
        value_name = "NAME=URL@REF"
    )]
    pub points: Vec<String>,
    /// A CI map entry as JSON: a fresh confirmation `{"check","signal","command","workflow",
    /// "sources"}`, its files hashed at the write, or a held entry exactly as `--propose` prints it
    /// in `ci`, its hashes kept (one printed with `unusable` is dropped or replaced, never passed
    /// back); repeatable. The map is replaced like the points.
    #[arg(long = "ci", conflicts_with = "propose", value_name = "JSON")]
    pub ci: Vec<String>,
    /// A lens of the composition: `<profile:lens>=<always|first-round|off>`, a held one as
    /// `--propose` prints it in `lenses.held`; repeatable. The section is replaced like the points:
    /// none names an empty one. Refused whole as a review would refuse it.
    #[arg(
        long = "lens",
        conflicts_with = "propose",
        value_name = "PROFILE:LENS=STATE"
    )]
    pub lenses: Vec<String>,
    /// Whether the change's mutants run on this repository; absent, they run (`on`). The section
    /// is replaced like the points: neither this nor `--mutants-budget` writes the defaults.
    #[arg(
        long = "mutants",
        conflicts_with = "propose",
        value_enum,
        value_name = "ON|OFF"
    )]
    pub mutants: Option<mutants::Switch>,
    /// How long the change's mutants may run, in seconds; absent, the review's default.
    #[arg(
        long = "mutants-budget",
        conflicts_with = "propose",
        value_name = "SECONDS",
        value_parser = clap::value_parser!(u64).range(1..=i64::MAX.unsigned_abs())
    )]
    pub mutants_budget: Option<u64>,
    /// The project memory's `external` records as JSON on stdin (`-`, the only value): each one is
    /// proposed as an integration point with the revision its version file names now.
    #[arg(long = "memory-externals", conflicts_with = "write", value_name = "-")]
    pub memory_externals: Option<String>,
    /// A deployment manifest to read, relative to the repository's top or absolute inside it;
    /// repeatable, at most 24. Named, they are read in the order given in place of the walk:
    /// the way to a manifest past its bound.
    #[arg(long = "path", conflicts_with = "write", value_name = "MANIFEST")]
    pub paths: Vec<String>,
    /// Accepted for older callers; native proposal discovery does not need a plugin root.
    #[arg(long, env = "CRAFT_ROOT")]
    pub craft_root: Option<PathBuf>,
}

/// `~/.craft`, under the home the run store is under (`HOME`, else the passwd entry).
fn craft_home() -> Option<PathBuf> {
    craft_store::read::home().map(|h| h.join(".craft"))
}

/// `~/.craft/projects`, where each repository's profile is.
pub fn projects_dir() -> Option<PathBuf> {
    craft_home().map(|h| h.join("projects"))
}

/// `~/.craft/worktrees`, where craft lays its own worktree of a pull request under review.
pub fn worktrees_dir() -> Option<PathBuf> {
    craft_home().map(|h| h.join("worktrees"))
}

/// Where a run started from this process finds the reviewer's profile and the sources cache.
pub fn sources_setup() -> Option<SourcesSetup> {
    let home = craft_store::read::home();
    let set = std::env::var("CRAFT_SOURCES_DIR").ok();
    Some(SourcesSetup {
        projects: craft_home()?.join("projects"),
        cache: sources::cache_root(set.as_deref(), home.as_deref()),
        git: Git::prompt_free(),
        // `CRAFT_CODE_GRAPH` names another program; set empty, none is asked.
        code_graph: std::env::var("CRAFT_CODE_GRAPH").unwrap_or_else(|_| cbm::TOOL.to_owned()),
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
        let mut profile = ProjectProfile::new(common, points, entries)?;
        profile.lenses = lenses::confirmed(&args.lenses)?;
        profile.mutants = mutants::confirmed(args.mutants, args.mutants_budget)?;
        let held = project::load(&path)
            .map(|p| p.and_then(|p| p.code_graph))
            .map_err(|e| e.to_string());
        let (graph, says) = graph::recorded(cbm::look(cbm::TOOL, &args.cwd), held);
        profile.code_graph.clone_from(&graph);
        project::save(&path, &profile)?;
        return print(&json!({
            "profile": path,
            "integrations": profile.integrations,
            "ci": profile.ci,
            "lenses": profile.lenses,
            "mutants": mutants::proposed(&path),
            "codeGraph": graph,
            "codeGraphSays": says,
        }));
    }
    let named = if args.paths.is_empty() {
        None
    } else {
        paths::named(&git::toplevel(&args.cwd)?, &args.paths)?
    };
    let held = project::load(&path)?;
    let integrations = held
        .as_ref()
        .map(|p| p.integrations.clone())
        .unwrap_or_default();
    let held_ci = held.as_ref().map(|p| p.ci.clone()).unwrap_or_default();
    let recalled = memory::recalled(args.memory_externals.as_deref())?;
    let imported = memory::import(&args.cwd, &recalled, &integrations);
    let discovery = discover(&args.cwd, &integrations, &recalled, named.as_deref());
    print(&json!({
        "profile": path,
        "exists": held.is_some(),
        "integrations": integrations,
        "memory": imported,
        "discovery": discovery,
        "ci": ci::held(&held_ci, &args.cwd),
        "ciCandidates": ci::proposed(&args.cwd),
        "lenses": lenses::proposed(&args.cwd, &path)?,
        "mutants": mutants::proposed(&path),
        "codeGraph": held.as_ref().and_then(|p| p.code_graph.clone()),
        "codeGraphSays": graph::live_says(
            cbm::look(cbm::TOOL, &args.cwd),
            held.as_ref().and_then(|p| p.code_graph.as_ref()),
        ),
        "write": "craft init --write --point <name>=<git url>@<tag or full commit> … --ci '<entry JSON>' … --lens <profile:lens>=<state> … [--mutants off] [--mutants-budget <seconds>] (every point, CI entry and lens to keep, a held lens as `lenses.held` prints it, the mutants as `mutants.flags` prints them, a held entry as `ci` prints it, one with `unusable` dropped or replaced; a branch is refused when a review prepares the sources)",
    }))
}

/// `answer` marked as having run, or `{"ran": false, "why": …}` when it could not.
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
/// `recalled` records left out as known; `named`, the manifests to read in place of the walk.
fn discover(
    cwd: &Path,
    known: &[IntegrationPoint],
    recalled: &memory::Recalled,
    named: Option<&[craft_store::js::JsString]>,
) -> Value {
    let mut records: Vec<Value> = known
        .iter()
        .map(|p| json!({"system": p.name, "repo": p.repo, "version": p.rev}))
        .collect();
    records.extend(memory::listed(recalled));
    ran(externals(
        cwd,
        &["discover", "--known", "-"],
        &Value::Array(records),
        named,
    ))
}

/// What `craft_review::externals` answers for `<verb>` over the repository's top, `stdin` its
/// records as JSON, `named` the manifests a discovery reads in place of the walk; a refusal is an
/// error.
fn externals(
    cwd: &Path,
    args: &[&str],
    stdin: &Value,
    named: Option<&[craft_store::js::JsString]>,
) -> Result<Value> {
    let top = git::toplevel(cwd)?;
    let input = craft_store::js::Js::from(stdin);
    let verb = args.first().context("no verb")?;
    let answer = if *verb == "memory" {
        craft_review::externals::import(&top, &input)
    } else {
        craft_review::externals::discover(
            &top,
            named,
            craft_review::externals::record_list(&input).unwrap_or(&[]),
        )
    }
    .map_err(|e| {
        anyhow::anyhow!(
            "craft's native external {verb} (craft_review::externals) refused: {}",
            craft_store::js::Js::str(e.message()).compact()
        )
    })?;
    Ok(Value::try_from(&answer)?)
}
