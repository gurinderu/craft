//! One record into the store, as `writeRecord` in `integrations/shared/craft-log-run.mjs` files it: the fields the
//! writer owns stamped over the caller's. A durable intent precedes publication; staged bytes are
//! read back before an exclusive link or replacement. Detail, index and proof replay under the index
//! lock; a conflicting detail is left untouched with its intent retained (#555, #556, #559).

use std::path::{Path, PathBuf};

use crate::StoreError;
use crate::git::{GitId, git};
use crate::js::{Js, Obj, parse};
use crate::lock::with_index_lock;
use crate::record::{ENGINE_REVISION, filename};
use crate::time::stamp;

const README: &str = include_str!("store-readme.md");
#[path = "filing.rs"]
mod filing;

/// What every write of one call knows: where, for which repository, as which session and clock.
#[derive(Debug, Clone)]
pub struct Writing {
    pub store: PathBuf,
    /// The repository as the store keys it (`repoKey`).
    pub project: String,
    /// The working copy the caller pointed at, which git is read off.
    pub workdir: PathBuf,
    pub session: String,
    /// The branch and head read off `workdir` now; empty when the payload carries the run's own.
    pub git_id: GitId,
    /// Whether `commit` and `dirty` are read off the working copy (not when the payload carries them).
    pub observe: bool,
    /// The writing craft's own commit, `None` when it is not a checkout.
    pub craft_commit: Option<String>,
    /// Milliseconds since the epoch.
    pub now: i64,
}

/// The working copy's commit and dirtiness, read once per filing — not again on each stamp a
/// collision steps to; `None` when the payload carries the run's own.
type Observed = Option<(String, bool)>;

impl Writing {
    fn observed(&self) -> Observed {
        self.observe.then(|| {
            let commit = git(&["rev-parse", "--short", "HEAD"], &self.workdir);
            let dirty = !git(&["status", "--porcelain"], &self.workdir).is_empty();
            (commit, dirty)
        })
    }

    /// The fields the writer owns (`computedFields`), at `ms`.
    fn computed(&self, ms: i64, observed: &Observed) -> Obj {
        let mut o = Obj::new()
            .with("engineRevision", Js::Num(ENGINE_REVISION))
            .with("ts", Js::str(stamp(ms)))
            .with("project", Js::str(&self.project));
        if let Some((commit, dirty)) = observed {
            o.set("commit", Js::str(commit));
            o.set("dirty", Js::Bool(*dirty));
        }
        let craft = self.craft_commit.clone().filter(|c| !c.is_empty());
        o.set("craftCommit", craft.map_or(Js::Null, Js::str));
        let session = (!self.session.is_empty()).then(|| Js::str(&self.session));
        o.set("session", session.unwrap_or(Js::Null));
        // A git probe this write killed past its bound left its field empty: the record says which.
        let slow = crate::git::timed_out();
        if !slow.is_empty() {
            o.set(
                "gitTimedOut",
                Js::Arr(slow.into_iter().map(Js::str).collect()),
            );
        }
        o
    }
}

/// `raw` with `branch` and `head` set where git had an answer (`applyGitIdentity`).
#[must_use]
pub fn with_git(raw: &Obj, id: &GitId) -> Obj {
    let mut out = raw.clone();
    for (k, v) in [("branch", &id.branch), ("head", &id.head)] {
        if !v.is_empty() {
            out.set(k, Js::str(v));
        }
    }
    out
}

/// Files `input` as a new, independent record, replacing `over` when it still fits. Pending intents
/// are replayed first under the index lock. A failed publication retains recovery evidence; no
/// published detail is unlinked on error. Explicit retry identity is supplied by `finalize`.
///
/// # Errors
/// When staging, intent, detail, index or proof publication fails, or replay sees a conflicting detail.
pub fn write_record(
    input: &Obj,
    w: &Writing,
    git_id: &GitId,
    over: Option<&Path>,
) -> Result<(PathBuf, Obj), StoreError> {
    write_proven(input, w, git_id, over, None)
}

