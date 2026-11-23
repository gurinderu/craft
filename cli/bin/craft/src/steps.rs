//! `craft review start | submit | status`: the step protocol (realm @nick/craft, node #453) on the
//! command line. Each prints one JSON value on stdout; an error is one line on stderr and a
//! non-zero exit (`main`).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use craft_review::{filing, prompts, status, step};
use serde_json::{Map, Value, json};

use crate::review::find_craft_root;

/// `craft review start` as the command line takes it: the run's options, and how its step is
/// printed.
#[derive(Debug, clap::Args)]
pub struct StartCommand {
    #[command(flatten)]
    pub start: StartArgs,
    #[command(flatten)]
    pub paging: crate::paged::Paging,
}

#[derive(Debug, clap::Args)]
pub struct StartArgs {
    /// The repository to review.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// What the changes are measured against; the merge-base with origin's default branch when
    /// absent.
    #[arg(long)]
    pub base: Option<String>,
    /// Where the run keeps its state; a new directory under ~/.craft/runs/cli when absent.
    #[arg(long)]
    pub run_dir: Option<PathBuf>,
    /// craft's plugin root, named in the prompts; found above the executable when absent.
    #[arg(long, env = "CRAFT_ROOT")]
    pub craft_root: Option<PathBuf>,
    /// `light`: the diff-scoped lenses, one round, only Medium and above verified; `full`: the
    /// whole review.
    #[arg(long, value_enum, default_value_t = Depth::Full)]
    pub depth: Depth,
    /// Start a new chain of review rounds: build on no earlier round of this branch.
    #[arg(long)]
    pub fresh: bool,
    /// The run reviews only the fix commits since an earlier review (its base that review's
    /// commit): a delta round, whose clean verdict is a Warning, never Approve.
    #[arg(long)]
    pub delta: bool,
    /// Every this-many-th round of a branch's chain reviews the whole diff again rather than the
    /// fix commits since the prior round; 0, never.
    #[arg(long, default_value_t = 3)]
    pub full_every: u32,
    /// Where the earlier runs a re-review builds on are looked for; the run directory's parent
    /// (~/.craft/runs/cli by default) when absent.
    #[arg(long)]
    pub runs: Option<PathBuf>,
    /// Strict mode: a confirmed maintainability finding at Medium or above is a presumptive
    /// blocker, and the maintainability lens always runs.
    #[arg(long)]
    pub strict: bool,
    /// The launcher's own decision, question and rule records (`priorDecisions`), a JSON list, as
    /// a file or `-` for stdin; they add to what the run recalls from the project's memory.
    #[arg(long)]
    pub prior_decisions: Option<PathBuf>,
    /// Recall nothing from the project's memory: only the records `--prior-decisions` passes
    /// apply (a launcher that recalled them itself).
    #[arg(long)]
    pub no_recall: bool,
    /// Why the launcher's recall may not have read the whole store (its backend query failed, its
    /// answer was truncated, its agent gave none): the run names it and reads as degraded. Only
    /// as `--recall-degraded=<text>`, so a text that starts with `-` is never read as a flag, nor
    /// the next flag as its text; a blank text is refused.
    #[arg(long, requires = "no_recall", require_equals = true, value_parser = recall_note)]
    pub recall_degraded: Option<String>,
    /// Run no mechanical gate: clippy and `nix flake check` build the branch's code (build scripts,
    /// proc macros, flake checks and a flake dev shell's `shellHook` run as you), so skip them for a branch you do not trust; the report
    /// names the gate as skipped.
    #[arg(long)]
    pub no_gate: bool,
    /// Take the gate `craft review gate` ran once for the whole change and kept in this directory,
    /// rather than run one: its tool seeds on this run's files reach the lenses, and the report's
    /// Gate section says where it came from. A result for another HEAD or merge-base is not used.
    #[arg(long, conflicts_with = "no_gate")]
    pub gate_from: Option<PathBuf>,
    /// The repository's own reviewing agents to run as extra lenses, each over the whole change:
    /// their names, separated by commas or spaces, or `off`. Absent, a light pass discovers them
    /// among the agents the session's project declares under `.claude/agents` (when `--cwd` is that
    /// project or one of its worktrees) and a full review runs none.
    #[arg(long)]
    pub extra_lenses: Option<String>,
    /// Unit mode, experimental and off by default: each sliceable lens confined to a batch of the
    /// crates the change touches, a contract lens per touched crate, and a coordinator after the
    /// rounds that answers the lenses' questions about other crates and judges the seam between
    /// them; a change it cannot slice runs in the normal mode with a warning saying why.
    #[arg(long)]
    pub unit_scope: bool,
    /// Review only the change under this directory (or file) of the repository, as a crate of an
    /// audit is reviewed: repository-relative, or absolute inside the repository. A run of one
    /// path builds only on an earlier round of the same path.
    #[arg(long)]
    pub path: Option<String>,
    /// Publish the findings on the checked-out branch's pull request when the run finishes: the
    /// defects posted as review comments with `gh` (one already there with the craft-finding
    /// marker is not posted again), the doubtful ones listed in the report for the reviewer.
    #[arg(long)]
    pub comment: bool,
    /// The optional pass, off by default: `all`, or the optional lenses to run, separated by
    /// commas (`api-idioms`, or qualified by its profile, `rust-api-idioms`). A name that is no
    /// optional lens is named in the report; the recognised ones still run.
    #[arg(long, value_name = "all|lens,…")]
    pub optional: Option<String>,
    /// A parent engine launched this run (rust-audit's per-crate reviews): it builds on no earlier
    /// round of the branch and files no round record, so a later run of the same path reviews it
    /// whole again.
    #[arg(long)]
    pub nested: bool,
    /// The pull request under review, whose head HEAD must be or hold: from a HEAD that does not
    /// hold it, craft fetches the head and reviews it in its own detached worktree, one per head and
    /// never moved, `~/.craft/worktrees/<repo key>/pr-<N>-<head>`, refusing the run before any task
    /// only where it cannot get the head there (realm `@nick/craft`, node #517). The gate and, on
    /// OpenCode or the claude-code backend, the host's own project config at the PR's head (its
    /// plugins, hooks, MCP servers) run the PR's code: review a PR you do not trust with
    /// `--no-gate` and on neither. On a detached HEAD its head branch keys the chain of review rounds. Absent, gh is
    /// asked for the open pull request whose head is HEAD.
    #[arg(long, value_name = "NUMBER")]
    pub pr: Option<u64>,
    /// File the run's telemetry under this craft version, as the review engine's own run: a
    /// checkpoint as each phase ends and the run record when it finishes, written into the run
    /// store (`~/.craft/runs`) by the binary itself. Absent, nothing is filed.
    #[arg(long, value_name = "CRAFT_VERSION")]
    pub record: Option<String>,
    /// The host the run's tasks run in, as its record names it (`runtime`): `craft review run`
    /// sets its backend; absent, the record names `claude-code`, whose engine drives `start` itself.
    #[arg(skip)]
    pub runtime: Option<String>,
    /// The parent engine a nested run's record is filed under.
    #[arg(long, requires = "record")]
    pub via: Option<String>,
    /// The craft plugin root the run's records are stamped with (`craftCommit`, its commit when it
    /// is a checkout), when it is not the one the prompts name (`--craft-root`, else the one above
    /// the binary). It names nothing in the prompts, and the run files without it.
    #[arg(long, requires = "record")]
    pub record_root: Option<PathBuf>,
}

