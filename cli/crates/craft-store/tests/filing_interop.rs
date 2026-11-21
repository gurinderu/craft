use craft_store::{
    finalize::{Asked, Said, finalize},
    git::GitId,
    js::{Js, Obj},
    write::{Writing, write_record},
};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
};

fn logger() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../integrations/shared/craft-log-run.mjs")
}
fn raw() -> Obj {
    Obj::new()
        .with("kind", Js::str("workflow"))
        .with("name", Js::str("review"))
        .with("verdict", Js::str("Approve"))
}
fn writing(store: &Path) -> Writing {
    Writing {
        store: store.into(),
        project: "/p".into(),
        workdir: store.into(),
        session: String::new(),
        git_id: GitId::default(),
        observe: false,
        craft_commit: None,
        now: 0,
    }
}
fn detail_count(store: &Path) -> std::io::Result<usize> {
    Ok(std::fs::read_dir(store)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .count())
}
fn expire_dead_legacy_lock(store: &Path) -> std::io::Result<()> {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(store.join("index.jsonl.lock"))?;
    lock.set_times(
        std::fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60)),
    )
}

#[test]
fn rust_replays_every_javascript_process_crash_window_twice() {
    for window in [
        "intent",
        "marker",
        "verified",
        "detail",
        "index",
        "proof",
        "intent-unlink",
    ] {
        let d = tempfile::tempdir().unwrap();
        let script = r"
          import fs from 'node:fs'; import path from 'node:path';
          const [logger, store, window] = process.argv.slice(2);
          const {finalizeRun, writeCheckpoint} = await import(logger);
          const raw = {kind:'workflow',name:'review',verdict:'Approve'};
          const dir = path.join(store,'.partial','run');
          writeCheckpoint(dir,'start',raw,{project:'/p'});
          const kill = () => process.kill(process.pid, 'SIGKILL');
          const link = fs.linkSync.bind(fs), rename = fs.renameSync.bind(fs), unlink = fs.unlinkSync.bind(fs);
          const write = fs.writeFileSync.bind(fs), read = fs.readFileSync.bind(fs);
          fs.writeFileSync = (p,...args) => { write(p,...args); if (window === 'marker' && String(p).endsWith('/.finalized')) kill(); };
          fs.readFileSync = (p,...args) => { const value = read(p,...args);
            if (window === 'verified' && path.dirname(path.dirname(String(p))) === store && String(p).endsWith('.json')) kill();
            return value;
          };
          fs.linkSync = (a,b) => { link(a,b);
            if (window === 'intent' && path.dirname(b).endsWith('.filing-intents')) kill();
            if (window === 'detail' && path.dirname(b) === store) kill();
          };
          fs.renameSync = (a,b) => { rename(a,b);
            if (window === 'index' && b.endsWith('/index.jsonl')) kill();
            if (window === 'proof' && path.dirname(b).endsWith('.finalize-proofs')) kill();
          };
          fs.unlinkSync = p => { if (window === 'intent-unlink' && path.dirname(String(p)).endsWith('.filing-intents')) kill(); unlink(p); };
          finalizeRun(raw,{store,dir,project:'/p',observe:false});
        ";
        let result = Command::new("node")
            .args(["--input-type=module", "-e", script, "filing-test"])
            .arg(logger())
            .arg(d.path())
            .arg(window)
            .output()
            .unwrap();
        assert!(!result.status.success(), "{window}");
        assert!(
            result.stderr.is_empty(),
            "{window}: unexpected child error: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(result.status.signal(), Some(9), "{window}");
        }
        assert!(
            d.path().join(".filing-intents").exists(),
            "{window}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        expire_dead_legacy_lock(d.path()).unwrap();
        let dir = d.path().join(".partial/run");
        let w = writing(d.path());
        for _ in 0..2 {
            let mut said = Said::default();
            finalize(
                &raw(),
                &w,
                Asked {
                    dir: dir.to_str().unwrap(),
                    retry: true,
                    rejoin: false,
                },
                &mut said,
            )
            .unwrap();
            assert!(
                said.out.iter().any(|s| s.starts_with("already filed")),
                "{window}: {said:?}"
            );
        }
        assert_eq!(detail_count(d.path()).unwrap(), 1, "{window}");
        assert_eq!(
            std::fs::read_to_string(d.path().join("index.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1,
            "{window}"
        );
    }
}

#[test]
fn javascript_replays_rust_failed_index_and_proof_twice() {
    for blocked in ["index.jsonl", ".finalize-proofs"] {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(".partial/run");
        std::fs::create_dir_all(&dir).unwrap();
        if blocked == "index.jsonl" {
            std::fs::create_dir(d.path().join(blocked)).unwrap();
        } else {
            std::fs::write(d.path().join(blocked), "blocked").unwrap();
        }
        let w = writing(d.path());
        let result = finalize(
            &raw(),
            &w,
            Asked {
                dir: dir.to_str().unwrap(),
                ..Asked::default()
            },
            &mut Said::default(),
        );
        assert!(result.is_err());
        assert_eq!(detail_count(d.path()).unwrap(), 1);
        if blocked == "index.jsonl" {
            std::fs::remove_dir(d.path().join(blocked)).unwrap();
        } else {
            std::fs::remove_file(d.path().join(blocked)).unwrap();
        }
        let script = r"
          const [logger,store] = process.argv.slice(2); const {finalizeRun} = await import(logger);
          const raw = {kind:'workflow',name:'review',verdict:'Approve'};
          for (let i=0;i<2;i++) {
            const result = finalizeRun(raw,{store,dir:store+'/.partial/run',project:'/p',observe:false,retry:true});
            if (!result.already) throw new Error('retry was filed again');
          }
        ";
        let result = Command::new("node")
            .args(["--input-type=module", "-e", script, "filing-test"])
            .arg(logger())
            .arg(d.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(detail_count(d.path()).unwrap(), 1);
        assert_eq!(
            std::fs::read_to_string(d.path().join("index.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }
}

#[test]
fn identical_genuine_rust_filings_are_distinct_and_the_name_bound_refuses() {
    let d = tempfile::tempdir().unwrap();
    let w = writing(d.path());
    let mut files = std::collections::HashSet::new();
    for _ in 0..60 {
        files.insert(write_record(&raw(), &w, &GitId::default(), None).unwrap().0);
    }
    assert_eq!(files.len(), 60);
    let error = write_record(&raw(), &w, &GitId::default(), None).unwrap_err();
    assert!(error.to_string().contains("60 consecutive stamps"));
    assert_eq!(detail_count(d.path()).unwrap(), 60);
}

#[test]
fn concurrent_javascript_and_rust_ordinary_filings_preserve_every_run() {
    let d = tempfile::tempdir().unwrap();
    let script = r"
      const [logger, store] = process.argv.slice(2); const {writeRecord} = await import(logger);
      for (let i=0;i<10;i++) writeRecord({kind:'workflow',name:'review',verdict:'Approve'}, {store,project:'/p',observe:false,now:new Date(0)});
    ";
    let mut child = Command::new("node")
        .args(["--input-type=module", "-e", script, "filing-test"])
        .arg(logger())
        .arg(d.path())
        .spawn()
        .unwrap();
    for _ in 0..10 {
        write_record(&raw(), &writing(d.path()), &GitId::default(), None).unwrap();
    }
    assert!(child.wait().unwrap().success());
    assert_eq!(detail_count(d.path()).unwrap(), 20);
    assert_eq!(
        std::fs::read_to_string(d.path().join("index.jsonl"))
            .unwrap()
            .lines()
            .count(),
        20
    );
}

/// A replacement whose index publication failed, its detail then rewritten by a later writer: the
/// detail and retained intent paths, and the replacement payload.
fn retained_conflict(
    store: &Path,
    foreign: &str,
) -> Result<(PathBuf, PathBuf, Obj), Box<dyn std::error::Error>> {
    let w = writing(store);
    let (file, _) = write_record(&raw(), &w, &GitId::default(), None)?;
    let index = store.join("index.jsonl");
    std::fs::remove_file(&index)?;
    std::fs::create_dir(&index)?;
    let mut changed = raw();
    changed.set("verdict", Js::str("Block"));
    if write_record(&changed, &w, &GitId::default(), Some(&file)).is_ok() {
        return Err("the replacement's index publication did not fail".into());
    }
    std::fs::write(&file, foreign)?;
    std::fs::remove_dir(&index)?;
    let name = file.file_name().ok_or("a detail with no name")?;
    let intent = store.join(".filing-intents").join(name);
    Ok((file, intent, changed))
}

#[test]
fn replacement_replay_never_overwrites_a_newer_detail() {
    let d = tempfile::tempdir().unwrap();
    // The later writer kept the run's `ts`, so the replacement still targets this very detail.
    let foreign = r#"{"ts":"1970-01-01T00-00-00Z","kind":"workflow","name":"review","a":"later"}"#;
    let (file, intent, changed) = retained_conflict(d.path(), foreign).unwrap();
    let w = writing(d.path());
    let error = write_record(&changed, &w, &GitId::default(), Some(&file)).unwrap_err();
    assert!(error.to_string().contains("filing conflict"), "{error}");
    let named = intent.display().to_string();
    assert!(error.to_string().contains(&named), "{error}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), foreign);
    assert_eq!(
        std::fs::read_dir(d.path().join(".filing-intents"))
            .unwrap()
            .count(),
        1
    );
    assert!(!d.path().join("index.jsonl").exists());
}

/// The remedy the conflict names — move the detail aside, put the intent's record in its place —
/// keeps the run's record, and the next write completes the intent instead of losing it.
#[test]
fn the_named_remedy_keeps_the_run_record_and_completes_the_intent() {
    let d = tempfile::tempdir().unwrap();
    let foreign = r#"{"ts":"1970-01-01T00-00-00Z","kind":"workflow","name":"review","a":"later"}"#;
    let (file, intent, changed) = retained_conflict(d.path(), foreign).unwrap();
    let w = writing(d.path());
    let error = write_record(&changed, &w, &GitId::default(), Some(&file)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("jq -j .record <intent> > <detail>"),
        "{error}"
    );
    std::fs::rename(&file, file.with_extension("aside")).unwrap();
    let held: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&intent).unwrap()).unwrap();
    let record = held["record"].as_str().unwrap();
    std::fs::write(&file, record).unwrap();
    write_record(&raw(), &w, &GitId::default(), None).unwrap();
    assert!(!intent.exists());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), record);
    let index = std::fs::read_to_string(d.path().join("index.jsonl")).unwrap();
    assert!(index.contains(r#""verdict":"Block""#), "{index}");
}

/// A retained conflict blocks only its own detail: a later unrelated write and finalize go on,
/// the intent stays, the newer detail is never overwritten, and the warning names the intent.
#[test]
fn a_retained_conflict_never_blocks_a_write_to_another_detail() {
    let d = tempfile::tempdir().unwrap();
    let foreign = r#"{"a":"later writer"}"#;
    let (file, intent, _) = retained_conflict(d.path(), foreign).unwrap();
    let w = writing(d.path());
    let (other, _) = write_record(&raw(), &w, &GitId::default(), None).unwrap();
    assert_ne!(other, file);
    let mut said = Said::default();
    finalize(&raw(), &w, Asked::default(), &mut said).unwrap();
    let warned = said.err.join("\n");
    assert!(warned.contains("filing conflict"), "{warned}");
    assert!(warned.contains(&intent.display().to_string()), "{warned}");
    assert!(warned.contains("delete the intent"), "{warned}");
    let script = r"
      const [logger, store] = process.argv.slice(2); const {writeRecord} = await import(logger);
      writeRecord({kind:'workflow',name:'review',verdict:'Approve'}, {store,project:'/p',observe:false,now:new Date(0)});
    ";
    let js = Command::new("node")
        .args(["--input-type=module", "-e", script, "filing-test"])
        .arg(logger())
        .arg(d.path())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&js.stderr);
    assert!(js.status.success(), "{stderr}");
    assert!(stderr.contains(&intent.display().to_string()), "{stderr}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), foreign);
    assert!(intent.exists());
    assert_eq!(detail_count(d.path()).unwrap(), 4);
    let index = std::fs::read_to_string(d.path().join("index.jsonl")).unwrap();
    assert_eq!(index.lines().count(), 3);
}
