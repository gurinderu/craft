//! The head a pull request is opened on and the change it carries, read from git: the local HEAD,
//! or the branch `--head` names; origin's default branch, which the PR's whole change is measured
//! from as the review measures it by default (`git::default_base`), and where the head leaves it.

use std::cell::OnceCell;
use std::path::{Path, PathBuf};

use craft_review::git;

/// The checkout a pull request is opened from, as the store keys it.
pub struct Here {
    /// The repository as records name it (`repoKey`: the main checkout for a linked worktree).
    pub project: String,
    /// The commit the PR's head is.
    pub head: String,
    /// The branch the PR is opened from; `None` on a detached `HEAD`, as records file it.
    pub branch: Option<String>,
    /// The branch `--head` named, when one did.
    pub named: Option<String>,
    /// Origin's default branch.
    pub trunk: String,
    /// `git merge-base <trunk> <head>`: where the PR's whole change starts.
    pub point: String,
}

/// What the judge of a record asks git, apart so its tests need no repository.
pub trait Git {
    /// `git merge-base <base> <head>`, `None` when git cannot say.
    fn merge_base(&self, base: &str) -> Option<String>;
    /// The files the PR's whole change touches, `None` when git cannot say.
    fn changed(&self) -> Option<Vec<String>>;
}

/// The checkout in `dir` at the commit `head`.
pub struct Checkout {
    dir: PathBuf,
    head: String,
    point: String,
    changed: OnceCell<Option<Vec<String>>>,
}

impl Git for Checkout {
    fn merge_base(&self, base: &str) -> Option<String> {
        git::merge_base(&self.dir, base, &self.head).ok()
    }

    fn changed(&self) -> Option<Vec<String>> {
        self.changed
            .get_or_init(|| git::changed_files(&self.dir, &self.point, &self.head).ok())
            .clone()
    }
}

/// The PR opened from `dir`, on the branch `named` when `--head` named one; why not, when git
/// cannot say.
pub fn read(dir: &Path, named: Option<&str>) -> Result<(Here, Checkout), String> {
    let at = dir.display();
    let (head, branch) = if let Some(b) = named {
        let head = git::commit_of(dir, b)
            .or_else(|| git::commit_of(dir, &format!("origin/{b}")))
            .ok_or_else(|| format!("the branch {b} that --head names is not a commit in {at}"))?;
        (head, Some(b.to_owned()))
    } else {
        let head = git::head(dir).map_err(|e| format!("git cannot read HEAD in {at}: {e}"))?;
        let branch = git::current_branch(dir)
            .map_err(|e| format!("git cannot read the branch in {at}: {e}"))?;
        (head, branch)
    };
    let trunk = git::default_base(dir)
        .map_err(|e| format!("{e} in {at}, so the pull request's whole change cannot be told"))?;
    let point = git::merge_base(dir, &trunk, &head)
        .map_err(|e| format!("git cannot tell where {head} leaves {trunk} in {at}: {e}"))?;
    let here = Here {
        project: repo_key(dir),
        named: named.map(str::to_owned),
        head: head.clone(),
        branch,
        trunk,
        point: point.clone(),
    };
    let checkout = Checkout {
        dir: dir.to_path_buf(),
        head,
        point,
        changed: OnceCell::new(),
    };
    Ok((here, checkout))
}

/// The repository as run records name it, `repoKey` in `lib/repo-key.mjs`: the parent of a common
/// git directory named `.git` (a plain checkout and its linked worktrees share it), else the work
/// tree's top level, else the common directory, else the directory itself.
fn repo_key(dir: &Path) -> String {
    let common = git::common_dir(dir)
        .ok()
        .filter(|c| !c.contains('\n') && Path::new(c).is_absolute());
    if let Some(c) = &common
        && Path::new(c).file_name().is_some_and(|n| n == ".git")
        && let Some(parent) = Path::new(c).parent()
    {
        return parent.display().to_string();
    }
    let found = git::toplevel(dir)
        .ok()
        .or_else(|| common.map(PathBuf::from));
    found
        .or_else(|| std::fs::canonicalize(dir).ok())
        .unwrap_or_else(|| dir.to_path_buf())
        .display()
        .to_string()
}
