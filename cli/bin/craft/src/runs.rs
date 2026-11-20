//! `craft runs`: the run store (`~/.craft/runs`) read by streaming its files — no SQL engine
//! (realm @nick/craft, nodes #535, #540). Each command prints a table, or NDJSON with `--json` for
//! jq; a line or record that does not read is passed over and counted on stderr.

mod render;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use craft_store::filter::Filter;
use craft_store::js::{Js, Obj};
use craft_store::read::{self, Skipped};
use craft_store::tally::Tally;

#[derive(Debug, clap::Args)]
pub struct StoreArg {
    /// The run store; `~/.craft/runs` when absent.
    #[arg(long, global = true)]
    pub store: Option<PathBuf>,
    /// NDJSON, one object per line, instead of a table.
    #[arg(long, global = true)]
    pub json: bool,
}

#[derive(Debug, clap::Args)]
pub struct FilterArgs {
    /// The repository: its key, or its last path component(s).
    #[arg(long)]
    pub project: Option<String>,
    #[arg(long)]
    pub branch: Option<String>,
    /// The workflow name: review, triage-findings, rust-audit, …
    #[arg(long)]
    pub name: Option<String>,
    /// The craft version.
    #[arg(long)]
    pub version: Option<String>,
    /// Runs at or after this time (a prefix of `2026-11-01T10:00:00Z`).
    #[arg(long)]
    pub since: Option<String>,
    /// Runs before this time.
    #[arg(long)]
    pub until: Option<String>,
    /// A piece of the verdict, case folded: block, warning, approve, incomplete.
    #[arg(long)]
    pub verdict: Option<String>,
}

impl FilterArgs {
    fn filter(&self) -> Filter {
        Filter {
            project: self.project.clone(),
            branch: self.branch.clone(),
            name: self.name.clone(),
            version: self.version.clone(),
            since: self.since.clone(),
            until: self.until.clone(),
            verdict: self.verdict.clone(),
        }
    }
}

/// What a `stats` row groups by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum By {
    Version,
    Name,
    Project,
}

#[derive(Debug, clap::Subcommand)]
pub enum RunsCommand {
    /// The runs the index holds, oldest first.
    Ls {
        #[command(flatten)]
        filter: FilterArgs,
        /// Only the newest this many.
        #[arg(long)]
        limit: Option<usize>,
    },
    /// One run's record: its file name, or a unique prefix of its time.
    Show { id: String },
    /// The finished runs summed per group: verdicts, findings by severity, the verified share,
    /// triage totals.
    Stats {
        #[arg(long, value_enum, default_value_t = By::Version)]
        by: By,
        #[command(flatten)]
        filter: FilterArgs,
    },
    /// What is wrong with the store: unreadable index lines, records the index does not name and
    /// lines whose record is gone, INCOMPLETE records beside a finished run, finished runs with no
    /// record, checkpoint directories left behind. Exits 1 when it finds any.
    Check,
    /// A version's retro: its finished runs per workflow, engine and lens, and what did not run.
    Retro { version: String },
}

#[derive(Debug, clap::Args)]
pub struct RunsArgs {
    #[command(flatten)]
    pub at: StoreArg,
    #[command(subcommand)]
    pub command: RunsCommand,
}

fn store_of(at: &StoreArg) -> Result<PathBuf> {
    at.store
        .clone()
        .or_else(read::home_store)
        .context("neither HOME nor the passwd entry names a home, so there is no ~/.craft/runs; pass --store")
}

/// Says on stderr what a read passed over.
fn said_skipped(skipped: &Skipped) {
    let mut err = std::io::stderr().lock();
    if !skipped.lines.is_empty() {
        let lines: Vec<String> = skipped.lines.iter().map(ToString::to_string).collect();
        drop(writeln!(
            err,
            "craft runs: passed over {} index line(s) that are not a JSON object (line {})",
            lines.len(),
            lines.join(", ")
        ));
    }
    for (name, why) in &skipped.records {
        drop(writeln!(
            err,
            "craft runs: passed over the record {name}: {why}"
        ));
    }
}

