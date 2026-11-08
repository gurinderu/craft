//! The `--path` scope: a review of one directory (or file) of the change, as review.js's `path`
//! (a crate of a rust-audit, `lib/review-run-args.mjs`). It is read once at the start and spelled
//! repository-relative, the way every changed path is: an absolute path inside the repository is
//! taken as that directory, one outside it is refused rather than widened to the whole repository
//! (realm @nick/craft, node #65), and a path that climbs out with `..` is refused too.

use std::path::{Component, Path};

/// Why a scope cannot be used.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScopeError {
    #[error("the scope {0:?} is absolute and not inside the repository {1}")]
    Outside(String, String),
    #[error("the scope {0:?} climbs out of the repository with `..`")]
    Climbs(String),
    #[error("the scope {0:?} holds a control character")]
    Control(String),
}

/// `given` as a repository-relative path under `top`, the repository's top level: `None` when it
/// names the whole repository (empty, `.`).
///
/// # Errors
/// [`ScopeError`] when it is absolute and outside `top`, holds a `..`, or a control character.
pub fn normalize(top: &Path, given: &str) -> Result<Option<String>, ScopeError> {
    if given.chars().any(char::is_control) {
        return Err(ScopeError::Control(given.to_owned()));
    }
    let path = Path::new(given.trim());
    let relative = if path.is_absolute() {
        let top = top.canonicalize().unwrap_or_else(|_| top.to_path_buf());
        // A path that does not exist (a deleted directory) is compared as written.
        let at = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        at.strip_prefix(&top)
            .map_err(|_not_under| ScopeError::Outside(given.to_owned(), top.display().to_string()))?
            .to_path_buf()
    } else {
        path.to_path_buf()
    };
    let mut parts = Vec::new();
    for c in relative.components() {
        match c {
            Component::Normal(p) => parts.push(p.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ScopeError::Climbs(given.to_owned()));
            }
        }
    }
    Ok((!parts.is_empty()).then(|| parts.join("/")))
}

#[cfg(test)]
mod tests {
    use super::{ScopeError, normalize};
    use std::path::Path;

    #[test]
    fn a_relative_scope_is_kept_without_its_dots_and_slashes() {
        let top = Path::new("/r");
        assert_eq!(
            normalize(top, "crates/core"),
            Ok(Some("crates/core".into()))
        );
        assert_eq!(
            normalize(top, "./crates//core/"),
            Ok(Some("crates/core".into()))
        );
        assert_eq!(normalize(top, "."), Ok(None));
        assert_eq!(normalize(top, ""), Ok(None));
    }

    #[test]
    fn an_absolute_scope_is_read_inside_the_repository_or_refused() {
        let t = tempfile::tempdir().unwrap();
        let top = t.path();
        std::fs::create_dir_all(top.join("crates/core")).unwrap();
        let inside = top.join("crates/core").display().to_string();
        assert_eq!(normalize(top, &inside), Ok(Some("crates/core".into())));
        assert!(matches!(
            normalize(top, "/elsewhere/crates/core"),
            Err(ScopeError::Outside(..))
        ));
    }

    #[test]
    fn a_climbing_or_control_scope_is_refused() {
        let top = Path::new("/r");
        assert!(matches!(
            normalize(top, "crates/../../x"),
            Err(ScopeError::Climbs(_))
        ));
        assert!(matches!(
            normalize(top, "crates\ncore"),
            Err(ScopeError::Control(_))
        ));
    }
}
