//! `craft runs`: the run store (`~/.craft/runs`) read by streaming its files — no SQL engine
//! (realm @nick/craft, nodes #535, #540). Each command prints a table, or NDJSON with `--json` for
//! jq; a line or record that does not read is passed over and counted on stderr.

mod render;
pub(crate) mod write;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use clap::builder::TypedValueParser;
use craft_store::filter::Filter;
use craft_store::js::{Js, Obj};
use craft_store::parts::Parts;
use craft_store::read::{self, Skipped};
use craft_store::tally::Tally;

#[derive(Debug, clap::Args)]
pub struct StoreArg {
    /// The run store; `~/.craft/runs` when absent.
    #[arg(long, global = true, value_parser = path_value())]
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

fn path_value() -> impl TypedValueParser<Value = PathBuf> {
    clap::builder::OsStringValueParser::new().map(PathBuf::from)
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
    /// Confirmed findings recurring across branches of this project; always one JSON object.
    Recurring {
        /// The repository (default: the working directory); linked worktrees share its key.
        #[arg(long, value_parser = path_value())]
        project: Option<PathBuf>,
        /// Only findings within this file or directory; repeat to include more paths.
        #[arg(long = "path")]
        paths: Vec<String>,
    },
    /// Once a Workflow run has ended, folds its real cost — counted from the harness's per-agent
    /// transcripts — into each record it filed, each record its own slice of the run's agents.
    /// `--run-dir <d> --record <f>` instead sums every transcript of one directory into one
    /// record, as for a record whose run cannot be sliced.
    EnrichCost {
        /// The run id the Workflow completion names (`wf_…`).
        #[arg(long, required_unless_present = "run_dir", conflicts_with_all = ["run_dir", "record"])]
        run_id: Option<String>,
        /// Where Claude Code keeps its transcripts; `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
        #[arg(long, value_parser = path_value(), conflicts_with = "run_dir")]
        claude_home: Option<PathBuf>,
        /// A run's transcript directory, every `agent-*.jsonl` of it summed into `--record`.
        #[arg(long, value_parser = path_value(), requires = "record")]
        run_dir: Option<PathBuf>,
        /// The record the directory's cost is folded into.
        #[arg(long, value_parser = path_value(), requires = "run_dir")]
        record: Option<PathBuf>,
    },
    /// The reviewer's choice for doubtful finding `n` of a review run with comment, into that
    /// run's record: the one `--record` names, else the newest of this branch carrying doubtful findings.
    SortingChoice {
        #[arg(long)]
        n: String,
        /// question, defect or dropped.
        #[arg(long)]
        choice: String,
        #[arg(long, value_parser = path_value())]
        record: Option<PathBuf>,
        /// The repository (default: the working directory).
        #[arg(long, value_parser = path_value())]
        project: Option<PathBuf>,
    },
    /// One craft:develop cycle, read from stdin (`{mode?, outcome, rounds, fullReviews?}`), filed
    /// as a `develop` record of this repository.
    DevelopCycle {
        /// The repository (default: the working directory).
        #[arg(long, value_parser = path_value())]
        project: Option<PathBuf>,
        /// The harness session the cycle ran in.
        #[arg(long)]
        session: Option<String>,
    },
}

#[derive(Debug, clap::Args)]
pub struct RunsArgs {
    #[command(flatten)]
    pub at: StoreArg,
    #[command(subcommand)]
    pub command: RunsCommand,
}

fn store_of(args: &RunsArgs) -> Result<PathBuf> {
    args.at.store
        .clone()
        .filter(|p| !matches!(args.command, RunsCommand::Recurring { .. }) || !p.as_os_str().is_empty())
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
    let store = store_of(args)?;
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
            let found = craft_store::check::check(&store)
                .with_context(|| format!("checking {}", store.display()))?;
            render::check(&mut out, &found, args.at.json)?;
            skipped = found.skipped.clone();
            if found.clean() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        RunsCommand::Retro { version } => {
            let retro = retro(&store, version, &mut skipped)?;
            render::retro(&mut out, version, &retro, args.at.json)?;
            ExitCode::SUCCESS
        }
        RunsCommand::Recurring { project, paths } => {
            let project = project
                .clone()
                .filter(|p| !p.as_os_str().is_empty())
                .map_or_else(std::env::current_dir, Ok)?;
            let result = craft_review::recurring::recurring(&store, &project, paths)?;
            writeln!(out, "{}", result.pretty())?;
            ExitCode::SUCCESS
        }
        RunsCommand::EnrichCost {
            run_id,
            claude_home,
            run_dir,
            record,
        } => match (run_id, run_dir, record) {
            (_, Some(dir), Some(record)) => write::enrich_dir(&store, dir, record)?,
            (Some(id), _, _) => write::enrich_cost(&store, id, claude_home.as_deref())?,
            _ => bail!("enrich-cost takes --run-id <wf_…>, or --run-dir <d> --record <f>"),
        },
        RunsCommand::SortingChoice {
            n,
            choice,
            record,
            project,
        } => write::sorting_choice(&store, n, choice, record.as_deref(), project.as_deref())?,
        RunsCommand::DevelopCycle { project, session } => {
            write::develop_cycle(&store, project.as_deref(), session.as_deref())?
        }
    };
    said_skipped(&skipped);
    Ok(code)
}