pub fn runs(args: &RunsArgs) -> Result<ExitCode> {
    match printed(args) {
        // A reader that stopped reading (`| head`) ends the listing, not as a failure.
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::BrokenPipe) =>
        {
            Ok(ExitCode::SUCCESS)
        }
        other => other,
    }
}

fn printed(args: &RunsArgs) -> Result<ExitCode> {
    let store = store_of(&args.at)?;
    let mut out = std::io::stdout().lock();
    let mut skipped = Skipped::default();
    let code = match &args.command {
        RunsCommand::Ls { filter, limit } => {
            let rows = listed(&store, &filter.filter(), *limit, &mut skipped)?;
            render::ls(&mut out, &rows, args.at.json)?;
            ExitCode::SUCCESS
        }
        RunsCommand::Show { id } => {
            let record = shown(&store, id)?;
            let text = if args.at.json {
                record.compact()
            } else {
                record.pretty()
            };
            writeln!(out, "{text}")?;
            ExitCode::SUCCESS
        }
        RunsCommand::Stats { by, filter } => {
            let groups = stats(&store, *by, &filter.filter(), &mut skipped)?;
            render::stats(&mut out, &groups, args.at.json)?;
            ExitCode::SUCCESS
        }
        RunsCommand::Check => {
            let found = craft_store::check::check(&store)?;
            render::check(&mut out, &found, args.at.json)?;
            skipped = found.skipped.clone();
            if found.clean() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        RunsCommand::Retro { version } => {
            let mut all = Vec::new();
            read::records(&store, &mut skipped, |_, r| all.push(r))?;
            let retro = craft_store::retro::retro(version, all);
            render::retro(&mut out, version, &retro, args.at.json)?;
            ExitCode::SUCCESS
        }
    };
    said_skipped(&skipped);
    Ok(code)
}

fn listed(
    store: &Path,
    filter: &Filter,
    limit: Option<usize>,
    skipped: &mut Skipped,
) -> Result<Vec<Obj>> {
    let mut rows = Vec::new();
    read::index(store, skipped, |_, row| {
        if filter.keeps(&row) {
            rows.push(row);
        }
    })
    .with_context(|| format!("reading {}", store.join("index.jsonl").display()))?;
    if let Some(n) = limit {
        let from = rows.len().saturating_sub(n);
        rows.drain(..from);
    }
    Ok(rows)
}

fn shown(store: &Path, id: &str) -> Result<Js> {
    let names =
        read::record_names(store).with_context(|| format!("listing {}", store.display()))?;
    let want = id.trim_end_matches(".json").replace(':', "-");
    let hits: Vec<&String> = names.iter().filter(|n| n.starts_with(&want)).collect();
    let name = match hits.as_slice() {
        [one] => *one,
        [] => bail!("no record in {} is {id}", store.display()),
        many => {
            let some: Vec<&str> = many.iter().take(5).map(|s| s.as_str()).collect();
            bail!(
                "{id} names {} records ({}, …): give more of it",
                many.len(),
                some.join(", ")
            )
        }
    };
    read::record(store, name)
        .map(Js::Obj)
        .map_err(|why| anyhow::anyhow!("{name}: {why}"))
}

/// The finished runs, by group, each summed.
fn stats(
    store: &Path,
    by: By,
    filter: &Filter,
    skipped: &mut Skipped,
) -> Result<Vec<(String, Tally)>> {
    let mut groups: std::collections::BTreeMap<String, Tally> = std::collections::BTreeMap::new();
    let mut records = Vec::new();
    read::records(store, skipped, |_, r| {
        let finished = r.get("schemaVersion").is_some_and(Js::truthy)
            && !r.get("partial").is_some_and(Js::truthy);
        if !finished || !filter.keeps(&r) {
            return;
        }
        records.push(r);
    })
    .with_context(|| format!("reading {}", store.display()))?;
    for r in craft_store::retro::fold_runs(records) {
        let key = match by {
            By::Version => r.text("craftVersion"),
            By::Name => r.text("name"),
            By::Project => r.text("project"),
        };
        let key = if key.is_empty() { "(none)" } else { key };
        groups.entry(key.to_owned()).or_default().add(&r);
    }
    Ok(groups.into_iter().collect())
}
