//! One intent replayed: its finalizing directory marked, its detail published unless a newer write
//! holds it, then its index row and proofs (#555, #556, #559).
use super::{named, object, publish, sync};
use crate::{
    StoreError,
    js::{Js, Obj},
};
use std::path::Path;

fn current(file: &Path) -> Result<Option<String>, StoreError> {
    match std::fs::read_to_string(file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(StoreError::io(file, &e)),
    }
}

/// Replays `intent`; `Ok(false)` when its detail holds a newer write, left untouched.
pub(super) fn replay(store: &Path, intent: &Obj) -> Result<bool, StoreError> {
    let file = named(store, intent.text("file")?)?;
    mark_finalizing(store, intent.text("finalizing")?)?;
    let text = intent.text("record")?;
    let record = object(text)?;
    let before = intent.get("before").and_then(Js::as_str);
    let now = current(&file)?;
    if now.as_deref() != Some(text) {
        if now.as_deref() != before {
            return Ok(false);
        }
        publish(&file, text, before.is_some())?;
    }
    let row = Js::Obj(crate::record::index_projection(&record)).compact();
    super::super::replace_index_row_locked(store, &record, &row)?;
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
    Ok(true)
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
