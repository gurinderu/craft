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

fn current(file: &Path) -> Result<Option<String>, StoreError> {
    match std::fs::read_to_string(file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(StoreError::io(file, &e)),
    }
}

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

fn replay(store: &Path, intent: &Obj) -> Result<(), StoreError> {
    let file = named(store, intent.text("file")?)?;
    mark_finalizing(store, intent.text("finalizing")?)?;
    let text = intent.text("record")?;
    let record = object(text)?;
    let before = intent.get("before").and_then(Js::as_str);
    let now = current(&file)?;
    if now.as_deref() != Some(text) {
        if now.as_deref() != before {
            return Err(StoreError::Refused(format!(
                "filing conflict: {}; intent retained",
                file.display()
            )));
        }
        publish(&file, text, before.is_some())?;
    }
    let row = Js::Obj(crate::record::index_projection(&record)).compact();
    super::replace_index_row_locked(store, &record, &row)?;
    sync(&store.join("index.jsonl"))?;
    sync(store)?;
    for proof in intent.get("proofs").and_then(Js::as_arr).unwrap_or(&[]) {
        let proof = proof
            .as_obj()
            .ok_or_else(|| StoreError::Refused("invalid filing proof".into()))?;
        let root = store.join(".finalize-proofs");
        std::fs::create_dir_all(&root).map_err(|e| StoreError::io(&root, &e))?;
        publish(
            &named(&root, proof.text("key")?)?,
            &Js::Obj(proof.clone()).compact(),
            true,
        )?;
        sync(store)?;
    }
    Ok(())
}

fn mark_finalizing(store: &Path, dir: &str) -> Result<(), StoreError> {
    if dir.is_empty() {
        return Ok(());
    }
    if !crate::checkpoint::inside_store(dir, store) {
        return Err(StoreError::Refused("invalid finalizing directory".into()));
    }
    let dir = Path::new(dir);
    if !dir.exists() {
        return Ok(());
    }
    let file = dir.join(crate::checkpoint::FINALIZED_MARKER);
    std::fs::write(
        &file,
        format!("{}\n", crate::time::iso(crate::time::now_ms())),
    )
    .map_err(|e| StoreError::io(&file, &e))?;
    sync(&file)?;
    sync(dir)
}

pub(super) fn recover(store: &Path) -> Result<(), StoreError> {
    let root = store.join(INTENTS);
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
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
    for file in files {
        let text = std::fs::read_to_string(&file).map_err(|e| StoreError::io(&file, &e))?;
        replay(store, &object(&text)?)?;
        std::fs::remove_file(&file).map_err(|e| StoreError::io(&file, &e))?;
        sync(&root)?;
    }
    Ok(())
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
    publish(&log, &Js::Obj(intent.clone()).compact(), false)?;
    replay(store, &intent)?;
    std::fs::remove_file(&log).map_err(|e| StoreError::io(&log, &e))?;
    sync(&root)
}
