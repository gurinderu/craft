//! A finished run's record, as `finalizeRun` in `integrations/shared/craft-log-run.mjs` files it: a proven retry
//! answered with the file the first attempt filed; else the run's checkpoints folded in when their
//! directory is proven this run's, the record filed under the identity its checkpoints observed near
//! the start. Its durable intent marks the directory before publication; cleanup retires it outside
//! `.partial` before recursive deletion. A directory that is not
//! the run's, cannot be read or lies outside the store is left alone and said, never the reason the
//! record is lost. The record parts and ledger shards the Workflow engine may send are not read
//! here: the binary sends its record whole.

use std::path::{Path, PathBuf};

use crate::StoreError;
use crate::checkpoint::{
    Identity, KEPT_LIVE_MARKER, agrees, attested, find_rejoinable, inside_store,
    read_checkpoint_files,
};
use crate::git::GitId;
use crate::js::{Js, JsString, Obj};
use crate::proof::{self, ProofAt};
use crate::write::{Proof, Writing, recover_filings, with_git, write_proven};

#[cfg(test)]
mod corrupt_rejoin_test {
    use super::*;

    #[test]
    fn marker_failure_refuses_before_filing() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(".partial/run");
        std::fs::create_dir_all(dir.join(".finalized")).unwrap();
        std::fs::write(dir.join("00-start.json"), r#"{"project":"/p"}"#).unwrap();
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
        assert!(
            finalize(
                &Obj::new(),
                &w,
                Asked {
                    dir: dir.to_str().unwrap(),
                    ..Asked::default()
                },
                &mut Said::default()
            )
            .is_err()
        );
        assert!(!d.path().join("index.jsonl").exists());
    }

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
            first: None,
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
                first: None,
            },
            &mut said,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("01-bad.json")).unwrap(),
            "{"
        );
        assert!(said.err.iter().any(|line| line.contains("01-bad.json")));
        let mut retry = Said::default();
        finalize(
            &Obj::new(),
            &w,
            Asked {
                dir: dir.to_str().unwrap(),
                rejoin: false,
                retry: true,
                first: None,
            },
            &mut retry,
        )
        .unwrap();
        assert!(retry.out.iter().any(|line| line.contains("already filed")));
        assert!(retry.err.iter().any(|line| line.contains("01-bad.json")));
    }
}

/// What a finalize asks beyond the record.
#[derive(Debug, Clone, Copy, Default)]
pub struct Asked<'a> {
    /// The run directory, resolved; `""` none.
    pub dir: &'a str,
    pub rejoin: bool,
    pub retry: bool,
    /// A re-file's record as its first filing sent it, before the identity the binary kept was
    /// stamped on it: that filing's proof is found under it, so a record that landed is not filed
    /// twice.
    pub first: Option<&'a Obj>,
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

/// Files `raw`: the record a finalize files, its lines said into `said`. A pending intent retained
/// over a conflicting detail is said as a warning, after the filing so no proof keeps it.
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
    let retained = recover_filings(&w.store)?;
    let done = file_finalized(raw, w, asked, said);
    said.err.extend(
        retained
            .into_iter()
            .map(|c| format!("craft-log-run WARNING: {c} — this write went on")),
    );
    done
}

