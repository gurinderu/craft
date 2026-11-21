use std::path::Path;

use craft_store::js::{Js, JsString, Obj, parse};

use super::text::{text, touched};
use super::{Error, RUNS_MAX, number};

pub(super) struct Row {
    pub file: JsString,
    pub title: JsString,
    pub severity: JsString,
}

pub(super) struct Run {
    pub file: JsString,
    pub ts: JsString,
    pub branch: JsString,
    pub rows: Vec<Row>,
}

#[derive(Default)]
pub(super) struct Skipped {
    other_project: usize,
    partial: usize,
    no_branch: usize,
    no_ledger: usize,
    unreadable: usize,
}

impl Skipped {
    pub fn json(&self) -> Js {
        Js::Obj(
            Obj::new()
                .with("otherProject", number(self.other_project))
                .with("partial", number(self.partial))
                .with("noBranch", number(self.no_branch))
                .with("noLedger", number(self.no_ledger))
                .with("unreadable", number(self.unreadable)),
        )
    }
}

pub(super) struct Read {
    pub runs: Vec<Run>,
    pub skipped: Skipped,
    pub read: usize,
    pub not_read: usize,
}

pub(super) fn runs(store: &Path, project: &str, paths: &[String]) -> Result<Read, Error> {
    let names = names(store).map_err(|source| Error::List {
        path: store.into(),
        source,
    })?;
    let mut out = Read {
        runs: vec![],
        skipped: Skipped::default(),
        read: names.len().min(RUNS_MAX),
        not_read: names.len().saturating_sub(RUNS_MAX),
    };
    for name in names.into_iter().take(RUNS_MAX) {
        match record(&store.join(&name)) {
            Some(rec) => add(&mut out, &rec, &name, project, paths),
            None => out.skipped.unreadable += 1,
        }
    }
    Ok(out)
}

fn names(store: &Path) -> std::io::Result<Vec<String>> {
    // Include directories and symlinks too: a .json entry that cannot be read must be counted.
    let mut names = std::fs::read_dir(store)?
        .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<std::io::Result<Vec<_>>>()?;
    names.retain(|n| n.ends_with(".json"));
    names.sort_by(|a, b| b.encode_utf16().cmp(a.encode_utf16()));
    Ok(names)
}

fn record(path: &Path) -> Option<Obj> {
    let bytes = std::fs::read(path).ok()?;
    // Node's readFileSync(..., 'utf8') replaces malformed UTF-8 before parsing JSON. Escaped
    // UTF-16 surrogates are instead preserved by the store's parser, including matching fields.
    match parse(&String::from_utf8_lossy(&bytes)).ok()? {
        Js::Obj(o) => Some(o),
        Js::Null | Js::Bool(_) | Js::Num(_) | Js::Str(_) | Js::Arr(_) => None,
    }
}

fn add(out: &mut Read, rec: &Obj, name: &str, project: &str, paths: &[String]) {
    let skipped = &mut out.skipped;
    if rec.get("project") != Some(&Js::str(project)) {
        skipped.other_project += 1;
    } else if rec.get("partial").is_some_and(Js::truthy) {
        skipped.partial += 1;
    } else if text(rec, "branch").is_empty() {
        skipped.no_branch += 1;
    } else if let Some(ledger) = rec.get("ledger").and_then(Js::as_arr) {
        out.runs.push(Run {
            file: name.into(),
            ts: text(rec, "ts"),
            branch: text(rec, "branch"),
            rows: rows(ledger, paths),
        });
    } else {
        skipped.no_ledger += 1;
    }
}

fn rows(ledger: &[Js], paths: &[String]) -> Vec<Row> {
    ledger
        .iter()
        .filter_map(Js::as_obj)
        .filter_map(|o| {
            let row = Row {
                file: text(o, "file"),
                title: text(o, "title"),
                severity: text(o, "severity"),
            };
            (!row.file.is_empty()
                && !row.title.is_empty()
                && was_real(o)
                && touched(&row.file, paths))
            .then_some(row)
        })
        .collect()
}

fn was_real(o: &Obj) -> bool {
    let disposition = text(o, "disposition");
    let settled = ["rejected", "justified", "covered", "deferred"]
        .iter()
        .any(|d| disposition == *d);
    !settled
        && text(o, "tier") == "confirmed"
        && !(disposition == "closed" && text(o, "why").starts_with("dismissed "))
}
