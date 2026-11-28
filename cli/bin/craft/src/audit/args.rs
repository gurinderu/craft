//! The arguments of `craft audit start | submit | status`.

use std::num::{NonZeroU64, NonZeroUsize};
use std::path::PathBuf;

#[derive(Debug, clap::Args)]
pub struct StartArgs {
    /// A directory inside the repository to audit; the audit reads from the repository's root.
    #[arg(long, default_value = ".")]
    pub cwd: PathBuf,
    /// Where the audit keeps its state; a new directory under ~/.craft/runs/cli when absent.
    #[arg(long)]
    pub run_dir: Option<PathBuf>,
    /// Audit only the tracked files under this path, from the repository's root; repeatable.
    /// Absent, the whole project.
    #[arg(long)]
    pub path: Vec<String>,
    /// The bytes of whole files one lens agent reads at most; a larger file is read alone.
    #[arg(long, default_value = "150000")]
    pub batch_bytes: NonZeroU64,
    /// The lens agents one pass buys at most, in order; the files of the rest are named unread
    /// and a resume reads them. Absent, one agent of each lens over each batch.
    #[arg(long)]
    pub lens_agents: Option<NonZeroUsize>,
    /// craft's plugin root, whose skills the prompts name; found above the executable when absent.
    #[arg(long, env = "CRAFT_ROOT")]
    pub craft_root: Option<PathBuf>,
    /// File the audit's record under this craft version: written into the run store
    /// (`~/.craft/runs`) by the binary itself when a pass ends. Absent, nothing is filed.
    #[arg(long, value_name = "CRAFT_VERSION")]
    pub record: Option<String>,
    /// The craft plugin root the record is stamped with (`craftCommit`), when it is not the one
    /// above the binary.
    #[arg(long, requires = "record")]
    pub record_root: Option<PathBuf>,
}

#[derive(Debug, clap::Args)]
pub struct SubmitArgs {
    /// The audit's run directory.
    #[arg(long)]
    pub run: PathBuf,
    /// The answers as one JSON object by task id; read from the answer files when absent.
    #[arg(long)]
    pub answers: Option<PathBuf>,
    /// How the host ran this step's tasks weaker than asked, one note each.
    #[arg(long)]
    pub degraded: Vec<String>,
    /// The account's usage limit, as an agent's error or short answer said it: the audit keeps
    /// the answers that came in and stops, its pending tasks held.
    #[arg(long)]
    pub limit: Option<String>,
    /// Resume: a missing answer is handed out again rather than counted; a finished audit reads
    /// the files it left unread, or files again a record that did not land.
    #[arg(long)]
    pub resume: bool,
    /// A task whose agent the host abandoned at its deadline; repeatable. It fails at once and its
    /// files stay unread until a resume.
    #[arg(long)]
    pub abandoned: Vec<String>,
}

#[derive(Debug, clap::Args)]
pub struct StatusArgs {
    /// The audit's run directory.
    #[arg(long)]
    pub run: PathBuf,
}
