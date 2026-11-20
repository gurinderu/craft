//! One record into the store, as `writeRecord` in `lib/craft-log-run.mjs` files it: the fields the
//! writer owns stamped over the caller's, the file claimed exclusively under a name stepped a second
//! on a collision (or written over the record `recover` filed for the same run), read back, and its
//! index line appended — or its row replaced — under the index lock.

use std::path::{Path, PathBuf};

use crate::StoreError;
use crate::git::{GitId, git};
use crate::js::{Js, Obj, parse};
use crate::lock::{append_index_line, with_index_lock};
use crate::record::{ENGINE_REVISION, filename, index_projection};
use crate::time::stamp;

const README: &str = include_str!("store-readme.md");

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

impl Writing {
    /// The fields the writer owns (`computedFields`), at `ms`.
    fn computed(&self, ms: i64) -> Obj {
        let mut o = Obj::new()
            .with("engineRevision", Js::Num(ENGINE_REVISION))
            .with("ts", Js::str(stamp(ms)))
            .with("project", Js::str(&self.project));
        if self.observe {
            let commit = git(&["rev-parse", "--short", "HEAD"], &self.workdir);
            let dirty = !git(&["status", "--porcelain"], &self.workdir).is_empty();
            o.set("commit", Js::str(commit));
            o.set("dirty", Js::Bool(dirty));
        }
        let craft = self.craft_commit.clone().filter(|c| !c.is_empty());
        o.set("craftCommit", craft.map_or(Js::Null, Js::Str));
        let session = (!self.session.is_empty()).then(|| Js::str(&self.session));
        o.set("session", session.unwrap_or(Js::Null));
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

/// Files `input` as a record: `git_id` applied to it, the computed fields stamped, the file
/// written — over `over`, the record `recover` filed for this run, when that still fits — read
/// back, and indexed. The file and the record as filed.
///
/// # Errors
/// When the store cannot be written, the readback disagrees or the index cannot be appended.
pub fn write_record(
    input: &Obj,
    w: &Writing,
    git_id: &GitId,
    over: Option<&Path>,
) -> Result<(PathBuf, Obj), StoreError> {
    std::fs::create_dir_all(&w.store).map_err(|e| StoreError::io(&w.store, &e))?;
    let raw = with_git(input, git_id);
    let replaced = over.and_then(|o| replace_record_file(&raw, o, w).transpose());
    let (file, record, replaced) = match replaced {
        Some(r) => r.map(|(f, rec)| (f, rec, true))?,
        None => claim_record_file(&raw, w).map(|(f, rec)| (f, rec, false))?,
    };
    verify_written(&file, &record)?;
    if let Err(e) = index_filed(&w.store, &record, replaced) {
        if !replaced {
            drop(std::fs::remove_file(&file));
        }
        return Err(e);
    }
    ensure_readme(&w.store);
    Ok((file, record))
}

fn index_filed(store: &Path, record: &Obj, replaced: bool) -> Result<(), StoreError> {
    let line = Js::Obj(index_projection(record)).compact();
    if replaced {
        replace_index_row(store, record, &line)
    } else {
        append_index_line(store, &line)
    }
}

/// The record claimed under a fresh name: written exclusively, the stamp stepped a second on a
/// collision, sixty times at most.
fn claim_record_file(raw: &Obj, w: &Writing) -> Result<(PathBuf, Obj), StoreError> {
    for bump in 0..60 {
        let mut record = raw.clone();
        record.spread(&w.computed(w.now + bump * 1000));
        let file = w.store.join(filename(&record));
        let made = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file);
        match made {
            Ok(mut f) => {
                std::io::Write::write_all(&mut f, Js::Obj(record.clone()).pretty().as_bytes())
                    .map_err(|e| StoreError::io(&file, &e))?;
                return Ok((file, record));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(StoreError::io(&file, &e)),
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
) -> Result<Option<(PathBuf, Obj)>, StoreError> {
    let in_store = over.parent().map(crate::git::lexical) == Some(crate::git::lexical(&w.store));
    let prev = std::fs::read_to_string(over)
        .ok()
        .and_then(|t| parse(&t).ok());
    let (true, Some(Js::Obj(prev))) = (in_store, prev) else {
        return Ok(None);
    };
    let mut record = raw.clone();
    record.spread(&w.computed(w.now));
    record.set("ts", prev.get("ts").cloned().unwrap_or(Js::Null));
    if over.file_name().is_none_or(|n| *n != *filename(&record)) {
        return Ok(None);
    }
    write_atomically(over, &Js::Obj(record.clone()).pretty())?;
    Ok(Some((over.to_path_buf(), record)))
}

/// The record's row of the index replaced — or appended when it has none — under the lock.
fn replace_index_row(store: &Path, record: &Obj, row: &str) -> Result<(), StoreError> {
    let want = filename(record);
    with_index_lock(store, || {
        let file = store.join("index.jsonl");
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
        if lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        let names = |l: &String| {
            parse(l)
                .ok()
                .and_then(|v| v.as_obj().map(filename))
                .is_some_and(|n| n == want)
        };
        match lines.iter().position(names) {
            Some(i) => {
                if let Some(l) = lines.get_mut(i) {
                    row.clone_into(l);
                }
            }
            None => lines.push(row.to_owned()),
        }
        write_atomically(&file, &format!("{}\n", lines.join("\n")))
    })
}

/// `writeFileAtomically`: a temporary file beside `file`, renamed over it; removed when that fails.
///
/// # Errors
/// When the temporary file cannot be written or renamed.
pub fn write_atomically(file: &Path, content: &str) -> Result<(), StoreError> {
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = file.with_file_name(format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        crate::time::now_ms()
    ));
    let done = std::fs::write(&tmp, content).and_then(|()| std::fs::rename(&tmp, file));
    done.map_err(|e| {
        drop(std::fs::remove_file(&tmp));
        StoreError::io(file, &e)
    })
}

/// The readback: every key the record holds is in the file, every array as long.
fn verify_written(file: &Path, record: &Obj) -> Result<(), StoreError> {
    let text = std::fs::read_to_string(file).map_err(|e| StoreError::io(file, &e))?;
    let back = parse(&text).map_err(|e| StoreError::Refused(format!("readback: {e}")))?;
    let back = back
        .as_obj()
        .ok_or_else(|| StoreError::Refused("readback: not a JSON object".into()))?;
    let lost: Vec<&str> = record
        .iter()
        .filter(|(k, _)| !back.has(k))
        .map(|(k, _)| k.as_str())
        .collect();
    if !lost.is_empty() {
        return Err(StoreError::Refused(format!(
            "readback lost key(s): {}",
            lost.join(", ")
        )));
    }
    for (k, v) in record.iter() {
        if let Js::Arr(a) = v
            && back.get(k).and_then(Js::as_arr).map(<[Js]>::len) != Some(a.len())
        {
            return Err(StoreError::Refused(format!("readback changed array '{k}'")));
        }
    }
    Ok(())
}

fn ensure_readme(store: &Path) {
    let file = store.join("README.md");
    if !file.exists() {
        drop(std::fs::write(file, README));
    }
}
