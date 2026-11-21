//! Which of the graph's projects a review indexes and asks (realm @nick/craft, node #529): one
//! project of craft's own per repository, `craft-review-<repo id>`, its root moved to each checkout
//! reviewed (`index_repository`'s `name`), so a PR worktree or a linked worktree leaves no project
//! of its path behind (cbm 0.12.1 makes one per path: node #530). A project the reviewer's
//! profile records is never indexed or asked: it only says the graph is there.

use std::path::Path;

use super::GraphError;
use crate::consumers::cbm::Index;

/// The name of craft's own project for the repository at `top`, one for all its checkouts.
///
/// # Errors
/// When the repository's shared git directory cannot be read.
pub fn own(top: &Path) -> Result<String, GraphError> {
    let common = crate::git::common_dir(top).map_err(|e| GraphError::Profile(e.to_string()))?;
    Ok(format!(
        "craft-review-{}",
        crate::project::project_id(&common)
    ))
}

/// Refuses an index that names no root, or a root other than the checkout at `top` itself: after
/// craft's own index of it, a sibling checkout's root means another review moved the project.
///
/// # Errors
/// [`GraphError::NoRoot`] or [`GraphError::Foreign`].
pub(super) fn of_this_checkout(project: &str, index: &Index, top: &Path) -> Result<(), GraphError> {
    if index.root.is_empty() {
        return Err(GraphError::NoRoot {
            project: project.to_owned(),
        });
    }
    let checkout = top.display().to_string();
    if index.root == checkout {
        return Ok(());
    }
    Err(GraphError::Foreign {
        project: project.to_owned(),
        root: index.root.clone(),
        checkout,
    })
}
