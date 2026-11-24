//! `craft review post`: one doubtful finding the reviewer chose, posted on the PR as a question to
//! the author or as a defect, read by its number from the review run's record, and the choice
//! written into that record (`craft runs sorting-choice`'s write) once it is on the PR.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Result, anyhow};
use craft_review::publish::{self, Doubtful, PostError, PostSetup, Posting};
use serde::Serialize;
use serde_json::Value;

use crate::runs::write;

mod record;

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
    /// The review run's record; when absent, the newest review record of this repository carrying
    /// doubtful findings, refused when it is another branch's. A retry names the record the first
    /// try printed, so a newer review of the branch is not taken in its place.
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
/// no run state to tell uncommitted work by, no open PR of the record's branch (or the record's PR
/// closed) without `--pr`, no working directory — (exit 2, as the JavaScript poster refused), or a
/// failure on the way: gh failing (its list of the branch's PRs, the post), the PR's head not
/// fetched (both with the record to retry with), a review of uncommitted work, a moved head over
/// the finding's line (exit 1).
enum Stop {
    Refused(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for Stop {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

/// How a post that did not land stops: refused (exit 2) when what was asked cannot be told — no
/// such finding, no such PR, a record that refused the mark — failed (exit 1) otherwise, the
/// record `file` named for a retry where one may land.
fn stop(e: PostError, file: &std::path::Path) -> Stop {
    match e {
        PostError::Finding(why) | PostError::Pr(why) => Stop::Refused(why),
        PostError::Remember { ref source, .. } if source.is_refusal() => {
            Stop::Refused(e.to_string())
        }
        other @ (PostError::Gh(_) | PostError::Fetch(_) | PostError::Remember { .. }) => {
            Stop::Failed(anyhow!(
                "{other} (record {}: a retry names it with --record)",
                file.display()
            ))
        }
        other @ PostError::Refused(_) => Stop::Failed(anyhow!(other)),
    }
}

pub fn post(args: &PostArgs) -> Result<ExitCode> {
    match posted(args) {
        Ok(out) => {
            writeln!(std::io::stdout().lock(), "{}", serde_json::to_string(&out)?)?;
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
#[derive(Serialize)]
struct Out {
    #[serde(flatten)]
    posting: Posting,
    recorded: Value,
    record: String,
}

fn posted(args: &PostArgs) -> Result<Out, Stop> {
    let store = args.store.clone().or_else(craft_store::read::home_store).ok_or_else(|| {
        Stop::Refused("neither HOME nor the passwd entry names a home, so there is no ~/.craft/runs; pass --store".into())
    })?;
    let repo = write::repo(args.project.as_deref()).map_err(|e| Stop::Refused(format!("{e:#}")))?;
    let env = write::env(&store);
    let named = args.record.as_deref().map(write::repo_relative);
    let req = write::request(&repo, None);
    let file = record::file(named.as_deref(), &req, &env)?;
    let rec = record::read(&file, args.n).map_err(Stop::Refused)?;
    let question = args.kind == As::Question;
    #[expect(
        clippy::cast_precision_loss,
        reason = "a finding's number, far below 2^53"
    )]
    let remember =
        |pr: u64| craft_store::sorting::posting::mark(&store, &file, args.n as f64, pr, env.now);
    let d = Doubtful {
        findings: &rec.findings,
        n: args.n,
        question,
        lines_judged: rec.judged,
        reviewed: rec.head.as_deref(),
        branch: rec.branch.as_deref(),
        record_pr: rec.pr,
        dirty: rec.dirty,
        posted_on: rec.posted_on,
        before_post: Some(&remember),
    };
    let scratch = crate::scratch::dir("craft-post")?;
    let posting = publish::post_doubtful(&repo, &d, args.pr, &PostSetup::default(), &scratch);
    drop(std::fs::remove_dir_all(&scratch));
    let posting = posting.map_err(|e| stop(e, &file))?;
    let choice = if question { "question" } else { "defect" };
    let recorded = record::choose(&store, &file, (args.n, choice), env.now);
    Ok(Out {
        posting,
        recorded,
        record: file.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use craft_review::publish::PostError;
    use craft_store::sorting::posting::{MarkError, Refusal};

    use super::{Stop, stop};

    #[test]
    fn a_record_refusing_the_mark_is_refused_and_a_failed_write_fails() {
        let file = Path::new("/s/r-review.json");
        let refused = MarkError::Refused {
            file: file.display().to_string(),
            refusal: Refusal::NoFinding("9".into()),
        };
        let e = PostError::Remember {
            pr: 5,
            source: refused,
        };
        assert!(
            matches!(stop(e, file), Stop::Refused(why) if why.contains("numbered 9") && why.contains("PR #5")),
            "a refusal exits 2"
        );
        let failed = MarkError::Failed("disk full".into());
        let e = PostError::Remember {
            pr: 5,
            source: failed,
        };
        assert!(
            matches!(stop(e, file), Stop::Failed(why) if why.to_string().contains("disk full")
                && why.to_string().contains("a retry names it with --record")),
            "a failure exits 1"
        );
    }
}
