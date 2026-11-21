//! What is wrong with a store, read without changing it: the index lines that are not a JSON
//! object, a detail record no index line names, an index line whose record is gone, an INCOMPLETE
//! record beside a finished one of the same run, a finished CLI run whose record never landed, and
//! checkpoint directories no finalize removed.

use std::collections::BTreeSet;
use std::path::Path;

use crate::js::{Js, Obj, parse};
use crate::read::{Skipped, index, record_names};
use crate::record::filename;

/// What the check found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Found {
    pub skipped: Skipped,
    /// Detail records with no index line.
    pub unindexed: Vec<String>,
    /// Index lines whose detail record is gone, by the file name they name.
    pub missing: Vec<String>,
    /// INCOMPLETE records whose run also filed a finished one: the INCOMPLETE and the finished.
    pub phantoms: Vec<(String, String)>,
    /// CLI run directories (`<store>/cli/<run>`) finished but with no record filed.
    pub unfiled: Vec<String>,
    /// Checkpoint directories under `.partial` no finalize removed.
    pub partials: Vec<String>,
}

impl Found {
    #[must_use]
    pub fn clean(&self) -> bool {
        self.skipped.is_empty()
            && self.unindexed.is_empty()
            && self.missing.is_empty()
            && self.phantoms.is_empty()
            && self.unfiled.is_empty()
            && self.partials.is_empty()
    }
}

/// Two records of one run segment are filed within this of each other.
const SEGMENT_MS: i64 = 6 * 60 * 60 * 1000;

/// One index row as the check reads it: its record's file, the run it is of and when it was filed
/// (`None` with no head or no time), and whether its verdict is INCOMPLETE.
struct Row {
    file: String,
    run: Option<(String, i64)>,
    incomplete: bool,
}

fn row_of(r: &Obj) -> Row {
    let head = r.text_units("head");
    let at = r
        .get("ts")
        .and_then(Js::as_str)
        .and_then(crate::time::stamp_ms);
    let run = at.filter(|_| !head.is_empty()).map(|at| {
        let key: Vec<Js> = ["kind", "name", "driver", "project", "branch"]
            .iter()
            .map(|k| Js::str(r.text_units(k)))
            .chain([Js::str(head)])
            .collect();
        (Js::Arr(key).compact(), at)
    });
    Row {
        file: filename(r),
        run,
        incomplete: r.text_units("verdict").starts_with("INCOMPLETE"),
    }
}

/// Each INCOMPLETE row's finished twin: a row of the same run filed in the same segment whose
/// record did not die (`partial`).
fn phantoms(store: &Path, rows: &[Row]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for row in rows.iter().filter(|r| r.incomplete) {
        let Some((run, at)) = &row.run else { continue };
        let Ok(incomplete) = crate::read::record(store, &row.file) else {
            continue;
        };
        let Some(phases) = incomplete
            .get("phases")
            .and_then(Js::as_arr)
            .filter(|p| !p.is_empty())
        else {
            continue;
        };
        let same = |r: &Row| {
            r.run
                .as_ref()
                .is_some_and(|(k, t)| k == run && (t - at).abs() <= SEGMENT_MS)
        };
        let twin = rows.iter().find(|r| {
            !r.incomplete
                && r.file != row.file
                && same(r)
                && crate::read::record(store, &r.file).is_ok_and(|full| {
                    !full.get("partial").is_some_and(Js::truthy)
                        && full
                            .get("phases")
                            .and_then(Js::as_arr)
                            .is_some_and(|all| phases.iter().all(|p| all.contains(p)))
                })
        });
        if let Some(t) = twin {
            out.push((row.file.clone(), t.file.clone()));
        }
    }
    out
}

/// Checks the store at `store`.
///
/// # Errors
/// When the store cannot be listed or its index cannot be read.
pub fn check(store: &Path) -> std::io::Result<Found> {
    let mut found = Found::default();
    let mut rows = Vec::new();
    index(store, &mut found.skipped, |_, r| rows.push(row_of(&r)))?;
    let named: BTreeSet<String> = rows.iter().map(|r| r.file.clone()).collect();
    let on_disk: BTreeSet<String> = record_names(store)?.into_iter().collect();
    for name in &on_disk {
        if let Err(why) = crate::read::record(store, name) {
            found.skipped.records.push((name.clone(), why));
        }
    }
    found.unindexed = on_disk.difference(&named).cloned().collect();
    found.missing = named.difference(&on_disk).cloned().collect();
    found.phantoms = phantoms(store, &rows);
    found.unfiled = unfiled_runs(store)?;
    found.partials = dirs(&store.join(".partial"))?;
    Ok(found)
}

fn dirs(at: &Path) -> std::io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(at) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            out.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    out.sort();
    Ok(out)
}

fn json(path: &Path) -> Option<Obj> {
    let text = std::fs::read_to_string(path).ok()?;
    parse(&text).ok()?.as_obj().cloned()
}

/// The CLI's run directories whose state is done and whose filing kept a record that is not filed.
fn unfiled_runs(store: &Path) -> std::io::Result<Vec<String>> {
    let root = store.join("cli");
    Ok(dirs(&root)?
        .into_iter()
        .filter(|d| {
            let done = json(&root.join(d).join("state.json"))
                .is_some_and(|s| s.text_units("phase") == "done");
            let filing = json(&root.join(d).join("filing.json"));
            done && filing.is_some_and(|f| f.text_units("record") != "filed")
        })
        .collect())
}
