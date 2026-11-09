//! What a run keeps of its publication between steps and in its finished step: whether it was
//! asked, the sorting, the memory contradictions and what came of posting.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A run's publication: asked or not, and, once it finished, its sorting, the memory
/// contradictions and what was posted.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Publish {
    /// The host asked for the defects on the PR (`--comment`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub asked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sorting: Option<Sorting>,
    /// The run record's `memoryContradictions`, once the run finished.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contradictions: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posted: Option<Posted>,
}

impl Publish {
    /// A new run's publication, asked for or not.
    #[must_use]
    pub fn asked(asked: bool) -> Self {
        Self {
            asked,
            ..Self::default()
        }
    }
}

/// The findings split for publication.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sorting {
    pub defects: Vec<Defect>,
    /// Each doubtful finding with why it is doubtful.
    pub doubtful: Vec<(Value, Vec<String>)>,
    /// Why the outside-the-diff sign was not applied, or ''.
    pub note: String,
}

/// A defect to post: where, and on which line — `None`, on its file, since the diff did not change
/// its line or that could not be told.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Defect {
    pub finding: Value,
    pub file: String,
    pub line: Option<u32>,
}

/// What came of posting the defects.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Posted {
    /// The pull request, 0 when none was found, and its link.
    pub pr: u64,
    pub url: String,
    /// The defects to post, those posted now, those on the PR already, those gh refused.
    pub requested: usize,
    pub posted: usize,
    pub already: usize,
    pub failed: usize,
    /// The defects that name no file, which no review comment can carry.
    pub no_file: usize,
    /// Of those posted, the ones posted on their file because GitHub refused their line (HTTP
    /// 422: the line is outside the PR's diff).
    #[serde(skip_serializing_if = "is_zero")]
    pub to_file: usize,
    /// One line: the PR posted to, or why nothing was.
    pub reason: String,
    /// gh's failure, '' when none.
    pub error: String,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if hands a reference"
)]
const fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl Posted {
    pub(super) fn failed_with(mut self, e: String) -> Self {
        self.reason.clone_from(&e);
        self.error = e;
        self
    }
}
