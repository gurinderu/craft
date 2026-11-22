//! `craft review post`: one doubtful finding the reviewer chose, posted on the PR as a question to
//! the author or as a defect, read by its number from the review run's record, and the choice
//! written into that record (`craft runs sorting-choice`'s write) once it is on the PR.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Result, anyhow};
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

/// Why nothing was posted: what was asked cannot be read or told — no record, no such finding,
/// no PR of the record's branch, no working directory — (exit 2, as the JavaScript poster
/// refused), or a failure on the way: gh refusing the post, a moved head (exit 1).
enum Stop {
    Refused(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for Stop {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

/// What the record says of its doubtful findings and the review that held them back.
struct Record {
    findings: Vec<Value>,
    /// `sorting.inDiffJudged` is not false.
    judged: bool,
    head: Option<String>,
    branch: Option<String>,
}

fn read_record(file: &Path) -> Result<Record, String> {
    let text =
        std::fs::read_to_string(file).map_err(|e| format!("reading {}: {e}", file.display()))?;
    let r: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let sorting = r.get("sorting").filter(|s| s.is_object());
    let findings = sorting
        .and_then(|s| s.get("findings"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|f| f.is_object()).cloned().collect())
        .unwrap_or_default();
    let text_of = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
    Ok(Record {
        findings,
        judged: sorting.and_then(|s| s.get("inDiffJudged")) != Some(&Value::Bool(false)),
        head: text_of("head"),
        branch: text_of("branch"),
    })
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
    let repo = write::repo(args.project.as_deref()).map_err(|e| Stop::Refused(format!("{e:#}")))?;
    let env = write::env(&store);
    let named = args.record.as_deref().map(write::repo_relative);
    let req = write::request(&repo, None);
    let file =
        craft_store::posthoc::sorted_record(named.as_deref(), &req, &env).map_err(Stop::Refused)?;
    let rec = read_record(&file).map_err(Stop::Refused)?;
    let question = args.kind == As::Question;
    let d = Doubtful {
        findings: &rec.findings,
        n: args.n,
        question,
        lines_judged: rec.judged,
        reviewed: rec.head.as_deref(),
        branch: rec.branch.as_deref(),
    };
    let scratch = crate::scratch::dir("craft-post")?;
    let posting = publish::post_doubtful(&repo, &d, args.pr, &PostSetup::default(), &scratch);
    drop(std::fs::remove_dir_all(&scratch));
    let posting = posting.map_err(|e| match e {
        PostError::Finding(why) | PostError::Pr(why) => Stop::Refused(why),
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