/// How deep a review goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Depth {
    Full,
    Light,
}

#[derive(Debug, clap::Args)]
pub struct SubmitArgs {
    /// The run directory `start` printed.
    #[arg(long)]
    pub run: PathBuf,
    /// A JSON object of answers by task id, as a file or `-` for stdin, in place of the answer
    /// files the tasks' agents wrote under the run's `answers/`.
    #[arg(long)]
    pub answers: Option<PathBuf>,
    /// How the host ran this step's tasks weaker than asked (a task run without the agent it
    /// named); repeatable. Each is kept and named in the report and the finished step.
    #[arg(long)]
    pub degraded: Vec<String>,
    /// The account's usage limit, as an agent's error or short answer said it: the run keeps the
    /// answers that came in and stops, INCOMPLETE, with its unanswered tasks held; once the limit
    /// resets, `--resume` goes on with the run.
    #[arg(long)]
    pub limit: Option<String>,
    /// The host resumes a run it lost (a stop it could not report, an interrupted host): an answer
    /// missing now is handed out again rather than counted as a failed attempt.
    #[arg(long)]
    pub resume: bool,
    /// A task whose agent the host abandoned at its deadline; repeatable. It fails at once and is
    /// not handed out again, and an answer its agent writes later is never read.
    #[arg(long)]
    pub abandoned: Vec<String>,
    /// For the run's telemetry (`start --record`): the task agents the host has dispatched so far.
    #[arg(long)]
    pub agents: Option<u64>,
    /// For the run's telemetry: the output tokens the host reports — with `--output-tokens-scope
    /// turn-delta`, the turn's shared pool grown while its engine ran; without it, an older host's
    /// session total.
    #[arg(long)]
    pub output_tokens: Option<u64>,
    /// What `--output-tokens` counts, stamped on the record as `outputTokensScope`: `turn-delta`,
    /// the turn's shared pool grown while the host's engine ran. Without it the record carries no
    /// scope, as an older host's session total does.
    #[arg(long, value_parser = ["turn-delta"], requires = "output_tokens")]
    pub output_tokens_scope: Option<String>,
    /// The craft plugin root the run's records are stamped with, for a run whose telemetry knows
    /// none (started with none known, or its own uninstalled): kept from now on. It names nothing
    /// in the prompts.
    #[arg(long)]
    pub record_root: Option<PathBuf>,
    #[command(flatten)]
    pub paging: crate::paged::Paging,
}