fn file_finalized(
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
    if already_filed(raw, at, asked, said) {
        return Ok(());
    }
    let partial = w.store.join(crate::checkpoint::PARTIAL_DIR);
    let refused =
        (!asked.dir.is_empty() && !inside_store(asked.dir, &w.store)).then(|| asked.dir.to_owned());
    let mut own = with_git(raw, &w.git_id);
    own.set("project", Js::str(&w.project));
    let own = Identity::of(&own);
    let target = fold_target(raw, w, asked, refused.is_some(), &own)?;
    let (phases, read_error) = read_target(target.as_deref(), asked.rejoin)?;
    let have = attested(&phases);
    let own_dir = !asked.dir.is_empty() && refused.is_none() && !asked.rejoin;
    let mine = if target.is_none()
        || phases.is_empty()
        || have.project.as_ref().is_some_and(JsString::is_empty)
    {
        true
    } else if own_dir {
        have.project
            .as_ref()
            .is_some_and(|p| p == w.project.as_str())
    } else {
        agrees(&own, &have)
    };
    let folded = folded_phases(mine, &phases);
    let start = start_identity(mine, &have, &w.git_id);
    if let Some(m) = start.as_ref().and_then(|s| moved(s, &w.git_id)) {
        said.err.push(m);
    }
    let over = kept_record_file(mine, target.as_deref());
    let mut record = raw.clone();
    if !folded.is_empty() && !raw.has("phases") {
        record.set("phases", Js::Arr(folded.clone()));
    }
    let fallback = GitId::default();
    let id = if let Some(start) = &start {
        record.set("branch", Js::str(&start.branch));
        record.set("head", Js::str(&start.head));
        &fallback
    } else {
        &w.git_id
    };
    let finalizing = target.as_deref().filter(|_| mine && read_error.is_empty());
    let (file, _) = write_proven(
        &record,
        w,
        id,
        over.as_deref(),
        Some(Proof {
            raw,
            at,
            retry: asked.retry,
            warnings: &said.err,
            finalizing,
        }),
    )?;
    say_slow_git(said);
    if !read_error.is_empty() {
        said.err.push(format!(
            "craft-log-run WARNING: the run directory could not be read ({}) — record written, checkpoints not folded",
            safe_path(&read_error)
        ));
    }
    proof::leave(raw, at, &file, &said.err)?;
    let unreadable = remove_folded(target.as_deref(), mine, &read_error, &w.store);
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
    if !unreadable.is_empty() && read_error.is_empty() {
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
    proof::leave(raw, at, &file, &said.err)?;
    Ok(())
}

/// Whether a proof shows `raw` filed already — under it, or under the record a re-file's first
/// filing sent (`asked.first`) — said when it does.
fn already_filed(raw: &Obj, at: ProofAt<'_>, asked: Asked<'_>, said: &mut Said) -> bool {
    say_proven(raw, at, asked.retry, said)
        || asked
            .first
            .is_some_and(|first| say_proven(first, at, asked.retry, said))
}

fn say_proven(raw: &Obj, at: ProofAt<'_>, retry: bool, said: &mut Said) -> bool {
    let Some((file, warned)) = proof::filed_for(raw, at, retry) else {
        return false;
    };
    said.out.push(format!("already filed {}", file.display()));
    let new: Vec<String> = warned
        .into_iter()
        .filter(|l| !said.err.contains(l))
        .collect();
    said.err.extend(new);
    true
}

fn folded_phases(mine: bool, phases: &[Obj]) -> Vec<Js> {
    if !mine {
        return Vec::new();
    }
    phases
        .iter()
        .filter(|p| !p.get("ledgerShard").is_some_and(Js::truthy))
        .filter(|p| !p.get("recordPart").is_some_and(Js::truthy))
        .map(|p| Js::Obj(p.clone()))
        .collect()
}

fn fold_target(
    raw: &Obj,
    w: &Writing,
    asked: Asked<'_>,
    refused: bool,
    own: &Identity,
) -> Result<Option<PathBuf>, StoreError> {
    if refused {
        Ok(None)
    } else if !asked.dir.is_empty() {
        Ok(Some(PathBuf::from(asked.dir)))
    } else if asked.rejoin {
        find_rejoinable(raw, &w.store, own, w.now)
    } else {
        Ok(None)
    }
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
fn start_identity(mine: bool, have: &crate::checkpoint::Attested, now: &GitId) -> Option<Identity> {
    let branch = have.branch.clone().unwrap_or_default();
    let head = have.head.clone().unwrap_or_default();
    if !mine || (branch.is_empty() && head.is_empty()) {
        return None;
    }
    Some(Identity {
        project: JsString::default(),
        branch: if branch.is_empty() {
            JsString::from(&now.branch)
        } else {
            branch
        },
        head: if head.is_empty() {
            JsString::from(&now.head)
        } else {
            head
        },
    })
}

fn moved(start: &Identity, now: &GitId) -> Option<String> {
    let differ = |a: &JsString, b: &str| !a.is_empty() && !b.is_empty() && a != b;
    if !(differ(&start.branch, &now.branch) || differ(&start.head, &now.head)) {
        return None;
    }
    let short = |h: &JsString| display_identity(&JsString::from_utf16(h.units().take(8).collect()));
    let or_q = |b: &JsString| {
        if b.is_empty() {
            "?".to_owned()
        } else {
            display_identity(b)
        }
    };
    Some(format!(
        "craft-log-run WARNING: the working copy moved during this run ({}@{} now, {}@{} when it started) — filed under the identity it reviewed",
        or_q(&JsString::from(&now.branch)),
        short(&JsString::from(&now.head)),
        or_q(&start.branch),
        short(&start.head)
    ))
}

fn display_identity(value: &JsString) -> String {
    value
        .as_str()
        .map_or_else(|| Js::str(value).compact(), str::to_owned)
}

fn kept_record_file(mine: bool, dir: Option<&Path>) -> Option<PathBuf> {
    let dir = dir.filter(|_| mine)?;
    let named = std::fs::read_to_string(dir.join(KEPT_LIVE_MARKER)).ok()?;
    let named = named.trim();
    (!named.is_empty()).then(|| PathBuf::from(named))
}

/// The folded directory marked finalized and removed; what kept it, `""` when nothing did.
fn remove_folded(target: Option<&Path>, mine: bool, unreadable: &str, store: &Path) -> String {
    let Some(t) = target.filter(|t| mine && unreadable.is_empty() && t.exists()) else {
        return unreadable.to_owned();
    };
    match crate::write::retire_finalized(t, store) {
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