fn retro(store: &Path, version: &str, skipped: &mut Skipped) -> Result<craft_store::retro::Retro> {
    let mut out = craft_store::retro::Retro::default();
    let mut newest = std::collections::BTreeMap::<String, (String, String)>::new();
    let mut parts = Parts::default();
    let mut failure = None;
    read::records(store, skipped, |name, r| {
        let died = r.get("partial").is_some_and(Js::truthy);
        if r.get("schemaVersion").is_some_and(Js::truthy) && !died {
            parts.note(&r);
        }
        let inside = r.text_units("craftVersion") == version;
        if r.get("schemaVersion").is_some_and(Js::truthy)
            && !died
            && held(&mut parts, (name, &r, inside), &mut failure)
        {
            // Counted, or folded, once every record is read, as the run's standing part is.
            out.other += u64::from(!inside);
        } else if !r.get("schemaVersion").is_some_and(Js::truthy) || !inside {
            out.other += 1;
        } else if died {
            out.unfinished += 1;
        } else if let Some(key) = craft_store::retro::run_key(&r) {
            let ts = match r.try_text("ts") {
                Ok(ts) => ts.to_owned(),
                Err(e) => {
                    failure = Some(e);
                    return;
                }
            };
            match newest.entry(key) {
                std::collections::btree_map::Entry::Vacant(e) => {
                    e.insert((ts, name.to_owned()));
                }
                std::collections::btree_map::Entry::Occupied(mut e) => {
                    out.folded += 1;
                    if ts > e.get().0 {
                        e.insert((ts, name.to_owned()));
                    }
                }
            }
        } else if let Err(e) = craft_store::retro::add_record(&mut out, &r) {
            failure = Some(e);
        }
    })
    .with_context(|| format!("reading {}", store.display()))?;
    if let Some(e) = failure {
        return Err(e.into());
    }
    for (key, (ts, name)) in newest {
        match read::record(store, &name) {
            Ok(r)
                if r.text_units("ts") == ts
                    && r.text_units("craftVersion") == version
                    && r.get("schemaVersion").is_some_and(Js::truthy)
                    && !r.get("partial").is_some_and(Js::truthy)
                    && craft_store::retro::run_key(&r).as_ref() == Some(&key) =>
            {
                craft_store::retro::add_record(&mut out, &r)?;
            }
            Ok(_) => skipped
                .records
                .push((name, "record changed while reading".into())),
            Err(why) => skipped.records.push((name, why)),
        }
    }
    let (standing, folded) = parts.standing();
    out.folded += folded;
    let of_version = |r: &Obj| r.text_units("craftVersion") == version;
    for r in read_back(store, standing, skipped, of_version) {
        craft_store::retro::add_record(&mut out, &r)?;
    }
    Ok(out)
}

