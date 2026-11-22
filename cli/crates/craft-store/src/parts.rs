//! A CLI run stopped and resumed files a record per part: the part its host stopped driving files
//! INCOMPLETE, the resume's part files the run's verdict, and each names the binary's run
//! directory (`cliRun`). The store's readers count such a run once, as the JavaScript report does
//! (`integrations/shared/run-parts.mjs`, `foldStoppedParts`): a stopped part of a run that also
//! filed a finished record folds into it, the finished record standing for the run; a run whose
//! every part stopped stands as its newest. The fold comes before any version or filter: the run
//! is counted under its standing record's version, and a retro of the stopped part's version counts
//! that part folded. These readers sum no cost, so nothing of a folded part is carried over; the
//! JavaScript report, which sums cost, adds each Workflow run's share onto the standing record
//! once. A record that names no run directory — one filed before records named it — folds on
//! nothing here.

use std::collections::{BTreeMap, BTreeSet};

use crate::js::{Js, Obj, Utf16Error};

/// The run a CLI record is a part of — its workflow, project and the binary's run directory —
/// `None` when it names no run directory.
#[must_use]
pub fn part_key(r: &Obj) -> Option<String> {
    let run = r.text_units("cliRun");
    if run.is_empty() || !crate::retro::is_cli(r) {
        return None;
    }
    let key: Vec<Js> = ["kind", "name", "project"]
        .iter()
        .map(|k| Js::str(r.text_units(k)))
        .chain([Js::str(run)])
        .collect();
    Some(Js::Arr(key).compact())
}

/// Whether the record is of a part its host stopped: its verdict INCOMPLETE.
#[must_use]
pub fn stopped(r: &Obj) -> bool {
    r.text_units("verdict").starts_with("INCOMPLETE")
}

/// The parts read so far: the runs that filed a finished record, and the stopped parts held back
/// until every record is read — per run the newest's time and name, and how many there were.
#[derive(Debug, Default)]
pub struct Parts {
    finished: BTreeSet<String>,
    held: BTreeMap<String, (String, String, u64)>,
}

impl Parts {
    /// Notes a record that did not die: a finished one stands for its run's stopped parts,
    /// whichever version or filter it is read under.
    pub fn note(&mut self, r: &Obj) {
        if let Some(key) = part_key(r).filter(|_| !stopped(r)) {
            self.finished.insert(key);
        }
    }

    /// Holds a stopped part named `name` back until every record is read; `false` for any other
    /// record, which the reader counts as it reads it.
    /// # Errors
    /// When its time cannot be represented as UTF-8.
    pub fn hold(&mut self, name: &str, r: &Obj) -> Result<bool, Utf16Error> {
        let Some(key) = part_key(r).filter(|_| stopped(r)) else {
            return Ok(false);
        };
        let ts = r.try_text("ts")?.to_owned();
        let seen = self
            .held
            .entry(key)
            .or_insert_with(|| (ts.clone(), name.to_owned(), 0));
        seen.2 += 1;
        if ts > seen.0 {
            (seen.0, seen.1) = (ts, name.to_owned());
        }
        Ok(true)
    }

    /// The held parts still to count — per run whose every part stopped, its newest, by its run's
    /// key, time and name — and how many held parts fold into another record.
    #[must_use]
    pub fn standing(self) -> (Vec<(String, String, String)>, u64) {
        let mut out = Vec::new();
        let mut folded = 0;
        for (key, (ts, name, n)) in self.held {
            if self.finished.contains(&key) {
                folded += n;
            } else {
                folded += n - 1;
                out.push((key, ts, name));
            }
        }
        (out, folded)
    }
}

/// `records` with each stopped part folded, and how many were; `parts` has noted every record
/// that did not die, of any version, beforehand.
/// # Errors
/// When a stopped part's time cannot be represented as UTF-8.
pub fn fold_parts(records: Vec<Obj>, mut parts: Parts) -> Result<(Vec<Obj>, u64), Utf16Error> {
    let mut kept = Vec::new();
    let mut held = BTreeMap::new();
    for (i, r) in records.into_iter().enumerate() {
        if parts.hold(&i.to_string(), &r)? {
            held.insert(i.to_string(), r);
        } else {
            kept.push(r);
        }
    }
    let (standing, folded) = parts.standing();
    kept.extend(standing.iter().filter_map(|(_, _, name)| held.remove(name)));
    Ok((kept, folded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::parse;

    fn rec(ts: &str, run: &str, verdict: &str) -> Obj {
        let text = format!(
            r#"{{"ts":"{ts}","kind":"workflow","name":"review","driver":"cli","project":"/p","cliRun":"{run}","verdict":"{verdict}"}}"#
        );
        parse(&text).unwrap().as_obj().unwrap().clone()
    }

    fn folded(records: &[Obj], noted: &[Obj]) -> (Vec<String>, u64) {
        let mut parts = Parts::default();
        for r in noted {
            parts.note(r);
        }
        let (kept, n) = fold_parts(records.to_vec(), parts).unwrap();
        (
            kept.iter()
                .map(|r| r.try_text("ts").unwrap().to_owned())
                .collect(),
            n,
        )
    }

    #[test]
    fn a_stopped_part_folds_into_its_runs_finished_record_whatever_version_filed_it() {
        let stopped = rec("1", "/r/a", "INCOMPLETE");
        let finished = rec("2", "/r/a", "Block");
        assert_eq!(
            folded(
                &[stopped.clone(), finished.clone()],
                &[stopped.clone(), finished.clone()]
            ),
            (vec!["2".into()], 1)
        );
        assert_eq!(
            folded(std::slice::from_ref(&stopped), &[stopped.clone(), finished]),
            (vec![], 1),
            "its finished record read under another version"
        );
    }

    #[test]
    fn a_run_whose_every_part_stopped_stands_as_its_newest() {
        let parts = [
            rec("1", "/r/b", "INCOMPLETE"),
            rec("3", "/r/b", "INCOMPLETE"),
            rec("2", "/r/c", "INCOMPLETE"),
        ];
        assert_eq!(folded(&parts, &parts), (vec!["3".into(), "2".into()], 1));
    }

    #[test]
    fn a_record_naming_no_run_directory_folds_on_nothing() {
        let parts = [rec("1", "", "INCOMPLETE"), rec("2", "", "Block")];
        assert_eq!(folded(&parts, &parts), (vec!["1".into(), "2".into()], 0));
    }
}
