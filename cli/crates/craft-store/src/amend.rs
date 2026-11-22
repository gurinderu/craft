//! A field written into records already filed — a run's cost, a reviewer's sorting choice — each
//! record rewritten whole, `JSON.stringify(record, null, 2)`, temporary file and rename, every other
//! field kept in place. In the store this runs under the index lock after the pending filings are
//! replayed, and each record is read again there: a rewrite never races a filing, nor turns one
//! still pending into a conflict, nor writes back a copy a replay has just replaced. The index
//! carries none of these fields, so it is left as it is.

use std::path::Path;

use crate::js::{Js, Obj, parse};
use crate::write::write_atomically;

/// The record at `file`, a JSON object.
///
/// # Errors
/// When it cannot be read or is not a JSON object.
pub fn read_object(file: &Path) -> Result<Obj, String> {
    let read = std::fs::read_to_string(file).map_err(|e| e.to_string());
    match read.and_then(|t| parse(&t).map_err(|e| e.to_string())) {
        Ok(Js::Obj(r)) => Ok(r),
        Ok(_) => Err(format!(
            "record not readable at {}: not a JSON object",
            file.display()
        )),
        Err(why) => Err(format!("record not readable at {}: {why}", file.display())),
    }
}

/// Each of `files` read again, changed by `change` and written back; under `store`'s lock when it
/// is given. Every record is read and changed before any is written, so a refusal leaves them all
/// as they were. Returns the warnings of the filings replayed first.
///
/// # Errors
/// When the lock cannot be taken, a record cannot be read, `change` refuses it, or a write fails.
pub fn rewrite(
    store: Option<&Path>,
    files: &[&Path],
    change: &mut dyn FnMut(usize, Obj) -> Result<Obj, String>,
) -> Result<Vec<String>, String> {
    let mut each = || -> Result<(), String> {
        let mut changed = Vec::with_capacity(files.len());
        for (i, file) in files.iter().enumerate() {
            changed.push(change(i, read_object(file)?)?);
        }
        for (file, record) in files.iter().zip(changed) {
            write_atomically(file, Js::Obj(record).pretty()).map_err(|e| e.to_string())?;
        }
        Ok(())
    };
    let Some(store) = store else {
        each()?;
        return Ok(Vec::new());
    };
    let mut failed = None;
    let warned = crate::write::under_lock_replayed(store, || {
        failed = each().err();
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    match failed {
        Some(why) => Err(why),
        None => Ok(warned),
    }
}

/// `key` set to each value on its record in `store`, `{ ...record, [key]: value }`.
///
/// # Errors
/// As [`rewrite`].
pub fn set_field(
    store: &Path,
    key: &str,
    values: &[(std::path::PathBuf, Obj)],
) -> Result<Vec<String>, String> {
    let files: Vec<&Path> = values.iter().map(|(f, _)| f.as_path()).collect();
    rewrite(Some(store), &files, &mut |i, mut record| {
        let value = values.get(i).map_or(Js::Null, |(_, v)| Js::Obj(v.clone()));
        record.set(key, value);
        Ok(record)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_field_is_set_in_place_and_setting_it_again_changes_nothing() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("r.json");
        std::fs::write(&file, r#"{"a":1,"cost":{"old":true},"10":"x","z":[1]}"#).unwrap();
        let cost = Obj::new().with("total", Js::Num(5.0));
        let values = [(file.clone(), cost)];
        set_field(d.path(), "cost", &values).unwrap();
        let once = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            once,
            "{\n  \"10\": \"x\",\n  \"a\": 1,\n  \"cost\": {\n    \"total\": 5\n  },\n  \"z\": [\n    1\n  ]\n}"
        );
        set_field(d.path(), "cost", &values).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), once);
    }

    #[test]
    fn a_refusal_mid_set_leaves_every_record_as_it_was() {
        let d = tempfile::tempdir().unwrap();
        let (first, second) = (d.path().join("a.json"), d.path().join("b.json"));
        std::fs::write(&first, r#"{"a":1}"#).unwrap();
        std::fs::write(&second, "not json").unwrap();
        let values = [(first.clone(), Obj::new()), (second.clone(), Obj::new())];
        set_field(d.path(), "cost", &values).unwrap_err();
        assert_eq!(std::fs::read_to_string(&first).unwrap(), r#"{"a":1}"#);
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "not json");
        let mut calls = 0;
        let refused = rewrite(None, &[&first, &first], &mut |i, r| {
            calls += 1;
            if i == 1 {
                Err("no".into())
            } else {
                Ok(r.with("b", Js::Num(2.0)))
            }
        });
        assert_eq!((refused, calls), (Err("no".to_owned()), 2));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), r#"{"a":1}"#);
    }

    #[test]
    fn a_record_that_is_no_object_is_refused_and_left_as_it_is() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("r.json");
        std::fs::write(&file, "[1]").unwrap();
        let err = set_field(d.path(), "cost", &[(file.clone(), Obj::new())]).unwrap_err();
        assert!(err.ends_with("not a JSON object"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[1]");
    }
}