#[derive(Debug, clap::Args)]
pub struct StatusArgs {
    /// The run directory `start` printed.
    #[arg(long)]
    pub run: PathBuf,
    /// Only what no finding count grows: the phase, round, verdict, verdict line, report and
    /// whether the record is filed, without the finished step the status embeds.
    #[arg(long)]
    pub brief: bool,
    #[command(flatten)]
    pub paging: crate::paged::Paging,
}

#[derive(Debug, clap::Args)]
pub struct GateArgs {
    /// The repository whose change is gated.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// What the changes are measured against; the merge-base with origin's default branch when
    /// absent.
    #[arg(long)]
    pub base: Option<String>,
    /// Where the tools' output is kept; a new directory under ~/.craft/runs/cli when absent.
    #[arg(long)]
    pub dir: Option<PathBuf>,
}

/// `value` on stdout as one JSON line, as the host is handed it ([`crate::printed::write_line`]).
pub(crate) fn print(value: &Value) -> Result<ExitCode> {
    crate::printed::write_line(&mut std::io::stdout().lock(), value)?;
    Ok(ExitCode::SUCCESS)
}

/// Whole milliseconds, saturated.
fn ms(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// A step stamped with the wall clock the host has none of (the workflow sandbox reads no clock):
/// `at`, when it was printed, and `took`, how long this command ran, both in milliseconds, from
/// which the host tells its runtime figures apart by phase.
pub(crate) fn stamped(mut step: Value, began: Instant) -> Value {
    // 0 on a clock set before the epoch: the host then reads no wall time from it.
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(ms)
        .unwrap_or_default();
    if let Some(obj) = step.as_object_mut() {
        obj.insert("at".into(), Value::from(at));
        obj.insert("took".into(), Value::from(ms(began.elapsed())));
    }
    step
}

/// A fresh run directory under `~/.craft/runs/cli`, named by the time and this process.
fn default_run_dir() -> Result<PathBuf> {
    run_dir_in(craft_store::read::home())
}

/// [`default_run_dir`] under `home` — the home the run store is under, so the two never split.
fn run_dir_in(home: Option<PathBuf>) -> Result<PathBuf> {
    let home = home.context("neither HOME nor the passwd entry names a home; pass --run-dir")?;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    Ok(Path::new(&home)
        .join(".craft/runs/cli")
        .join(format!("{secs}-{}", std::process::id())))
}

pub fn start(args: &StartCommand) -> Result<ExitCode> {
    let step = start_step(&args.start, &craft_review::cancel::Cancel::default())?;
    crate::paged::print(&step, &args.paging)
}

/// The step `start` prints, its telemetry opened when `--record` asks for it.
pub(crate) fn start_step(args: &StartArgs, cancel: &craft_review::cancel::Cancel) -> Result<Value> {
    let began = Instant::now();
    let root = args.craft_root.clone().or_else(find_craft_root);
    let (craft_root, craft_version) = match root {
        Some(r) => match prompts::craft_root_near(&r) {
            Some((root, version)) => (Some(root), version),
            None => (Some(r.display().to_string()), None),
        },
        None => (None, None),
    };
    let run_dir = match &args.run_dir {
        Some(d) => d.clone(),
        None => default_run_dir()?,
    };
    let opts = step::StartOptions {
        cwd: args.cwd.clone(),
        base: args.base.clone(),
        run_dir: std::path::absolute(&run_dir)
            .with_context(|| format!("resolving {}", run_dir.display()))?,
        craft_root,
        craft_version,
        light: args.depth == Depth::Light,
        fresh: args.fresh,
        delta: args.delta,
        full_every: args.full_every,
        runs: args.runs.clone(),
        strict: args.strict,
        recall: !args.no_recall,
        recall_degraded: args.recall_degraded.clone(),
        // An unreadable list is refused and named in the report; the review still runs.
        prior_decisions: args
            .prior_decisions
            .as_deref()
            .map(|p| json_input(p).map_err(|e| format!("{e:#}"))),
        sources: crate::init::sources_setup(),
        gate: (!args.no_gate).then(|| craft_review::gate::GateSetup {
            projects: crate::init::projects_dir(),
            ..craft_review::gate::GateSetup::default()
        }),
        gate_from: args
            .gate_from
            .as_deref()
            .map(std::path::absolute)
            .transpose()
            .context("resolving --gate-from")?,
        extra_lenses: args.extra_lenses.clone(),
        session: None,
        unit_scope: args.unit_scope,
        path: args.path.clone(),
        comment: args.comment,
        optional: args.optional.clone(),
        nested: args.nested,
        pr: args.pr,
        chain_gh: Some(craft_review::publish::PostSetup::default()),
        worktrees: crate::init::worktrees_dir(),
        runtime: args.runtime.clone(),
        cancel: cancel.clone(),
    };
    let step = stamped(step::start(&opts)?, began);
    Ok(match &args.record {
        Some(version) => opened(
            &opts.run_dir,
            version,
            (args.via.as_deref(), args.record_root.as_deref()),
            args.runtime.as_deref(),
            step,
        ),
        None => step,
    })
}

/// `craft review gate`: the mechanical gate alone, printed as one JSON value
/// ([`craft_review::gate::alone::alone`]); a red gate is an outcome, not an error, so it exits 0.
pub fn gate(args: &GateArgs) -> Result<ExitCode> {
    let began = Instant::now();
    let dir = match &args.dir {
        Some(d) => d.clone(),
        None => default_run_dir()?,
    };
    let dir = std::path::absolute(&dir).with_context(|| format!("resolving {}", dir.display()))?;
    let setup = craft_review::gate::GateSetup {
        projects: crate::init::projects_dir(),
        ..craft_review::gate::GateSetup::default()
    };
    let out = craft_review::gate::alone::alone(&args.cwd, args.base.as_deref(), &dir, &setup)?;
    print(&stamped(out, began))
}

/// The harness session the host runs in, stamped on the run's telemetry.
fn session() -> String {
    std::env::var("CLAUDE_CODE_SESSION_ID").unwrap_or_default()
}

/// The started `step` with its telemetry opened: the start checkpoint written, and the record when
/// the run ended at once. Its records are stamped with `record_root` when that is a plugin root,
/// else the root the prompts name, else one found ([`filing_root`]).
fn opened(
    run: &Path,
    version: &str,
    (via, record_root): (Option<&str>, Option<&Path>),
    runtime: Option<&str>,
    step: Value,
) -> Value {
    let filing = match craft_review::state::load(run) {
        Ok(state) => {
            let mut ctx = filing::Ctx::of(&state, version, via.unwrap_or_default());
            runtime.unwrap_or_default().clone_into(&mut ctx.runtime);
            let given = record_root.and_then(|r| std::path::absolute(r).ok());
            ctx.root = filing::found_root([given])
                .or(ctx.root)
                .or_else(|| filing_root(None));
            filing::open(
                run,
                ctx,
                &session(),
                &step,
                &crate::filing_worker::BoundedWriter,
            )
        }
        Err(e) => {
            json!({"runDir": "", "rejoin": false, "lost": [format!("the run's telemetry — {e}")]})
        }
    };
    filing::with_filing(step, filing)
}

/// The plugin root the run's records are stamped with when the run knows none: the one `given`,
/// the plugin root above the binary, the one the harness names (`CLAUDE_PLUGIN_ROOT`), else this
/// version's installed copy ([`installed_copy`]) — the first that is a plugin root; `None`, and the
/// records name no craft commit.
pub(crate) fn filing_root(given: Option<&Path>) -> Option<String> {
    let env = |k| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let given = given.and_then(|g| std::path::absolute(g).ok());
    let installed = installed_copy(env("CLAUDE_CONFIG_DIR"), env("HOME"));
    filing::found_root([
        given,
        find_craft_root(),
        env("CLAUDE_PLUGIN_ROOT"),
        installed,
    ])
}

/// This binary's version of the plugin as Claude Code installs it, under `config` (the session's
/// `CLAUDE_CONFIG_DIR`) else `home`'s `.claude`: the last place every plugin script is looked for
/// (integrations/shared/plugin-script.mjs), so a fetched binary under no plugin finds its root without the engine's
/// locate step (realm @nick/craft, node #524). The cache layout is the harness's (realm @nick/craft,
/// node #48), so a miss is ordinary.
fn installed_copy(config: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    let config = config.or_else(|| home.map(|h| h.join(".claude")))?;
    Some(
        config
            .join("plugins/cache/craft/craft")
            .join(env!("CARGO_PKG_VERSION")),
    )
}

/// A JSON value the host passes, as a file or `-` for stdin.
fn json_input(path: &Path) -> Result<Value> {
    let text = if path.as_os_str() == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .context("reading stdin")?;
        s
    } else {
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?
    };
    serde_json::from_str(&text).with_context(|| format!("{} is not JSON", path.display()))
}

