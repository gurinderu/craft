//! Which of the graph's projects a review indexes and asks (realm @nick/craft, node #529): the
//! profile's own when it indexes the checkout under review, so the reviewer's project is
//! refreshed in place; otherwise one project of craft's own per repository, its root moved to
//! each checkout reviewed (`index_repository`'s `name`), so a PR worktree under craft's
//! worktrees, or a linked worktree, leaves no project of its path behind (cbm 0.12.1 makes one
//! per path: node #530).

use std::path::Path;
use std::time::Instant;

use super::GraphError;
use crate::consumers::cbm::{self, Cbm, Index};
use crate::project::CodeGraph;

/// The name of craft's own project for the repository at `top`.
fn own(top: &Path) -> Result<String, GraphError> {
    let common = crate::git::common_dir(top).map_err(|e| GraphError::Profile(e.to_string()))?;
    Ok(format!(
        "craft-review-{}",
        crate::project::project_id(&common)
    ))
}

/// The project to index `top` into and ask.
///
/// # Errors
/// When the repository's shared git directory cannot be read.
pub(super) fn project(
    cbm: &Cbm,
    top: &Path,
    g: &CodeGraph,
    deadline: Instant,
) -> Result<String, GraphError> {
    let checkout = top.display().to_string();
    match g.project() {
        Some(p) if cbm.index(p, deadline).is_ok_and(|i| i.root == checkout) => Ok(p.to_owned()),
        Some(_) | None => own(top),
    }
}

/// Refuses an index that names no root, or a root that is not the repository's at `top`.
///
/// # Errors
/// [`GraphError::NoRoot`] or [`GraphError::Foreign`].
pub(super) fn of_this_checkout(project: &str, index: &Index, top: &Path) -> Result<(), GraphError> {
    if index.root.is_empty() {
        return Err(GraphError::NoRoot {
            project: project.to_owned(),
        });
    }
    let roots = cbm::roots_of(top);
    if roots.contains(&index.root) {
        return Ok(());
    }
    Err(GraphError::Foreign {
        project: project.to_owned(),
        root: index.root.clone(),
        roots: roots.join(" or "),
    })
}
