use std::cell::RefCell;
use std::path::PathBuf;

use serde_json::{Value, json};

use super::*;

/// A writer that lands every write, keeping the root each was sent through.
#[derive(Default)]
struct Roots(RefCell<Vec<String>>);

impl Writer for Roots {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        self.0.borrow_mut().push(call.root.to_owned());
        Ok(match call.command {
            "checkpoint" => json!({"phase": "start", "runDir": "/store/.partial/a"}),
            _ => json!({"ok": true, "reason": "", "file": "/store/r.json"}),
        })
    }
}

fn plugin(with_adapter: bool) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    if with_adapter {
        std::fs::create_dir_all(d.path().join("lib")).unwrap();
        std::fs::write(d.path().join("lib/cli-review-file.mjs"), "").unwrap();
    }
    d
}

fn rootless() -> Ctx {
    Ctx {
        repo: "/gone/worktree".into(),
        root: None,
        craft_version: "0.45.0".into(),
        ..Ctx::default()
    }
}

fn finished() -> Value {
    json!({"run": "/run", "done": true, "report": "/run/report.md", "verdict": "Approve", "at": 1, "took": 1})
}

#[test]
fn the_root_found_is_the_first_that_holds_the_adapter() {
    let (bare, held) = (plugin(false), plugin(true));
    let found = found_root([
        None,
        Some(PathBuf::new()),
        Some(bare.path().to_path_buf()),
        Some(held.path().to_path_buf()),
    ]);
    assert_eq!(found, Some(held.path().display().to_string()));
    assert_eq!(found_root([Some(bare.path().to_path_buf()), None]), None);
}

#[test]
fn a_run_started_with_no_root_files_its_record_through_one_found_later_and_keeps_it() {
    let run = tempfile::tempdir().unwrap();
    let w = Roots::default();
    let said = open(run.path(), rootless(), "s", &finished(), &w);
    assert_eq!(said["record"], json!("failed"));
    assert!(w.0.borrow().is_empty());

    adopt(run.path(), Some("/plugin"));
    let again = file_again(run.path(), Vec::new(), &w).unwrap();
    assert_eq!(again["filing"]["record"], json!("filed"));
    assert_eq!(*w.0.borrow(), ["/plugin"]);
    assert_eq!(
        load(run.path()).unwrap().ctx.root.as_deref(),
        Some("/plugin")
    );
}

#[test]
fn a_root_the_run_knows_is_kept_and_a_pending_part_with_none_takes_the_one_found() {
    let run = tempfile::tempdir().unwrap();
    let (known, kept) = (plugin(true), plugin(true));
    let (known, kept) = (
        known.path().display().to_string(),
        kept.path().display().to_string(),
    );
    let part = |root: Option<&str>| Filing {
        ctx: Ctx {
            root: root.map(str::to_owned),
            ..rootless()
        },
        ..Filing::default()
    };
    let filing = Filing {
        pending: vec![part(None), part(Some(&kept))],
        ..part(Some(&known))
    };
    save(run.path(), &filing, &mut Vec::new());
    adopt(run.path(), Some("/found"));
    let roots = |f: &Filing| {
        std::iter::once(f)
            .chain(&f.pending)
            .map(|p| p.ctx.root.clone().unwrap_or_default())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        roots(&load(run.path()).unwrap()),
        [known.as_str(), "/found", kept.as_str()]
    );
}

#[test]
fn a_run_that_files_nothing_gets_no_telemetry_from_a_root_found() {
    let run = tempfile::tempdir().unwrap();
    adopt(run.path(), Some("/found"));
    assert!(!state_path(run.path()).exists());
}

#[test]
fn a_root_that_no_longer_holds_the_writer_is_replaced_by_the_one_found() {
    let (run, kept, gone) = (tempfile::tempdir().unwrap(), plugin(true), plugin(false));
    let at = |root: &tempfile::TempDir| Filing {
        ctx: Ctx {
            root: Some(root.path().display().to_string()),
            ..rootless()
        },
        ..Filing::default()
    };
    let filing = Filing {
        pending: vec![at(&kept)],
        ..at(&gone)
    };
    save(run.path(), &filing, &mut Vec::new());
    adopt(run.path(), Some("/found"));
    let after = load(run.path()).unwrap();
    assert_eq!(after.ctx.root.as_deref(), Some("/found"), "uninstalled");
    assert_eq!(
        after.pending[0].ctx.root,
        Some(kept.path().display().to_string()),
        "a root that still holds the writer is kept"
    );
    adopt(run.path(), None);
    assert_eq!(
        load(run.path()).unwrap().ctx.root.as_deref(),
        Some("/found")
    );
}