/// The answers a host passes itself (`--answers`), as a JSON object by task id.
fn given_answers(path: &Path) -> Result<Map<String, Value>> {
    serde_json::from_value(json_input(path)?).context("the answers are not a JSON object")
}

pub fn submit(args: &SubmitArgs) -> Result<ExitCode> {
    crate::paged::print(&submit_step(args)?, &args.paging)
}

/// The step `submit` prints, with what its telemetry write did.
pub(crate) fn submit_step(args: &SubmitArgs) -> Result<Value> {
    let began = Instant::now();
    let given = args.answers.as_deref().map(given_answers).transpose()?;
    let run = std::path::absolute(&args.run)
        .with_context(|| format!("resolving {}", args.run.display()))?;
    // A run started with no plugin root known, or whose own was uninstalled, files through one
    // found now, kept for every later write: a resume re-files a lost record through it.
    filing::adopt(&run, filing_root(args.record_root.as_deref()).as_deref());
    // Before anything else a resume does — even one refused below — the records of the run's
    // stopped parts that did not land are filed again; a finished run whose own record did not land
    // is filed again rather than refused.
    let earlier = if args.resume {
        filing::resuming(&run, &crate::filing_worker::BoundedWriter)
    } else {
        Vec::new()
    };
    if args.resume
        && let Some(step) =
            filing::refile(&run, earlier.clone(), &crate::filing_worker::BoundedWriter)
    {
        return Ok(step);
    }
    refuse_folded(&run, args)?;
    let said = step::Said {
        degraded: &args.degraded,
        limit: args.limit.as_deref(),
        resume: args.resume,
        post: None,
        abandoned: &args.abandoned,
    };
    let stepped = step::submit_with(&run, given.as_ref(), &said).map_err(|e| {
        // A refused resume still says what its re-filing of the stopped parts lost. A run an
        // earlier format wrote goes on no further, so the records it kept or lost are re-filed
        // whatever the submit asked — a resume did so above — and nothing new is filed: the
        // engine's own record of a run the binary did not finish covers its open segment. A newer
        // format's run is left to the craft that wrote it (realm @nick/craft, node #618).
        let mut lost = earlier.clone();
        if !args.resume && is_state_version_refusal(&e) {
            lost.extend(refile_kept(&run));
        }
        let told = if lost.is_empty() {
            String::new()
        } else {
            format!(" (the run's telemetry: {})", lost.join("; "))
        };
        anyhow::anyhow!("{e:#}{told}")
    });
    let step = stamped(stepped?, began);
    let host = filing::Host {
        agents: args.agents,
        output_tokens: args.output_tokens,
        output_tokens_scope: args.output_tokens_scope.clone(),
        resume: args.resume,
        session: session(),
    };
    Ok(
        match filing::submitted(
            &run,
            &step,
            &host,
            earlier,
            &crate::filing_worker::BoundedWriter,
        ) {
            Some(filed) => filing::with_filing(step, filed),
            None => step,
        },
    )
}

