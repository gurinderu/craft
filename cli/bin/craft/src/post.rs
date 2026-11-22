//! `craft review post`: one doubtful finding the reviewer chose, posted on the PR as a question to
//! the author or as a defect, read by its number from the review run's record, and the choice
//! written into that record (`craft runs sorting-choice`'s write) once it is on the PR.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, anyhow};
use craft_review::publish::{self, Doubtful, PostError, PostSetup};
use serde_json::{Value, json};

use crate::runs::write;

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum As {
    /// Ask the author: the comment carries the question and its hidden kind line.
    Question,
    /// Post as a defect.
    Defect,
}

#[derive(Debug, clap::Args)]
pub struct PostArgs {
    /// The number of the doubtful finding, as the report's Doubtful list and the record number it.
    #[arg(long)]
    pub n: u64,
    #[arg(long = "as", value_enum)]
    pub kind: As,
    /// The pull request, by number; the checked-out branch's when absent.
    #[arg(long)]
    pub pr: Option<u64>,
    /// The review run's record; the newest of this repository's branch carrying doubtful findings
    /// when absent.
    #[arg(long)]
    pub record: Option<PathBuf>,
    /// The run store; `~/.craft/runs` when absent.
    #[arg(long)]
    pub store: Option<PathBuf>,
    /// The reviewed repository (default: the working directory).
    #[arg(long)]
    pub project: Option<PathBuf>,
}

/// Why nothing was posted: a refusal of what was asked (exit 2, as the JavaScript poster
/// refused), or a failure on the way (exit 1).
enum Stop {
    Refused(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for Stop {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

/// The record's doubtful findings, whether their lines were judged, and its reviewed head.
fn read_record(file: &Path) -> Result<(Vec<Value>, bool, Option<String>), String> {
    let text =
        std::fs::read_to_string(file).map_err(|e| format!("reading {}: {e}", file.display()))?;
    let r: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let sorting = r.get("sorting").filter(|s| s.is_object());
    let findings = sorting
        .and_then(|s| s.get("findings"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|f| f.is_object()).cloned().collect())
        .unwrap_or_default();
    let judged = sorting.and_then(|s| s.get("inDiffJudged")) != Some(&Value::Bool(false));
    let head = r.get("head").and_then(Value::as_str).map(str::to_owned);
    Ok((findings, judged, head))
}

pub fn post(args: &PostArgs) -> Result<ExitCode> {
    match posted(args) {
        Ok(out) => {
            writeln!(std::io::stdout().lock(), "{out}")?;
            Ok(ExitCode::SUCCESS)
        }
        Err(Stop::Refused(why)) => {
            drop(writeln!(
                std::io::stderr().lock(),
                "craft review post: {why}"
            ));
            Ok(ExitCode::from(2))
        }
        Err(Stop::Failed(e)) => Err(e),
    }
}

/// What `post` prints: the posting, the choice recorded (null when its write failed, said on
/// stderr) and the record.
fn posted(args: &PostArgs) -> Result<Value, Stop> {
    let store = args.store.clone().or_else(craft_store::read::home_store).ok_or_else(|| {
        Stop::Refused("neither HOME nor the passwd entry names a home, so there is no ~/.craft/runs; pass --store".into())
    })?;
    let repo = write::repo(args.project.as_deref())?;
    let env = write::env(&store);
    let named = args.record.as_deref().map(write::repo_relative);
    let req = write::request(&repo, None);
    let file =
        craft_store::posthoc::sorted_record(named.as_deref(), &req, &env).map_err(Stop::Refused)?;
    let (findings, lines_judged, head) = read_record(&file).map_err(Stop::Refused)?;
    let question = args.kind == As::Question;
    let d = Doubtful {
        findings: &findings,
        n: args.n,
        question,
        lines_judged,
        reviewed: head.as_deref(),
    };
    let scratch = tempdir()?;
    let posting = publish::post_doubtful(&repo, &d, args.pr, &PostSetup::default(), &scratch);
    drop(std::fs::remove_dir_all(&scratch));
    let posting = posting.map_err(|e| match e {
        PostError::Finding(why) => Stop::Refused(why),
        other @ (PostError::Gh(_) | PostError::Refused(_)) => Stop::Failed(anyhow!(other)),
    })?;
    let choice = if question { "question" } else { "defect" };
    #[expect(
        clippy::cast_precision_loss,
        reason = "a finding's number, far below 2^53"
    )]
    let recorded =
        match craft_store::sorting::record_choice(&store, &file, args.n as f64, choice, env.now) {
            Ok((line, _)) => Value::from(line),
            Err(why) => {
                drop(writeln!(
                    std::io::stderr().lock(),
                    "craft review post WARNING: the choice was not recorded: {why}"
                ));
                Value::Null
            }
        };
    let mut out = serde_json::to_value(&posting).map_err(anyhow::Error::from)?;
    if let Some(o) = out.as_object_mut() {
        o.insert("recorded".into(), recorded);
        o.insert("record".into(), json!(file.display().to_string()));
    }
    Ok(out)
}

/// A fresh directory for gh's output, removed once the post is done.
fn tempdir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "craft-post-{}-{}",
        std::process::id(),
        craft_store::time::now_ms()
    ));
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    Ok(dir)
}