#[derive(Clone, Copy)]
pub(crate) struct Proof<'a> {
    pub raw: &'a Obj,
    pub at: crate::proof::ProofAt<'a>,
    pub retry: bool,
    pub warnings: &'a [String],
    pub finalizing: Option<&'a Path>,
}

pub(crate) fn recover_filings(store: &Path) -> Result<(), StoreError> {
    if !store.join(".filing-intents").exists() {
        return Ok(());
    }
    std::fs::create_dir_all(store).map_err(|e| StoreError::io(store, &e))?;
    with_index_lock(store, || filing::recover(store))
}

pub(crate) fn retire_finalized(dir: &Path, store: &Path) -> Result<(), StoreError> {
    filing::retire(dir, store)
}

pub(crate) fn publish_proof(file: &Path, text: &str) -> Result<(), StoreError> {
    filing::publish(file, text, true)
}

pub(crate) fn sync_filing_path(file: &Path) -> Result<(), StoreError> {
    filing::sync(file)
}

pub(crate) fn write_proven(
    input: &Obj,
    w: &Writing,
    git_id: &GitId,
    over: Option<&Path>,
    proof: Option<Proof<'_>>,
) -> Result<(PathBuf, Obj), StoreError> {
    std::fs::create_dir_all(&w.store).map_err(|e| StoreError::io(&w.store, &e))?;
    let raw = with_git(input, git_id);
    let seen = w.observed();
    with_index_lock(&w.store, || {
        filing::recover(&w.store)?;
        if let Some(p) = &proof
            && let Some((file, _)) = crate::proof::filed_for(p.raw, p.at, p.retry)
        {
            let text = std::fs::read_to_string(&file).map_err(|e| StoreError::io(&file, &e))?;
            let record = parse(&text)
                .ok()
                .and_then(|v| v.as_obj().cloned())
                .ok_or_else(|| StoreError::Refused("invalid filed record".into()))?;
            return Ok((file, record));
        }
        let replaced = over.and_then(|o| replace_record_file(&raw, o, w, &seen));
        let (file, record, before) = match replaced {
            Some((f, rec, before)) => (f, rec, Some(before)),
            None => claim_record_file(&raw, w, &seen).map(|(f, rec)| (f, rec, None))?,
        };
        let proofs = proof.as_ref().map_or_else(Vec::new, |p| {
            crate::proof::filing_proofs(p.raw, p.at, &file, p.warnings)
        });
        let finalizing = proof.as_ref().and_then(|p| p.finalizing);
        filing::commit(&w.store, &file, &record, before, proofs, finalizing)?;
        ensure_readme(&w.store);
        Ok((file, record))
    })
}

/// Plans a fresh name under the lock, stepping the stamp on collision, sixty times at most.
/// The transaction subsequently claims it by exclusive link, respecting legacy ordinary writers.
fn claim_record_file(
    raw: &Obj,
    w: &Writing,
    seen: &Observed,
) -> Result<(PathBuf, Obj), StoreError> {
    for bump in 0..60 {
        let mut record = raw.clone();
        record.spread(&w.computed(w.now + bump * 1000, seen));
        let file = w.store.join(filename(&record));
        if !file.exists() {
            return Ok((file, record));
        }
    }
    Err(StoreError::Refused(format!(
        "cannot claim a record name under {} — 60 consecutive stamps taken",
        w.store.display()
    )))
}

/// The record written over the one `recover` filed for this run, keeping its `ts`; `None` when that
/// file is gone, unreadable or names another run.
fn replace_record_file(
    raw: &Obj,
    over: &Path,
    w: &Writing,
    seen: &Observed,
) -> Option<(PathBuf, Obj, String)> {
    let in_store = over.parent().map(crate::git::lexical) == Some(crate::git::lexical(&w.store));
    let before = std::fs::read_to_string(over).ok();
    let prev = before.as_deref().and_then(|t| parse(t).ok());
    let (true, Some(Js::Obj(prev)), Some(before)) = (in_store, prev, before) else {
        return None;
    };
    let mut record = raw.clone();
    record.spread(&w.computed(w.now, seen));
    record.set("ts", prev.get("ts").cloned().unwrap_or(Js::Null));
    if over.file_name().is_none_or(|n| *n != *filename(&record)) {
        return None;
    }
    Some((over.to_path_buf(), record, before))
}