/// Whether `e` refuses a run whose state another format wrote.
fn is_state_version_refusal(e: &craft_review::Error) -> bool {
    matches!(
        e,
        craft_review::Error::State(craft_review::state::StateError::Version { .. })
    )
}

/// The records of `run` it kept or lost, filed again as a resume files them; what did not land.
fn refile_kept(run: &Path) -> Vec<String> {
    let w = crate::filing_worker::BoundedWriter;
    let mut lost = filing::resuming(run, &w);
    let refiled = filing::refile(run, Vec::new(), &w);
    let said = refiled.as_ref().and_then(|s| s.pointer("/filing/lost"));
    let said = said.and_then(Value::as_array).into_iter().flatten();
    lost.extend(said.filter_map(Value::as_str).map(str::to_owned));
    lost
}

/// A stopped run that files its telemetry goes on only by `--resume`, which keeps the stopped
/// segment's record until it lands and opens a new segment; a plain submit would go on in a
/// segment whose checkpoints the stop already folded into its record.
fn refuse_folded(run: &Path, args: &SubmitArgs) -> Result<()> {
    let recording = filing::state_path(run).exists();
    let stopped = || craft_review::state::load(run).is_ok_and(|s| s.stopped.is_some());
    if recording && !args.resume && args.limit.is_none() && stopped() {
        let d = run.display().to_string().replace('\'', r"'\''");
        anyhow::bail!(
            "the run in {} stopped and files its telemetry by segment: resume it with `craft review submit --run '{d}' --resume`",
            run.display()
        );
    }
    Ok(())
}

