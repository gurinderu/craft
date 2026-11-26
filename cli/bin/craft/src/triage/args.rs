//! The arguments of `craft triage start | submit | status`.

use std::path::PathBuf;

#[derive(Debug, clap::Args)]
pub struct StartArgs {
    /// The checkout the session runs in.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// Where the triage keeps its state; a new directory under ~/.craft/runs/cli when absent.
    #[arg(long)]
    pub run_dir: Option<PathBuf>,
    /// A report file of any review engine to gather the findings from.
    #[arg(long, default_value = "")]
    pub report: String,
    /// A pull request whose review threads to gather the findings from.
    #[arg(long, default_value = "")]
    pub pr: String,
    /// The ref the findings were generated against (the reviewed head); the validators read it.
    #[arg(long, default_value = "")]
    pub base: String,
    /// The commit the PR forks from, where "not this PR's" must be shown.
    #[arg(long, default_value = "")]
    pub pr_base: String,
    /// The repository the findings are in, when it is not the one `--cwd` names.
    #[arg(long, default_value = "")]
    pub repo: String,
    /// A prior ledger (a JSON list of `{stable_id, verdict, reason}`), as a file or `-`.
    #[arg(long)]
    pub prior_ledger: Option<PathBuf>,
    /// The launcher's records (`priorDecisions`), as a file or `-`.
    #[arg(long)]
    pub prior_decisions: Option<PathBuf>,
    /// File the run's record under this craft version, as the triage engine's own run: written
    /// into the run store (`~/.craft/runs`) by the binary itself when the run ends. Absent,
    /// nothing is filed.
    #[arg(long, value_name = "CRAFT_VERSION")]
    pub record: Option<String>,
    /// The craft plugin root the record is stamped with (`craftCommit`), when it is not the one
    /// above the binary.
    #[arg(long, requires = "record")]
    pub record_root: Option<PathBuf>,
}

#[derive(Debug, clap::Args)]
pub struct SubmitArgs {
    /// The triage's run directory.
    #[arg(long)]
    pub run: PathBuf,
    /// The answers as one JSON object by task id; read from the answer files when absent.
    #[arg(long)]
    pub answers: Option<PathBuf>,
    /// How the host ran this step's tasks weaker than asked, one note each.
    #[arg(long)]
    pub degraded: Vec<String>,
    /// The account's usage limit, as an agent's error or short answer said it: the run keeps the
    /// answers that came in and stops, its unanswered tasks held; once the limit resets,
    /// `--resume` goes on with the run.
    #[arg(long)]
    pub limit: Option<String>,
    /// The host resumes a run it lost: an answer missing now is handed out again rather than
    /// counted as a failed attempt; a finished run whose record did not land files it again.
    #[arg(long)]
    pub resume: bool,
    /// A task whose agent the host abandoned at its deadline; repeatable. It fails at once and is
    /// not handed out again.
    #[arg(long)]
    pub abandoned: Vec<String>,
}

#[derive(Debug, clap::Args)]
pub struct StatusArgs {
    /// The triage's run directory.
    #[arg(long)]
    pub run: PathBuf,
}
