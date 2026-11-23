//! What came of posting a doubtful finding.

use serde::Serialize;

use super::super::gh::read::Pr;

/// What came of posting it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Posting {
    pub pr: u64,
    pub url: String,
    /// The commit the comment is on.
    pub commit: String,
    pub posted: bool,
    /// Its comment was on the PR already, so nothing was posted.
    pub already: bool,
    /// Posted on its file, its line outside the diff or refused by GitHub.
    pub to_file: bool,
    pub reason: String,
}

impl Posting {
    /// What a post whose comment is on `p` already says: nothing posted.
    pub(super) fn already(p: &Pr, reviewed: &str) -> Self {
        Self {
            pr: p.number,
            url: p.url.clone(),
            commit: reviewed.to_owned(),
            posted: false,
            already: true,
            to_file: false,
            reason: format!(
                "its comment is on PR #{} {} already: nothing posted",
                p.number, p.url
            ),
        }
    }
}
