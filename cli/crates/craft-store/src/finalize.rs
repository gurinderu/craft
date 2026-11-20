//! A finished run's record, as `finalizeRun` in `lib/craft-log-run.mjs` files it: a proven retry
//! answered with the file the first attempt filed; else the run's checkpoints folded in when their
//! directory is proven this run's, the record filed under the identity its checkpoints observed near
//! the start, the proof left, and the folded directory marked and removed. A directory that is not
//! the run's, cannot be read or lies outside the store is left alone and said, never the reason the
//! record is lost. The record parts and ledger shards the Workflow engine may send are not read
//! here: the binary sends its record whole.

use std::path::{Path, PathBuf};

use crate::StoreError;
use crate::checkpoint::{
    FINALIZED_MARKER, Identity, KEPT_LIVE_MARKER, agrees, attested, find_rejoinable, inside_store,
    read_checkpoint_files,
};
use crate::git::GitId;
use crate::js::{Js, Obj};
use crate::proof::{self, ProofAt};
use crate::write::{Writing, with_git, write_record};

#[cfg(test)]
mod corrupt_rejoin_test {
    use super::*;

    #[test]
    fn explicit_rejoin_refuses_corrupt_checkpoint_without_removing_it() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(".partial/run");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("00-good.json"), r#"{"project":"/p"}"#).unwrap();
        std::fs::write(dir.join("01-bad.json"), "{").unwrap();
        let w = Writing {
            store: d.path().into(),
            project: "/p".into(),
            workdir: d.path().into(),
            session: String::new(),
            git_id: GitId::default(),
            observe: false,
            craft_commit: None,
            now: 0,
        };
        let path = dir.to_str().unwrap();
        let asked = Asked {
            dir: path,
            rejoin: true,
            retry: false,
        };
        let error = finalize(&Obj::new(), &w, asked, &mut Said::default()).unwrap_err();
        assert!(error.to_string().contains("01-bad.json"));
        assert_eq!(
            std::fs::read_to_string(dir.join("01-bad.json")).unwrap(),
            "{"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("00-good.json")).unwrap(),
            r#"{"project":"/p"}"#
        );
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
    }

    #[test]
    fn ordinary_finalize_preserves_unreadable_checkpoints() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(".partial/run");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("00-good.json"), r#"{"project":"/p"}"#).unwrap();
        std::fs::write(dir.join("01-bad.json"), "{").unwrap();
        let w = Writing {
            store: d.path().into(),
            project: "/p".into(),
            workdir: d.path().into(),
            session: String::new(),
            git_id: GitId::default(),
            observe: false,
            craft_commit: None,
            now: 0,
        };
        let mut said = Said::default();
        finalize(
            &Obj::new(),
            &w,
            Asked {
                dir: dir.to_str().unwrap(),
                rejoin: false,
                retry: false,
            },
            &mut said,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("01-bad.json")).unwrap(),
            "{"
        );
        assert!(said.err.iter().any(|line| line.contains("01-bad.json")));
    }
}

/// What a finalize asks beyond the record.
#[derive(Debug, Clone, Copy, Default)]
pub struct Asked<'a> {
    /// The run directory, resolved; `""` none.
    pub dir: &'a str,
    pub rejoin: bool,
    pub retry: bool,
}

/// What a finalize did, and the lines it says: stdout's, then stderr's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Said {
    pub out: Vec<String>,
    pub err: Vec<String>,
}

pub(crate) fn safe_path(p: &str) -> String {
    let one: String = p
        .split(['\r', '\n'])
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let units: Vec<u16> = one.encode_utf16().take(200).collect();
    String::from_utf16_lossy(&units)
}

