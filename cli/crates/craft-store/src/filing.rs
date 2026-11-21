//! Recoverable detail/index/proof publication, under the shared index lock (#555, #556, #559).
use crate::{
    StoreError,
    js::{Js, Obj, parse},
};
use std::path::{Path, PathBuf};

const INTENTS: &str = ".filing-intents";
#[path = "filing_io.rs"]
mod io;
pub(super) use io::{publish, retire, sync};
#[path = "filing_replay.rs"]
mod replaying;
use replaying::replay;

fn named(root: &Path, name: &str) -> Result<PathBuf, StoreError> {
    if name.is_empty() || Path::new(name).file_name().is_none_or(|n| n != name) {
        return Err(StoreError::Refused("invalid filing intent name".into()));
    }
    Ok(root.join(name))
}

fn object(text: &str) -> Result<Obj, StoreError> {
    parse(text)
        .ok()
        .and_then(|v| v.as_obj().cloned())
        .ok_or_else(|| StoreError::Refused("invalid filing intent object".into()))
}

/// The words of a retained conflict: which detail, which intent, and how to clear it.
fn conflict(detail: &Path, intent: &Path) -> String {
    format!(
        "filing conflict: {} is not what intent {} expected; intent retained, the detail left as it is — its record may be the run's only copy: to keep it, move the detail aside and `jq -j .record <intent> > <detail>`, and the next write completes the intent; to keep the detail, save that record elsewhere, then delete the intent",
        detail.display(),
        intent.display()
    )
}

/// Replays every pending intent; a conflicting one is retained and skipped, so it never blocks a
/// write to another detail — its warning is returned, and a write to its own detail refuses.
pub(super) fn recover(store: &Path) -> Result<Vec<String>, StoreError> {
    let root = store.join(INTENTS);
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(StoreError::io(&root, &e)),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| StoreError::io(&root, &e))?;
        if entry.file_name().to_string_lossy().ends_with(".json") {
            files.push(entry.path());
        }
    }
    files.sort();
    let mut retained = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).map_err(|e| StoreError::io(&file, &e))?;
        let intent = object(&text)?;
        if !replay(store, &intent)? {
            retained.push(conflict(&named(store, intent.text("file")?)?, &file));
            continue;
        }
        std::fs::remove_file(&file).map_err(|e| StoreError::io(&file, &e))?;
        sync(&root)?;
    }
    Ok(retained)
}

pub(super) fn commit(
    store: &Path,
    file: &Path,
    record: &Obj,
    before: Option<String>,
    proofs: Vec<Js>,
    finalizing: Option<&Path>,
) -> Result<(), StoreError> {
    let root = store.join(INTENTS);
    std::fs::create_dir_all(&root).map_err(|e| StoreError::io(&root, &e))?;
    sync(store)?;
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let intent = Obj::new()
        .with("file", Js::str(name.as_ref()))
        .with("before", before.map_or(Js::Null, Js::str))
        .with("record", Js::str(Js::Obj(record.clone()).pretty()))
        .with("proofs", Js::Arr(proofs))
        .with(
            "finalizing",
            Js::str(finalizing.map_or_else(String::new, |p| p.to_string_lossy().into_owned())),
        );
    let log = root.join(name.as_ref());
    // Under the lock, after `recover`: an intent still here is a retained conflict on this detail.
    if log.exists() {
        return Err(StoreError::Refused(conflict(file, &log)));
    }
    publish(&log, &Js::Obj(intent.clone()).compact(), false)?;
    if !replay(store, &intent)? {
        return Err(StoreError::Refused(conflict(file, &log)));
    }
    std::fs::remove_file(&log).map_err(|e| StoreError::io(&log, &e))?;
    sync(&root)
}
