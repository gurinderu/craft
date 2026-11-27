//! Whether a record's scope changed on the trunk outside the pull request whose merge anchors it,
//! before that merge (realm @nick/craft, node #682).

use std::path::Path;

use super::super::Base;
use crate::git;

impl Base {
    /// Whether `scope` is unchanged on the trunk outside the pull request whose merge this is,
    /// before that merge ([`git::unchanged_before_merge`]): from where the merge's second parent
    /// leaves the trunk — the trunk's changes the request's branch lacked — and from the decision
    /// date's base, each to the merge's first parent. A merge of one parent (a squash) has the
    /// date's window alone; git failing to read the parents counts as a change, as does a second
    /// parent beyond a shallow clone's boundary (realm @nick/craft, node #701); a base that is no
    /// merge has nothing outside it (realm @nick/craft, node #682).
    pub(crate) fn unchanged_outside(&self, path: &Path, scope: &str) -> bool {
        if self.pull.is_none() {
            return true;
        }
        let from = |b: &str| git::unchanged_before_merge(path, b, &self.commit, scope);
        let branch = git::second_parent(path, &self.commit);
        branch.is_ok_and(|p| p.as_deref().is_none_or(from))
            && self.dated.as_deref().is_none_or(from)
    }
}
