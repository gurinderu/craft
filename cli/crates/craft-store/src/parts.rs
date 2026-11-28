//! A CLI run stopped and resumed files a record per part: the part its host stopped driving files
//! INCOMPLETE, the resume's part files the run's verdict, and each names the binary's run
//! directory (`cliRun`). The store's readers count such a run once, as the JavaScript report does
//! (`integrations/shared/run-parts.mjs`, `foldStoppedParts`): a stopped part of a run that also
//! filed a finished record folds into it, the finished record standing for the run; a run whose
//! every part stopped stands as its newest. The fold comes before any version or filter: the run
//! is counted under its standing record's version, and a retro of the stopped part's version counts
//! that part folded. A reader that sums cost prices the standing record by its parts' shares
//! summed once (its `cost` module), as the JavaScript report does. A record that names no run directory — one filed before records named it — folds on
//! nothing here.

use std::collections::{BTreeMap, BTreeSet};

use crate::js::{Js, Obj, Utf16Error};

mod cost;

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

/// A run's stopped parts held back: the newest's time and name and whether it is inside what the
/// reader counts (its version, its filter), and how many held parts are inside.
#[derive(Debug)]
struct Held {
    ts: String,
    name: String,
    inside: bool,
    inside_n: u64,
}

/// The parts read so far: the runs that filed a finished record, and the stopped parts held back
/// until every record is read.
#[derive(Debug, Default)]
pub struct Parts {
    finished: BTreeSet<String>,
    held: BTreeMap<String, Held>,
    /// Every part of each run noted, in the order noted.
    costs: BTreeMap<String, Vec<cost::Noted>>,
}

impl Parts {
    /// Notes a record that did not die: a finished one stands for its run's stopped parts,
    /// whichever version or filter it is read under.
    pub fn note(&mut self, id: &str, r: &Obj) {
        let Some(key) = part_key(r) else {
            return;
        };
        self.costs
            .entry(key.clone())
            .or_default()
            .push(cost::Noted {
                id: id.to_owned(),
                ts: r.text_units("ts"),
                stopped: stopped(r),
                cost: r.get("cost").cloned(),
            });
        if !stopped(r) {
            self.finished.insert(key);
        }
    }

    /// Holds a stopped part named `name` back until every record is read, whether or not it is
    /// `inside` what the reader counts — the run is folded before any version or filter, then
    /// counted where its standing part is; `false` for any other record.
    /// # Errors
    /// When its time cannot be represented as UTF-8.
    pub fn hold(&mut self, name: &str, r: &Obj, inside: bool) -> Result<bool, Utf16Error> {
        let Some(key) = part_key(r).filter(|_| stopped(r)) else {
            return Ok(false);
        };
        let ts = r.try_text("ts")?.to_owned();
        let seen = self.held.entry(key).or_insert_with(|| Held {
            ts: ts.clone(),
            name: name.to_owned(),
            inside,
            inside_n: 0,
        });
        seen.inside_n += u64::from(inside);
        if ts > seen.ts {
            (seen.ts, seen.name, seen.inside) = (ts, name.to_owned(), inside);
        }
        Ok(true)
    }

    /// The held parts still to count inside — per run whose every part stopped, its newest when
    /// that is inside, by its run's key, time and name — and how many held parts inside fold into
    /// another record.
    #[must_use]
    pub fn standing(&self) -> (Vec<(String, String, String)>, u64) {
        let mut out = Vec::new();
        let mut folded = 0;
        for (key, h) in &self.held {
            if self.finished.contains(key) {
                folded += h.inside_n;
            } else {
                folded += h.inside_n - u64::from(h.inside);
                if h.inside {
                    out.push((key.clone(), h.ts.clone(), h.name.clone()));
                }
            }
        }
        (out, folded)
    }
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

    /// The records read, each `inside` or not: the names still to count and how many folded.
    fn folded(records: &[(Obj, bool)]) -> (Vec<String>, u64) {
        let mut parts = Parts::default();
        for (r, _) in records {
            parts.note(r.try_text("ts").unwrap(), r);
        }
        let mut counted = Vec::new();
        for (r, inside) in records {
            let name = r.try_text("ts").unwrap();
            if !parts.hold(name, r, *inside).unwrap() && *inside {
                counted.push(name.to_owned());
            }
        }
        let (standing, n) = parts.standing();
        counted.extend(standing.into_iter().map(|(_, _, name)| name));
        (counted, n)
    }

    #[test]
    fn a_stopped_part_folds_into_its_runs_finished_record_whatever_version_filed_it() {
        let stopped = rec("1", "/r/a", "INCOMPLETE");
        let finished = rec("2", "/r/a", "Block");
        assert_eq!(
            folded(&[(stopped.clone(), true), (finished.clone(), true)]),
            (vec!["2".into()], 1)
        );
        assert_eq!(
            folded(&[(stopped.clone(), true), (finished.clone(), false)]),
            (vec![], 1),
            "its finished record read under another version"
        );
        assert_eq!(
            folded(&[(stopped, false), (finished, true)]),
            (vec!["2".into()], 0),
            "the stopped part's own version is not this one"
        );
    }

    #[test]
    fn a_run_whose_every_part_stopped_stands_as_its_newest_where_that_is_counted() {
        let (old, new) = (
            rec("1", "/r/b", "INCOMPLETE"),
            rec("3", "/r/b", "INCOMPLETE"),
        );
        let other = rec("2", "/r/c", "INCOMPLETE");
        assert_eq!(
            folded(&[(old.clone(), true), (new.clone(), true), (other, true)]),
            (vec!["3".into(), "2".into()], 1)
        );
        assert_eq!(
            folded(&[(old.clone(), true), (new.clone(), false)]),
            (vec![], 1)
        );
        assert_eq!(folded(&[(old, false), (new, true)]), (vec!["3".into()], 0));
    }

    #[test]
    fn a_record_naming_no_run_directory_folds_on_nothing() {
        let parts = [
            (rec("1", "", "INCOMPLETE"), true),
            (rec("2", "", "Block"), true),
        ];
        assert_eq!(folded(&parts), (vec!["1".into(), "2".into()], 0));
    }
}