/// The record's row of the index replaced — or appended when it has none — under the lock. Every
/// other line is kept byte for byte, one that is not UTF-8 or not JSON too; an index that cannot be
/// read fails the write and is left as it is, never replaced by what a failed read gave.
#[cfg(test)]
fn replace_index_row(store: &Path, record: &Obj, row: &str) -> Result<(), StoreError> {
    with_index_lock(store, || replace_index_row_locked(store, record, row))
}

fn replace_index_row_locked(store: &Path, record: &Obj, row: &str) -> Result<(), StoreError> {
    let want = filename(record);
    let file = store.join("index.jsonl");
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(StoreError::io(&file, &e)),
    };
    let mut lines: Vec<&[u8]> = bytes.split(|b| *b == b'\n').collect();
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let names = |l: &&[u8]| {
        std::str::from_utf8(l)
            .ok()
            .and_then(|t| parse(t).ok())
            .and_then(|v| v.as_obj().map(filename))
            .is_some_and(|n| n == want)
    };
    match lines.iter().position(names) {
        Some(i) => {
            if let Some(l) = lines.get_mut(i) {
                *l = row.as_bytes();
            }
        }
        None => lines.push(row.as_bytes()),
    }
    let mut out = lines.join(&b'\n');
    out.push(b'\n');
    write_atomically(&file, &out)
}

/// `writeFileAtomically`: a temporary file beside `file`, renamed over it; removed when that fails.
///
/// # Errors
/// When the temporary file cannot be written or renamed.
pub fn write_atomically(file: &Path, content: impl AsRef<[u8]>) -> Result<(), StoreError> {
    write_atomically_using(file, content.as_ref(), |p, b| std::fs::write(p, b))
}