/// Whether `r` is a stopped part `parts` holds back until every record is read
/// ([`craft_store::parts`]); a time that does not read is kept as the read's failure.
fn held(
    parts: &mut Parts,
    (name, r, inside): (&str, &Obj, bool),
    failure: &mut Option<craft_store::js::Utf16Error>,
) -> bool {
    parts.hold(name, r, inside).unwrap_or_else(|e| {
        *failure = Some(e);
        true
    })
}

/// The held records read again, each still the stopped part of its run filed at its time that did
/// not die and that `keep` keeps; one changed or gone is said passed over.
fn read_back(
    store: &Path,
    held: Vec<(String, String, String)>,
    skipped: &mut Skipped,
    keep: impl Fn(&Obj) -> bool,
) -> Vec<Obj> {
    let same = |r: &Obj, key: &str, ts: &str| {
        r.text_units("ts") == ts
            && r.get("schemaVersion").is_some_and(Js::truthy)
            && !r.get("partial").is_some_and(Js::truthy)
            && craft_store::parts::stopped(r)
            && craft_store::parts::part_key(r).as_deref() == Some(key)
            && keep(r)
    };
    let mut out = Vec::new();
    for (key, ts, name) in held {
        match read::record(store, &name) {
            Ok(r) if same(&r, &key, &ts) => out.push(r),
            Ok(_) => skipped
                .records
                .push((name, "record changed while reading".into())),
            Err(why) => skipped.records.push((name, why)),
        }
    }
    out
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
    let mut newest: std::collections::BTreeMap<String, (String, String)> =
        std::collections::BTreeMap::new();
    let mut parts = Parts::default();
    let mut failure = None;
    read::records(store, skipped, |name, r| {
        let finished = r.get("schemaVersion").is_some_and(Js::truthy)
            && !r.get("partial").is_some_and(Js::truthy);
        if finished {
            parts.note(&r);
        }
        if !finished {
            return;
        }
        let inside = filter.keeps(&r);
        if held(&mut parts, (name, &r, inside), &mut failure) || !inside {
            return;
        }
        if let Some(key) = craft_store::retro::run_key(&r) {
            let ts = match r.try_text("ts") {
                Ok(ts) => ts.to_owned(),
                Err(e) => {
                    failure = Some(e);
                    return;
                }
            };
            let entry = newest
                .entry(key)
                .or_insert_with(|| (ts.clone(), name.to_owned()));
            if ts > entry.0 {
                *entry = (ts, name.to_owned());
            }
        } else if let Err(e) = tally_record(&mut groups, by, &r) {
            failure = Some(e);
        }
    })
    .with_context(|| format!("reading {}", store.display()))?;
    if let Some(e) = failure {
        return Err(e.into());
    }
    for (key, (ts, name)) in newest {
        match read::record(store, &name) {
            Ok(r)
                if r.text_units("ts") == ts
                    && craft_store::retro::run_key(&r).as_ref() == Some(&key)
                    && filter.keeps(&r) =>
            {
                tally_record(&mut groups, by, &r)?;
            }
            Ok(_) => skipped
                .records
                .push((name, "record changed while reading".into())),
            Err(why) => skipped.records.push((name, why)),
        }
    }
    for r in read_back(store, parts.standing().0, skipped, |r| filter.keeps(r)) {
        tally_record(&mut groups, by, &r)?;
    }
    Ok(groups.into_iter().collect())
}

fn tally_record(
    groups: &mut std::collections::BTreeMap<String, Tally>,
    by: By,
    r: &Obj,
) -> Result<(), craft_store::js::Utf16Error> {
    let key = match by {
        By::Version => r.try_text("craftVersion")?,
        By::Name => r.try_text("name")?,
        By::Project => r.try_text("project")?,
    };
    let key = if key.is_empty() { "(none)" } else { key };
    groups.entry(key.to_owned()).or_default().add(r);
    Ok(())
}
