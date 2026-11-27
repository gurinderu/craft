//! Confirmed findings recurring across branches of one project (realm @nick/craft, #205), and on
//! request the unverified ones apart (#636). The detail files are read independently of the
//! index; nothing is written.

mod groups;
mod read;
mod select;
#[cfg(test)]
mod tests;
mod text;
mod unverified;

use std::path::{Path, PathBuf};

use craft_store::js::{Js, Obj};

const RUNS_MAX: usize = 500;
const GROUPS_MAX: usize = 20;
const TITLES_MAX: usize = 5;
const REAL_FINDING_RULE: &str = "rejected, refuted, justified, covered, deferred and dismissed findings are not counted, nor unverified and suspected ones — only findings verified real and not already settled";
const UNVERIFIED_RULE: &str = "unverified findings group apart under `unverified`, never with confirmed ones: one whose line changed since its run's head is set aside (`changed`), one of a run that read uncommitted work or whose head this clone lacks is kept (`unchecked`)";

/// Errors from listing the store or representing its paths.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("checking run store {}", path.display())]
    Probe {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("listing run store {}", path.display())]
    List {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("path cannot be represented as Unicode: {}", .0.display())]
    Path(PathBuf),
}

/// Read the newest 500 detail files, retaining only this repository's finished, branched runs.
/// `project` is resolved to the main checkout's repository key; paths are segment prefixes.
/// With `unverified`, the result also carries the unverified groups, their lines held to
/// `project`'s `HEAD`.
/// The result is always one JSON object, including when the store does not exist; a store that
/// cannot be reached (an ancestor the user cannot search) is an error, never an absent store.
///
/// # Errors
/// When the store cannot be probed or listed, or an output path is not representable as Unicode.
pub fn recurring(
    store: &Path,
    project: &Path,
    paths: &[String],
    unverified: bool,
) -> Result<Js, Error> {
    let checkout = project;
    let project = craft_store::git::repo_key(project);
    let project = path_text(&project)?;
    let store_text = path_text(store)?;
    let mut out = Obj::new()
        .with("store", Js::str(store_text))
        .with("project", Js::str(project))
        .with("paths", Js::Arr(paths.iter().map(Js::str).collect()));
    let present = store.try_exists().map_err(|source| Error::Probe {
        path: store.into(),
        source,
    })?;
    if !present {
        counts(&mut out, 0, 0);
        out.set("groups", Js::Arr(vec![]));
        out.set("groupsCut", number(0));
        if unverified {
            out.set("unverified", unverified::none());
        }
        out.set(
            "note",
            Js::str(format!(
                "no run store at {store_text} — no recurrence to show"
            )),
        );
        return Ok(Js::Obj(out));
    }
    let read = read::runs(store, project, paths)?;
    let (groups, cut) = groups::recurring(&read.runs);
    counts(&mut out, read.read, read.not_read);
    out.set("skipped", read.skipped.json());
    out.set("groups", Js::Arr(groups));
    out.set("groupsCut", number(cut));
    if unverified {
        out.set("unverified", unverified::unverified(&read.runs, checkout));
    }
    out.set("note", Js::str(notes(&read, cut, unverified)));
    Ok(Js::Obj(out))
}

fn path_text(path: &Path) -> Result<&str, Error> {
    path.to_str().ok_or_else(|| Error::Path(path.to_owned()))
}

fn counts(out: &mut Obj, read: usize, not_read: usize) {
    out.set("runsRead", number(read));
    out.set("runsNotRead", number(not_read));
}

fn number(n: usize) -> Js {
    Js::from(&serde_json::json!(n))
}

fn notes(read: &read::Read, cut: usize, unverified: bool) -> String {
    let mut notes = vec![
        format!("{} run(s) of this project read", read.runs.len()),
        REAL_FINDING_RULE.into(),
    ];
    if unverified {
        notes.push(UNVERIFIED_RULE.into());
    }
    if read.not_read != 0 {
        notes.push(format!(
            "{} older run(s) past the bound of {RUNS_MAX} were not read",
            read.not_read
        ));
    }
    if cut != 0 {
        notes.push(format!(
            "{cut} more recurring group(s) past the bound of {GROUPS_MAX} not listed"
        ));
    }
    notes.join("; ")
}
