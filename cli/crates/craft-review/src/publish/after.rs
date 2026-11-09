//! Publishing a finished run's findings after the fact (`craft review comment`; realm @nick/craft,
//! node #270): a run started without `--comment` is sorted and posted the way a run asked to
//! comment is when it finishes — its settled findings, at their final severity, sorted against the
//! lines its diff changed at the reviewed head, the defects posted with the craft-finding marker on
//! the reviewed commit, the doubtful ones kept for the reviewer in the report and the finished step.
//! A PR whose head moved since is posted to only when the new commits change none of the defects'
//! lines; otherwise, as for uncommitted work, nothing is posted and the run is left as it was.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::gh::Moved;
use super::{DIRTY, PostSetup, Posted, post_sorted, short, sort, sort_into, write_report};
use crate::Error;
use crate::gate::lines::Lines;
use crate::git;
use crate::state::{self, Phase, RunState};

/// Why a finished run's findings are not published: nothing is posted, and the run is left as it
/// was.
#[derive(Debug, thiserror::Error)]
pub enum CommentError {
    #[error(
        "the run in {} has not finished: resume it first (`craft review submit --run <dir> --resume`)",
        .0.display()
    )]
    NotFinished(PathBuf),
    #[error("{}", DIRTY)]
    Dirty,
    #[error("the reviewed checkout {0} is gone: nothing can be posted from it")]
    NoCheckout(String),
    #[error("nothing was posted: {0}")]
    Refused(String),
    #[error(
        "the run in {} was reviewed on a detached HEAD, so no branch names its pull request: name it with `--pr <number>` (cli-review: pr=<number>)",
        .0.display()
    )]
    Detached(PathBuf),
}

/// Sorts and posts the findings of the finished run in `dir` on the pull request `pr` names, else
/// on its reviewed branch's — never the one checked out now, which may be another's — keeps
/// what came of it in the run's state and report, and returns the run's finished step with it.
///
/// # Errors
/// When the run cannot be read or is not finished, read uncommitted work, its checkout is gone, it
/// was reviewed on a detached HEAD and no `pr` is named, the
/// PR's head moved over a defect's line, or the report or state cannot be written.
pub fn comment(dir: &Path, pr: Option<u64>, setup: &PostSetup) -> Result<Value, Error> {
    let mut run = state::load(dir)?;
    let verdict = match &run.verdict {
        Some(v) if run.phase == Phase::Done => v.clone(),
        _ => return Err(CommentError::NotFinished(dir.to_owned()).into()),
    };
    if run.diff.dirty {
        return Err(CommentError::Dirty.into());
    }
    if !Path::new(&run.context.repo).is_dir() {
        return Err(CommentError::NoCheckout(run.context.repo.clone()).into());
    }
    let which = match (pr, &run.chain.branch) {
        (Some(n), _) => n.to_string(),
        (None, Some(branch)) => branch.clone(),
        (None, None) => return Err(CommentError::Detached(dir.to_owned()).into()),
    };
    run.publish.asked = true;
    run.publish.posted = None;
    let found = super::candidates(&run);
    let changed = lines_at_head(&run);
    sort_into(&mut run, &found, changed.as_ref());
    let check = |pr_head: &str| moved(&run, pr_head);
    let posted = post_sorted(dir, &run, setup, Some(&which), &check)
        .unwrap_or_else(|| Ok(Posted::default()))
        .map_err(CommentError::Refused)?;
    run.publish.posted = Some(posted);
    write_report(dir, &run)?;
    state::save(dir, &run)?;
    Ok(crate::finished::step(dir, &run, &verdict))
}

/// The lines the run's diff changed, from its base to the reviewed head — not to the working tree,
/// which may have moved on since.
fn lines_at_head(run: &RunState) -> Option<Lines> {
    let base = crate::finished::base(run);
    git::zero_context_between(Path::new(&run.context.repo), base, &run.diff.head, true)
        .ok()
        .map(|d| Lines::parse(&d))
}

/// What a PR whose head is `pr_head`, not the reviewed head, does: the defects are posted on the
/// reviewed commit when the PR's head holds it and the commits since change none of their lines;
/// otherwise nothing is posted, saying which.
fn moved(run: &RunState, pr_head: &str) -> Moved {
    let repo = Path::new(&run.context.repo);
    let (head, now) = (short(&run.diff.head), short(pr_head));
    if !git::has_commit(repo, pr_head) {
        return Moved::Refuse(format!(
            "the PR's head {now} is not the reviewed head {head} and is not in {}: fetch it and run again",
            repo.display()
        ));
    }
    if !git::holds(repo, pr_head, &run.diff.head) {
        return Moved::Refuse(format!(
            "the PR's head {now} does not hold the reviewed head {head} (the branch was rebased or force-pushed): review the PR's head again"
        ));
    }
    let Ok(diff) = git::zero_context_between(repo, &run.diff.head, pr_head, false) else {
        return Moved::Refuse(format!(
            "git could not diff the reviewed head {head} against the PR's head {now}"
        ));
    };
    let touched = touched(run, &Lines::parse_old(&diff));
    if touched.is_empty() {
        return Moved::Post(format!(
            "the PR's head moved to {now} since the reviewed head {head}; its new commits change none of the defects' lines, so they are posted on the reviewed commit"
        ));
    }
    Moved::Refuse(format!(
        "the PR's head moved to {now} since the reviewed head {head}, and its new commits change the lines of {} defect(s): {} — review the PR's head again",
        touched.len(),
        touched.join("; ")
    ))
}

/// The defects to post whose line the commits since the reviewed head changed (`old`: their
/// rewritten and removed lines, in the reviewed head's numbering), each as `file:line` and title.
fn touched(run: &RunState, old: &Lines) -> Vec<String> {
    let Some(sorting) = &run.publish.sorting else {
        return Vec::new();
    };
    sorting
        .defects
        .iter()
        .filter(|d| !d.file.is_empty())
        .filter_map(|d| {
            let line = sort::line(&d.finding);
            (line > 0 && old.touches(&d.file, line))
                .then(|| format!("`{}:{line}` {}", d.file, sort::text(&d.finding, "title")))
        })
        .collect()
}
