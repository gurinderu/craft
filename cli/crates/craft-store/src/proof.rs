//! The proof that a write already filed a record, as `integrations/shared/finalize-proof.mjs` leaves and reads it
//! (realm @nick/craft, nodes #245, #246): under `<store>/.finalize-proofs/<key>`, the key a hash of
//! what a re-dispatch sends again — so a retry by either writer finds the other's proof.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::git::lexical;
use crate::js::{Js, Obj, parse};

const PROOF_DIR: &str = ".finalize-proofs";
const RETRY_MAX_AGE: Duration = Duration::from_hours(1);
const DIR_MAX_AGE: Duration = Duration::from_hours(7 * 24);

/// Where a filing happened: the store, the run directory it was told (`""` none), the project.
#[derive(Debug, Clone, Copy)]
pub struct ProofAt<'a> {
    pub store: &'a Path,
    pub dir: &'a str,
    pub project: &'a str,
}

struct Way {
    key: String,
    max_age: Duration,
}

/// `sha256(JSON.stringify(parts))` in hex.
#[must_use]
pub fn hash(parts: Vec<Js>) -> String {
    let digest = Sha256::digest(Js::Arr(parts).compact().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn by_retry(record: &Obj, at: ProofAt<'_>) -> Way {
    Way {
        key: hash(vec![
            Js::Obj(record.clone()),
            Js::str(at.dir),
            Js::str(at.project),
        ]),
        max_age: RETRY_MAX_AGE,
    }
}

/// Only a run directory directly under the store's `.partial` names a proof by directory.
fn by_run_dir(record: &Obj, at: ProofAt<'_>) -> Option<Way> {
    let dir = Path::new(at.dir);
    let parent = lexical(dir.parent()?);
    if at.dir.is_empty() || parent != lexical(&at.store.join(".partial")) {
        return None;
    }
    let base = dir.file_name()?.to_string_lossy().into_owned();
    Some(Way {
        key: format!("dir-{}", hash(vec![Js::Obj(record.clone()), Js::str(base)])),
        max_age: DIR_MAX_AGE,
    })
}

/// The record an identical `--retry` filing already put in the store, with the warnings that filing
/// printed; `None` when none is proven.
#[must_use]
pub fn filed_before(record: &Obj, at: ProofAt<'_>) -> Option<(PathBuf, Vec<String>)> {
    read_proof(at.store, &by_retry(record, at))
}

pub(crate) fn filed_for(
    record: &Obj,
    at: ProofAt<'_>,
    retry: bool,
) -> Option<(PathBuf, Vec<String>)> {
    by_run_dir(record, at)
        .and_then(|way| read_proof(at.store, &way))
        .or_else(|| retry.then(|| filed_before(record, at)).flatten())
}

pub(crate) fn filing_proofs(
    record: &Obj,
    at: ProofAt<'_>,
    file: &Path,
    warnings: &[String],
) -> Vec<Js> {
    let warnings = warnings
        .iter()
        .filter(|l| l.starts_with("craft-log-run WARNING"))
        .map(Js::str)
        .collect::<Vec<_>>();
    let base = file.file_name().unwrap_or_default().to_string_lossy();
    std::iter::once(by_retry(record, at))
        .chain(by_run_dir(record, at))
        .map(|way| {
            Js::Obj(
                Obj::new()
                    .with("file", Js::str(base.as_ref()))
                    .with("key", Js::str(&way.key))
                    .with("warnings", Js::Arr(warnings.clone())),
            )
        })
        .collect()
}

fn read_proof(store: &Path, way: &Way) -> Option<(PathBuf, Vec<String>)> {
    let proof = store.join(PROOF_DIR).join(&way.key);
    let age = std::fs::metadata(&proof).ok()?.modified().ok()?.elapsed();
    if age.is_ok_and(|a| a > way.max_age) {
        return None;
    }
    let p = parse(&std::fs::read_to_string(&proof).ok()?).ok()?;
    let p = p.as_obj()?;
    let named = p
        .get("file")
        .map(Js::to_js_string)
        .transpose()
        .ok()?
        .unwrap_or_default();
    let file = store.join(Path::new(&named).file_name()?);
    if p.get("key").and_then(Js::as_str) != Some(way.key.as_str()) || !file.exists() {
        return None;
    }
    let warnings = p
        .get("warnings")
        .and_then(Js::as_arr)
        .map(|w| {
            w.iter()
                .map(Js::to_js_string)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
        .ok()?
        .unwrap_or_default();
    Some((file, warnings))
}

/// Leaves (or rewrites) the proof of a filed record, both ways when it names a run directory.
/// Atomic updates preserve the proof the filing transaction already left.
///
/// # Errors
/// When a proof cannot be durably published.
pub fn leave(
    record: &Obj,
    at: ProofAt<'_>,
    file: &Path,
    warnings: &[String],
) -> Result<(), crate::StoreError> {
    let root = at.store.join(PROOF_DIR);
    std::fs::create_dir_all(&root).map_err(|e| crate::StoreError::io(&root, &e))?;
    prune(&root);
    let warnings: Vec<Js> = warnings
        .iter()
        .filter(|l| l.starts_with("craft-log-run WARNING"))
        .map(Js::str)
        .collect();
    let base = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    for way in std::iter::once(by_retry(record, at)).chain(by_run_dir(record, at)) {
        let body = Obj::new()
            .with("file", Js::str(&base))
            .with("key", Js::str(&way.key))
            .with("warnings", Js::Arr(warnings.clone()));
        crate::write::publish_proof(&root.join(&way.key), &Js::Obj(body).compact())?;
    }
    crate::write::sync_filing_path(at.store)
}

fn prune(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(DIR_MAX_AGE);
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|m| cutoff.is_some_and(|c| m < c));
        if old {
            drop(std::fs::remove_file(e.path()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_the_javascript_ones_hash() {
        // node -e "…crypto.createHash('sha256').update(JSON.stringify([{a:1,'2':[true,null]},'/d','/p'])).digest('hex')"
        let rec = parse(r#"{"a":1,"2":[true,null]}"#).unwrap();
        assert_eq!(
            hash(vec![rec, Js::str("/d"), Js::str("/p")]),
            "79ab4e51bc9bf8f44806b9083c1674b6124ba88c81d914a9eca6c2c73d55e95a"
        );
    }

    #[test]
    fn a_retry_finds_the_proof_a_filing_left() {
        let d = tempfile::tempdir().unwrap();
        let rec = parse(r#"{"verdict":"Approve"}"#).unwrap();
        let rec = rec.as_obj().unwrap();
        let file = d.path().join("r.json");
        std::fs::write(&file, "{}").unwrap();
        let at = ProofAt {
            store: d.path(),
            dir: "",
            project: "/p",
        };
        assert_eq!(filed_before(rec, at), None);
        leave(
            rec,
            at,
            &file,
            &["craft-log-run WARNING: x".into(), "other".into()],
        )
        .unwrap();
        assert_eq!(
            filed_before(rec, at),
            Some((file, vec!["craft-log-run WARNING: x".to_owned()]))
        );
    }
}
