//! A run's phase checkpoints, as `lib/craft-log-run.mjs` keeps them: `<store>/.partial/<ts>-<kind>-<name>/NN-<phase>.json`,
//! the directory minted by the first and rejoined by a later one only on proof that it is this
//! run's — the project, branch and head its checkpoints attest to agree, exactly one directory
//! does, it was written within six hours and it is neither finalized nor kept by `recover`.

use std::path::{Path, PathBuf};

use crate::StoreError;
use crate::js::{Js, Obj, parse};
use crate::record::{ENGINE_REVISION, filename};
use crate::time::{iso, stamp, stamp_ms};

pub(crate) const PARTIAL_DIR: &str = ".partial";
pub(crate) const FINALIZED_MARKER: &str = ".finalized";
pub(crate) const KEPT_LIVE_MARKER: &str = ".recovered-live";
const REJOIN_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;

/// What identifies a run inside a checkpoint (`checkpointIdentity`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub project: String,
    pub branch: String,
    pub head: String,
}

impl Identity {
    #[must_use]
    pub fn of(o: &Obj) -> Self {
        Self {
            project: o.text("project").to_owned(),
            branch: o.text("branch").to_owned(),
            head: o.text("head").to_owned(),
        }
    }
}

/// The identity a directory's checkpoints attest to (`dirIdentity`): per field the first value
/// given, `None` where two disagree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attested {
    pub project: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
}

#[must_use]
pub fn attested(phases: &[Obj]) -> Attested {
    let mut out = Attested {
        project: Some(String::new()),
        branch: Some(String::new()),
        head: Some(String::new()),
    };
    for p in phases {
        let id = Identity::of(p);
        for (have, got) in [
            (&mut out.project, id.project),
            (&mut out.branch, id.branch),
            (&mut out.head, id.head),
        ] {
            match have {
                _ if got.is_empty() => {}
                Some(h) if h.is_empty() => *h = got,
                Some(h) if *h != got => *have = None,
                Some(_) | None => {}
            }
        }
    }
    out
}

/// `identityAgrees`: the projects equal and given, branch and head disagreeing on neither side.
#[must_use]
pub fn agrees(want: &Identity, have: &Attested) -> bool {
    let disagrees = |w: &str, h: &Option<String>| match h {
        None => true,
        Some(h) => !w.is_empty() && !h.is_empty() && w != h,
    };
    let same_project = have.project.as_deref() == Some(&want.project);
    !want.project.is_empty()
        && same_project
        && !disagrees(&want.branch, &have.branch)
        && !disagrees(&want.head, &have.head)
}

/// Whether `dir` is under the store's `.partial` (`insideStore`), symlinks resolved as far as the
/// path exists.
#[must_use]
pub fn inside_store(dir: &str, store: &Path) -> bool {
    !dir.is_empty() && contains_path(&store.join(PARTIAL_DIR), Path::new(dir))
}

fn resolved(p: &Path) -> Option<PathBuf> {
    let abs = crate::git::lexical(&std::path::absolute(p).ok()?);
    let mut tail = Vec::new();
    let mut at = abs.as_path();
    loop {
        match std::fs::canonicalize(at) {
            Ok(real) => return Some(tail.iter().rev().fold(real, |p, c| p.join(c))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tail.push(at.file_name()?.to_owned());
                at = at.parent()?;
            }
            Err(_) => return None,
        }
    }
}

/// `containsPath`: `child` strictly inside `parent`, both resolved; `false` when either cannot be.
#[must_use]
pub fn contains_path(parent: &Path, child: &Path) -> bool {
    match (resolved(parent), resolved(child)) {
        (Some(root), Some(abs)) => abs != root && abs.starts_with(&root),
        _ => false,
    }
}

/// The checkpoints in `dir`, in order: each file `NN-….json` read as an object, or a stand-in naming
/// it unreadable; none when `dir` is gone.
///
/// # Errors
/// When `dir` is there and cannot be listed.
pub fn read_checkpoints(dir: &Path) -> Result<Vec<Obj>, String> {
    read_checkpoint_files(dir, false)
}