pub(crate) fn write_atomically_using(
    file: &Path,
    content: &[u8],
    write: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), StoreError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut tmp = None;
    for _ in 0..60 {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = file.with_file_name(format!(
            ".{name}.{}-{}-{n}.tmp",
            std::process::id(),
            crate::time::now_ms()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(f) => {
                drop(f);
                tmp = Some(path);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(StoreError::io(&path, &e)),
        }
    }
    let tmp = tmp.ok_or_else(|| StoreError::Refused("60 temporary file names are taken".into()))?;
    let done = write(&tmp, content).and_then(|()| std::fs::rename(&tmp, file));
    done.map_err(|e| {
        drop(std::fs::remove_file(&tmp));
        StoreError::io(file, &e)
    })
}

fn ensure_readme(store: &Path) {
    let file = store.join("README.md");
    if !file.exists() {
        drop(std::fs::write(file, README));
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn concurrent_atomic_writes_use_distinct_temporary_files() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("00-phase.json");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            for content in [b"one".as_slice(), b"two".as_slice()] {
                let barrier = barrier.clone();
                let tx = tx.clone();
                let file = &file;
                scope.spawn(move || {
                    write_atomically_using(file, content, |tmp, bytes| {
                        tx.send(tmp.to_owned()).unwrap();
                        barrier.wait();
                        std::fs::write(tmp, bytes)
                    })
                    .unwrap();
                });
            }
        });
        let a = rx.recv().unwrap();
        let b = rx.recv().unwrap();
        assert_ne!(a, b);
        let contents = std::fs::read(file).unwrap();
        assert!(contents == b"one" || contents == b"two");
    }
    use crate::js::parse;

    fn record(ts: &str) -> Obj {
        parse(&format!(
            r#"{{"ts":"{ts}","kind":"workflow","name":"review"}}"#
        ))
        .unwrap()
        .as_obj()
        .unwrap()
        .clone()
    }

    #[test]
    fn failed_index_replacement_keeps_the_new_record_for_a_retry() {
        let d = tempfile::tempdir().unwrap();
        let previous = record("2026-03-04T05-00-00Z");
        let file = d.path().join(filename(&previous));
        let old = Js::Obj(previous).pretty();
        std::fs::write(&file, &old).unwrap();
        std::fs::create_dir(d.path().join("index.jsonl")).unwrap();
        let w = Writing {
            store: d.path().to_path_buf(),
            project: "/p".into(),
            workdir: d.path().to_path_buf(),
            session: String::new(),
            git_id: GitId::default(),
            observe: false,
            craft_commit: None,
            now: 0,
        };
        let result = write_record(&record("x"), &w, &GitId::default(), Some(&file));
        result.unwrap_err();
        assert!(d.path().join(".filing-intents").is_dir());
        let after = std::fs::read_to_string(&file).unwrap();
        assert_ne!(after, old);
        assert_eq!(
            parse(&after)
                .unwrap()
                .as_obj()
                .unwrap()
                .text("project")
                .unwrap(),
            "/p"
        );
        std::fs::remove_dir(d.path().join("index.jsonl")).unwrap();
        std::fs::write(
            d.path().join("index.jsonl"),
            format!("{}\n", Js::Obj(record("2026-03-04T05-00-00Z")).compact()),
        )
        .unwrap();
        write_record(&record("x"), &w, &GitId::default(), Some(&file)).unwrap();
        let index = std::fs::read_to_string(d.path().join("index.jsonl")).unwrap();
        assert_eq!(index.lines().count(), 1);
        assert_eq!(
            parse(index.trim())
                .unwrap()
                .as_obj()
                .unwrap()
                .text("project")
                .unwrap(),
            "/p"
        );
    }

    #[test]
    fn a_replace_keeps_every_row_an_index_holds_invalid_utf8_among_them() {
        let d = tempfile::tempdir().unwrap();
        let index = d.path().join("index.jsonl");
        let mut text = b"{\"ts\":\"a\",\"kind\":\"workflow\",\"name\":\"review\"}\n".to_vec();
        text.extend_from_slice(b"{\"title\":\"\xff\xfe broken\"}\n");
        text.extend_from_slice(b"{\"ts\":\"b\",\"kind\":\"workflow\",\"name\":\"review\"}\n");
        std::fs::write(&index, &text).unwrap();
        replace_index_row(d.path(), &record("b"), "{\"new\":1}").unwrap();
        let after = std::fs::read(&index).unwrap();
        let mut want = b"{\"ts\":\"a\",\"kind\":\"workflow\",\"name\":\"review\"}\n".to_vec();
        want.extend_from_slice(b"{\"title\":\"\xff\xfe broken\"}\n{\"new\":1}\n");
        assert_eq!(after, want);
    }

    #[test]
    fn a_record_names_the_git_probes_that_timed_out_and_only_then() {
        let d = tempfile::tempdir().unwrap();
        let w = Writing {
            store: d.path().to_path_buf(),
            project: "/p".into(),
            workdir: d.path().to_path_buf(),
            session: String::new(),
            git_id: GitId::default(),
            observe: false,
            craft_commit: None,
            now: 0,
        };
        drop(crate::git::take_timed_out());
        let (_, clean) = write_record(&record("x"), &w, &GitId::default(), None).unwrap();
        assert!(!clean.has("gitTimedOut"));
        crate::git::note_timed_out(&["status", "--porcelain"]);
        crate::git::note_timed_out(&["status", "--porcelain"]);
        let (_, slow) = write_record(&record("x"), &w, &GitId::default(), None).unwrap();
        drop(crate::git::take_timed_out());
        assert_eq!(
            slow.get("gitTimedOut").map(Js::compact).as_deref(),
            Some(r#"["git status --porcelain"]"#)
        );
    }

    #[test]
    fn an_index_that_cannot_be_read_fails_the_replace_and_is_left_untouched() {
        let d = tempfile::tempdir().unwrap();
        let index = d.path().join("index.jsonl");
        std::fs::write(&index, "{\"ts\":\"a\"}\n").unwrap();
        std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o200)).unwrap();
        if std::fs::read(&index).is_ok() {
            return; // run as root: a mode cannot make the file unreadable here
        }
        let got = replace_index_row(d.path(), &record("a"), "{\"new\":1}");
        std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(got.is_err(), "{got:?}");
        assert_eq!(std::fs::read_to_string(&index).unwrap(), "{\"ts\":\"a\"}\n");
    }
}