pub fn status(args: &StatusArgs) -> Result<ExitCode> {
    if args.brief {
        return print(&status::brief(&args.run)?);
    }
    crate::paged::print(&status::status(&args.run)?, &args.paging)
}

/// Where the run in `run` stands, as `status` prints it.
pub(crate) fn status_step(run: &Path) -> Result<Value> {
    Ok(status::status(run)?)
}

/// A `--recall-degraded` text: refused when nothing but whitespace and control characters.
fn recall_note(s: &str) -> Result<String, String> {
    if s.chars().any(|c| !c.is_control() && !c.is_whitespace()) {
        Ok(s.to_owned())
    } else {
        Err("a blank note: say why the launcher's recall may not have read the whole store".into())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{installed_copy, run_dir_in};

    #[test]
    fn with_an_empty_home_the_run_dir_is_under_the_passwd_home_beside_the_store() {
        let home = craft_store::read::home_from(Some("".into()));
        let dir = run_dir_in(home.clone()).unwrap();
        assert!(dir.is_absolute(), "{}", dir.display());
        assert!(dir.starts_with(home.unwrap().join(".craft/runs/cli")));
        drop(run_dir_in(None).unwrap_err());
    }

    #[test]
    fn the_installed_copy_is_under_the_config_dir_else_home_and_names_this_version() {
        let at = |p: &str| {
            PathBuf::from(p)
                .join("plugins/cache/craft/craft")
                .join(env!("CARGO_PKG_VERSION"))
        };
        let (config, home) = (Some(PathBuf::from("/c")), Some(PathBuf::from("/h")));
        assert_eq!(installed_copy(config, home.clone()), Some(at("/c")));
        assert_eq!(installed_copy(None, home), Some(at("/h/.claude")));
        assert_eq!(installed_copy(None, None), None);
    }
}