fn read_checkpoint_files(dir: &Path, strict: bool) -> Result<Vec<Obj>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut names =
        checkpoint_names(entries.map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned())))?;
    names.sort();
    names
        .into_iter()
        .map(|n| {
            let read = std::fs::read_to_string(dir.join(&n)).map_err(|e| e.to_string());
            match read.and_then(|t| parse(&t).map_err(|e| e.to_string())) {
                Ok(Js::Obj(o)) => Ok(o),
                other => {
                    let why = match other {
                        Ok(_) => "not a JSON object".to_owned(),
                        Err(e) => e,
                    };
                    if strict {
                        Err(format!("{n}: {why}"))
                    } else {
                        Ok(unreadable(&n, &why))
                    }
                }
            }
        })
        .collect()
}

fn checkpoint_names(
    entries: impl Iterator<Item = std::io::Result<String>>,
) -> Result<Vec<String>, String> {
    let directory_entries = entries
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(directory_entries
        .into_iter()
        .filter(|n| is_slice(n) && n.ends_with(".json"))
        .collect())
}

fn unreadable(name: &str, why: &str) -> Obj {
    Obj::new()
        .with("phase", Js::str(name))
        .with("unreadable", Js::str(why))
}

fn is_slice(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 3 && b.iter().take(2).all(u8::is_ascii_digit) && b.get(2) == Some(&b'-')
}

/// The directory a checkpoint of the run named `kind`/`name` goes to: the one rejoined when asked
/// and proven, else a fresh one minted.
///
/// # Errors
/// When no directory can be made.
pub fn checkpoint_dir(
    record: &Obj,
    store: &Path,
    want: &Identity,
    rejoin: bool,
    now: i64,
) -> Result<PathBuf, StoreError> {
    if rejoin && let Some(found) = find_rejoinable(record, store, want, now)? {
        return Ok(found);
    }
    mint(record, store, now)
}

/// The one unfinalized directory of the same kind and name whose checkpoints prove `want`.
/// # Errors
/// When a possible run or the directory containing runs cannot be listed.
pub fn find_rejoinable(
    record: &Obj,
    store: &Path,
    want: &Identity,
    now: i64,
) -> Result<Option<PathBuf>, StoreError> {
    let root = store.join(PARTIAL_DIR);
    if want.project.is_empty() {
        return Ok(None);
    }
    let mut named = record.clone();
    named.set("ts", Js::str(""));
    let suffix = filename(&named);
    let suffix = suffix.trim_start_matches('-').trim_end_matches(".json");
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(StoreError::io(&root, &e)),
    };
    let directory_entries = entries
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| StoreError::io(&root, &e))?;
    let candidates = directory_entries
        .into_iter()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(&format!("-{suffix}")))
        .filter(|n| {
            let at = n
                .get(..20)
                .filter(|_| n.as_bytes().get(20) == Some(&b'-'))
                .and_then(stamp_ms);
            at.is_some_and(|at| (0..=REJOIN_WINDOW_MS).contains(&(now - at)))
        })
        .map(|n| root.join(n))
        .filter(|d| !d.join(FINALIZED_MARKER).exists() && !d.join(KEPT_LIVE_MARKER).exists())
        .collect::<Vec<_>>();
    let mut found = Vec::new();
    for d in candidates {
        let phases = read_checkpoint_files(&d, true)
            .map_err(|e| StoreError::Refused(format!("cannot read {}: {e}", d.display())))?;
        if !phases.is_empty() && agrees(want, &attested(&phases)) {
            found.push(d);
        }
    }
    match found.as_slice() {
        [one] => Ok(Some(one.clone())),
        _ => Ok(None),
    }
}

