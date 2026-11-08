//! The git half of the preparation, as `lib/source-checkout.mjs` does it (realm @nick/craft, node
//! #430): a shallow, prompt-free copy of a system's source at a tag or a commit, placed in the
//! cache atomically. A branch is refused: the cache keys a copy by its revision and reuses it
//! forever, so a moving name would be served stale. Leftover temporary copies of a run that died
//! are swept once they are an hour old.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::Git;
use super::spec::{is_commit_id, v_spelling};

/// A temporary copy older than this belongs to a run that died, not one still cloning.
const STALE_TMP: Duration = Duration::from_secs(60 * 60);

impl Git {
    /// The revision to fetch: a full commit id as it is, a tag the remote lists, else that tag's
    /// `v` spelling when the remote lists it; refused when it is neither.
    fn resolve(&self, url: &str, rev: &str) -> Result<String, String> {
        if is_commit_id(rev) || self.lists_tag(url, rev)? {
            return Ok(rev.to_owned());
        }
        let v = v_spelling(rev);
        if let Some(v) = &v
            && self.lists_tag(url, v)?
        {
            return Ok(v.clone());
        }
        let nor = v.map(|v| format!(" (nor is {v})")).unwrap_or_default();
        Err(format!(
            "{rev} is not a tag{nor} or a commit — a branch would be cached stale"
        ))
    }

    /// A shallow checkout of `url` at `rev` into the new directory `tmp`, without `.git`. A tag
    /// is fetched by its full ref name, as a commit by its id.
    fn checkout(&self, url: &str, rev: &str, tmp: &Path) -> Result<(), String> {
        let dir = tmp.to_string_lossy();
        let want = if is_commit_id(rev) {
            rev.to_owned()
        } else {
            format!("refs/tags/{rev}")
        };
        self.run(&["init", "-q", "--", &dir])?;
        self.run(&["-C", &dir, "fetch", "-q", "--depth", "1", "--", url, &want])?;
        let co = [
            "-C",
            &dir,
            "-c",
            "core.symlinks=false",
            "-c",
            "advice.detachedHead=false",
            "checkout",
            "-q",
            "--detach",
            "FETCH_HEAD",
        ];
        self.run(&co)?;
        std::fs::remove_dir_all(tmp.join(".git")).map_err(|e| e.to_string())
    }
}

/// Removes the `<target>.tmp-*` siblings older than [`STALE_TMP`].
pub fn sweep_stale_tmp(target: &Path, now: SystemTime) {
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
        return;
    };
    let prefix = format!("{}.tmp-", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > STALE_TMP));
        if stale && e.file_name().to_string_lossy().starts_with(&prefix) {
            // Gone already: another run swept it.
            std::fs::remove_dir_all(e.path()).unwrap_or_default();
        }
    }
}

/// The cached copy of `rev`, at the path `target_of` gives a revision: reused when present (its
/// `v` spelling's too, once a run resolved it), else the revision resolved, fetched into a
/// temporary sibling and renamed into place; stale leftovers are swept either way. The revision
/// answered is the resolved one.
///
/// # Errors
/// Why there is no copy, one line.
pub fn cached_copy(
    git: &Git,
    url: &str,
    rev: &str,
    target_of: &dyn Fn(&str) -> PathBuf,
) -> Result<(String, PathBuf), String> {
    let now = SystemTime::now();
    let v = (!is_commit_id(rev)).then(|| v_spelling(rev)).flatten();
    for r in std::iter::once(rev.to_owned()).chain(v) {
        let at = target_of(&r);
        if at.is_dir() {
            sweep_stale_tmp(&at, now);
            return Ok((r, at));
        }
    }
    let resolved = git.resolve(url, rev)?;
    let target = target_of(&resolved);
    place(git, url, &resolved, &target, now)?;
    Ok((resolved, target))
}

/// A name for a temporary sibling no other run picks: this process and the clock's nanoseconds.
fn tmp_of(target: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    let mut name = target.as_os_str().to_owned();
    name.push(format!(".tmp-{}-{nanos:08x}", std::process::id()));
    PathBuf::from(name)
}

/// Fetches `rev` into a temporary sibling of `target` and renames it into place.
fn place(git: &Git, url: &str, rev: &str, target: &Path, now: SystemTime) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not make the cache: {e}"))?;
    }
    sweep_stale_tmp(target, now);
    let tmp = tmp_of(target);
    let drop_tmp = |why: String| {
        std::fs::remove_dir_all(&tmp).unwrap_or_default();
        // Another run placed the same copy first: take it.
        if target.is_dir() { Ok(()) } else { Err(why) }
    };
    if let Err(why) = git.checkout(url, rev, &tmp) {
        return drop_tmp(why);
    }
    std::fs::rename(&tmp, target).or_else(|e| drop_tmp(format!("could not place the copy: {e}")))
}