/// Files `raw`: the record a finalize files, its lines said into `said`.
///
/// # Errors
/// When the record cannot be written or a rejoin's checkpoints cannot be read; a warning in
/// `said.err` may come before it.
pub fn finalize(
    raw: &Obj,
    w: &Writing,
    asked: Asked<'_>,
    said: &mut Said,
) -> Result<(), StoreError> {
    let at = ProofAt {
        store: &w.store,
        dir: asked.dir,
        project: &w.project,
    };
    if asked.retry
        && let Some((file, warned)) = proof::filed_before(raw, at)
    {
        said.out.push(format!("already filed {}", file.display()));
        let new: Vec<String> = warned
            .into_iter()
            .filter(|l| !said.err.contains(l))
            .collect();
        said.err.extend(new);
        return Ok(());
    }
    let partial = w.store.join(crate::checkpoint::PARTIAL_DIR);
    let refused =
        (!asked.dir.is_empty() && !inside_store(asked.dir, &w.store)).then(|| asked.dir.to_owned());
    let mut own = with_git(raw, &w.git_id);
    own.set("project", Js::str(&w.project));
    let own = Identity::of(&own);
    let target = if refused.is_some() {
        None
    } else if !asked.dir.is_empty() {
        Some(PathBuf::from(asked.dir))
    } else if asked.rejoin {
        find_rejoinable(raw, &w.store, &own, w.now)?
    } else {
        None
    };
    let (phases, read_error) = read_target(target.as_deref(), asked.rejoin)?;
    let have = attested(&phases);
    let own_dir = !asked.dir.is_empty() && refused.is_none() && !asked.rejoin;
    let mine = if target.is_none() || phases.is_empty() || have.project.as_deref() == Some("") {
        true
    } else if own_dir {
        have.project.as_deref() == Some(w.project.as_str())
    } else {
        agrees(&own, &have)
    };
    let folded: Vec<Js> = if mine {
        phases
            .iter()
            .filter(|p| !p.get("ledgerShard").is_some_and(Js::truthy))
            .filter(|p| !p.get("recordPart").is_some_and(Js::truthy))
            .map(|p| Js::Obj(p.clone()))
            .collect()
    } else {
        Vec::new()
    };
    let start = start_identity(mine, &have, &w.git_id);
    if let Some(m) = start.as_ref().and_then(|s| moved(s, &w.git_id)) {
        said.err.push(m);
    }
    let over = kept_record_file(mine, target.as_deref());
    let mut record = raw.clone();
    if !folded.is_empty() && !raw.has("phases") {
        record.set("phases", Js::Arr(folded.clone()));
    }
    let id = start.as_ref().unwrap_or(&w.git_id);
    let (file, _) = write_record(&record, w, id, over.as_deref())?;
    say_slow_git(said);
    proof::leave(raw, at, &file, &said.err);
    let unreadable = remove_folded(target.as_deref(), mine, &read_error, w.now);
    let tail = if folded.is_empty() {
        String::new()
    } else {
        format!(" (folded {} checkpoint(s))", folded.len())
    };
    said.out.push(format!("wrote {}{tail}", file.display()));
    if let (Some(t), false) = (&target, mine) {
        said.err.push(format!(
            "craft-log-run WARNING: {} does not match this run's identity — left for `recover`",
            safe_path(&t.display().to_string())
        ));
    }
    if !unreadable.is_empty() {
        said.err.push(format!(
            "craft-log-run WARNING: the run directory could not be read ({}) — record written, checkpoints not folded",
            safe_path(&unreadable)
        ));
    }
    if let Some(r) = refused {
        said.err.push(format!(
            "craft-log-run WARNING: --dir {} is not inside {} — record written, directory neither folded nor removed",
            safe_path(&r),
            partial.display()
        ));
    }
    proof::leave(raw, at, &file, &said.err);
    Ok(())
}

fn read_target(dir: Option<&Path>, rejoin: bool) -> Result<(Vec<Obj>, String), StoreError> {
    match dir.map(|d| read_checkpoint_files(d, true)) {
        Some(Ok(phases)) => Ok((phases, String::new())),
        Some(Err(e)) if rejoin => Err(StoreError::Refused(format!(
            "cannot read checkpoint directory: {e}"
        ))),
        Some(Err(e)) => Ok((Vec::new(), e)),
        None => Ok((Vec::new(), String::new())),
    }
}

/// Per field, the start-of-run observation the checkpoints carry, else the write-time one; `None`
/// when the run's own checkpoints observed neither.
fn start_identity(mine: bool, have: &crate::checkpoint::Attested, now: &GitId) -> Option<GitId> {
    let branch = have.branch.clone().unwrap_or_default();
    let head = have.head.clone().unwrap_or_default();
    if !mine || (branch.is_empty() && head.is_empty()) {
        return None;
    }
    Some(GitId {
        branch: if branch.is_empty() {
            now.branch.clone()
        } else {
            branch
        },
        head: if head.is_empty() {
            now.head.clone()
        } else {
            head
        },
    })
}

fn moved(start: &GitId, now: &GitId) -> Option<String> {
    let differ = |a: &str, b: &str| !a.is_empty() && !b.is_empty() && a != b;
    if !(differ(&start.branch, &now.branch) || differ(&start.head, &now.head)) {
        return None;
    }
    let short = |h: &str| h.chars().take(8).collect::<String>();
    let or_q = |b: &str| {
        if b.is_empty() {
            "?".to_owned()
        } else {
            b.to_owned()
        }
    };
    Some(format!(
        "craft-log-run WARNING: the working copy moved during this run ({}@{} now, {}@{} when it started) — filed under the identity it reviewed",
        or_q(&now.branch),
        short(&now.head),
        or_q(&start.branch),
        short(&start.head)
    ))
}

fn kept_record_file(mine: bool, dir: Option<&Path>) -> Option<PathBuf> {
    let dir = dir.filter(|_| mine)?;
    let named = std::fs::read_to_string(dir.join(KEPT_LIVE_MARKER)).ok()?;
    let named = named.trim();
    (!named.is_empty()).then(|| PathBuf::from(named))
}

/// The folded directory marked finalized and removed; what kept it, `""` when nothing did.
fn remove_folded(target: Option<&Path>, mine: bool, unreadable: &str, now: i64) -> String {
    let Some(t) = target.filter(|t| mine && unreadable.is_empty() && t.exists()) else {
        return unreadable.to_owned();
    };
    drop(std::fs::write(
        t.join(FINALIZED_MARKER),
        format!("{}\n", crate::time::iso(now)),
    ));
    match std::fs::remove_dir_all(t) {
        Ok(()) => String::new(),
        Err(e) => format!("the run directory could not be removed: {e}"),
    }
}

/// A git probe killed past its bound said, beside the record that names it (`gitTimedOut`).
fn say_slow_git(said: &mut Said) {
    let slow = crate::git::timed_out();
    if !slow.is_empty() {
        said.err.push(format!(
            "craft-log-run WARNING: {} outlived {} s and was killed — record written with those fields empty (gitTimedOut)",
            slow.join(", "),
            crate::git::BOUND.as_secs()
        ));
    }
}