fn mint(record: &Obj, store: &Path, now: i64) -> Result<PathBuf, StoreError> {
    let root = store.join(PARTIAL_DIR);
    let mut remakes = 0;
    let mut bump = 0;
    while bump < 60 {
        let mut named = record.clone();
        named.set("ts", Js::str(stamp(now + bump * 1000)));
        let name = filename(&named);
        let dir = root.join(name.trim_end_matches(".json"));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => bump += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && remakes < 2 => {
                remakes += 1;
                std::fs::create_dir_all(&root).map_err(|e| StoreError::io(&root, &e))?;
            }
            Err(e) => return Err(StoreError::io(&dir, &e)),
        }
    }
    Err(StoreError::Refused(format!(
        "cannot mint a partial directory under {} — 60 consecutive stamps taken",
        root.display()
    )))
}

/// Writes one checkpoint into `dir`: `{ phase, ...payload, at, project, session, engineRevision }`.
///
/// # Errors
/// When the directory or the file cannot be written.
pub fn write_checkpoint(
    dir: &Path,
    phase: &str,
    payload: &Obj,
    (project, session): (&str, &str),
    now: i64,
) -> Result<PathBuf, StoreError> {
    std::fs::create_dir_all(dir).map_err(|e| StoreError::io(dir, &e))?;
    let entries = std::fs::read_dir(dir)
        .map_err(|e| StoreError::io(dir, &e))?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| StoreError::io(dir, &e))?;
    let seq = entries
        .into_iter()
        .filter(|e| is_slice(&e.file_name().to_string_lossy()))
        .count();
    let safe: String = phase
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let file = dir.join(format!("{seq:02}-{safe}.json"));
    let mut slice = Obj::new().with("phase", Js::str(phase));
    slice.spread(payload);
    slice.set("at", Js::str(iso(now)));
    if !project.is_empty() {
        slice.set("project", Js::str(project));
    }
    if !session.is_empty() {
        slice.set("session", Js::str(session));
    }
    slice.set("engineRevision", Js::Num(ENGINE_REVISION));
    std::fs::write(&file, Js::Obj(slice).pretty()).map_err(|e| StoreError::io(&file, &e))?;
    Ok(file)
}

#[cfg(test)]
mod enumeration_tests {
    use super::{Identity, checkpoint_dir, checkpoint_names};
    use crate::js::{Js, Obj};

    #[test]
    fn rejoin_refuses_a_candidate_with_a_corrupt_checkpoint() {
        for matching in [false, true] {
            let d = tempfile::tempdir().unwrap();
            let candidate = d
                .path()
                .join(".partial/1970-01-01T00-00-00Z-workflow-review");
            std::fs::create_dir_all(&candidate).unwrap();
            if matching {
                std::fs::write(candidate.join("00-good.json"), r#"{"project":"/p"}"#).unwrap();
            }
            std::fs::write(candidate.join("01-bad.json"), "{").unwrap();
            let record = Obj::new()
                .with("kind", Js::str("workflow"))
                .with("name", Js::str("review"));
            let want = Identity {
                project: "/p".into(),
                ..Identity::default()
            };
            let error = checkpoint_dir(&record, d.path(), &want, true, 0).unwrap_err();
            assert!(error.to_string().contains("01-bad.json"));
            assert!(candidate.join("01-bad.json").exists());
            assert_eq!(
                std::fs::read_dir(d.path().join(".partial"))
                    .unwrap()
                    .count(),
                1
            );
        }
    }

    #[test]
    fn an_entry_error_refuses_a_partial_checkpoint_listing() {
        let entries = vec![
            Ok("00-start.json".to_owned()),
            Err(std::io::Error::other("listing failed")),
        ];
        assert_eq!(
            checkpoint_names(entries.into_iter()).unwrap_err(),
            "listing failed"
        );
    }

    #[test]
    fn rejoin_does_not_mint_a_new_run_if_a_candidate_cannot_be_read() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join(".partial");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("1970-01-01T00-00-00Z-workflow-review"),
            "not a directory",
        )
        .unwrap();
        let record = Obj::new()
            .with("kind", Js::str("workflow"))
            .with("name", Js::str("review"));
        let want = Identity {
            project: "/p".into(),
            ..Identity::default()
        };
        checkpoint_dir(&record, d.path(), &want, true, 0).unwrap_err();
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 1);
    }
}
