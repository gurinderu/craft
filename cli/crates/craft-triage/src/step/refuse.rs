//! What a triage refuses before any agent, as the engine refuses it.

use crate::TriageError;
use crate::run::Args;

/// Refuses what the engine refuses before any agent: no source to gather from, and a repository
/// named by anything but an absolute path (`readRepoArg` in `integrations/shared/repo-arg.mjs`).
pub(super) fn refuse(args: &Args) -> Result<(), TriageError> {
    if args.report.is_empty() && args.pr.is_empty() {
        return Err(TriageError::Refused(
            "a triage needs a source: a report file and/or a pull request".into(),
        ));
    }
    let repo = &args.repo;
    if repo.is_empty() {
        return Ok(());
    }
    let why = if repo.trim().is_empty() {
        "it is blank"
    } else if repo.chars().any(char::is_control) {
        "it holds a control character"
    } else if !std::path::Path::new(repo).is_absolute() {
        "it must be an absolute path"
    } else {
        return Ok(());
    };
    Err(TriageError::Refused(format!(
        "the repository {repo:?} is refused: {why}; pass the absolute path of its checkout, or leave it out to work in the session's own"
    )))
}
