//! Where the re-anchor step reads a cited file: the head commit's tree, through `git`, never the
//! working tree — so a symlink is read as the link it is, not followed out of the repository.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::git::git;

/// A path as the head tree holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Blob {
    /// No entry at that path.
    Missing,
    /// A regular file, as text.
    Text(String),
    /// Something the step does not judge: a directory, a symlink, a submodule, a file not UTF-8,
    /// or a `git` that failed.
    Unreadable,
}

/// The tree the re-anchor step reads.
pub(crate) trait Tree {
    /// `path` in the reviewed head.
    fn at_head(&self, path: &str) -> Blob;
}

/// The head tree of a repository, each path read once.
pub(crate) struct GitTree {
    repo: PathBuf,
    head: String,
    seen: RefCell<HashMap<String, Blob>>,
}

impl GitTree {
    pub(crate) fn new(repo: &str, head: &str) -> Self {
        Self {
            repo: PathBuf::from(repo),
            head: head.to_owned(),
            seen: RefCell::new(HashMap::new()),
        }
    }

    /// The entry `path` names in the head's tree as `(mode, object)`, `None` when it has none.
    /// `--full-tree`: the path is read from the top, wherever the run's repository path points.
    fn entry(&self, path: &str) -> Result<Option<(String, String)>, ()> {
        let out = git(
            &self.repo,
            &["ls-tree", "-z", "--full-tree", &self.head, "--", path],
        )
        .map_err(drop)?;
        Ok(out.split('\0').find_map(|e| {
            let (meta, name) = e.split_once('\t')?;
            let mut m = meta.split(' ');
            let (mode, _kind, object) = (m.next()?, m.next()?, m.next()?);
            (name == path).then(|| (mode.to_owned(), object.to_owned()))
        }))
    }

    fn read(&self, path: &str) -> Blob {
        match self.entry(path) {
            Ok(None) => Blob::Missing,
            Ok(Some((mode, object))) if mode == "100644" || mode == "100755" => {
                git(&self.repo, &["cat-file", "blob", &object]).map_or(Blob::Unreadable, Blob::Text)
            }
            Ok(Some(_)) | Err(()) => Blob::Unreadable,
        }
    }
}

impl Tree for GitTree {
    fn at_head(&self, path: &str) -> Blob {
        if let Some(b) = self.seen.borrow().get(path) {
            return b.clone();
        }
        let b = self.read(path);
        self.seen.borrow_mut().insert(path.to_owned(), b.clone());
        b
    }
}

#[cfg(test)]
#[cfg(unix)]
#[path = "tree_tests.rs"]
mod tests;
