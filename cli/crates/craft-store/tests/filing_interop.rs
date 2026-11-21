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
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../lib/craft-log-run.mjs")
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
          fs.unlinkSync = p => { if (window === 'intent-unlink' && path.dirname(p).endsWith('.filing-intents')) kill(); unlink(p); };
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

#[test]
fn replacement_replay_never_overwrites_a_newer_detail() {
    let d = tempfile::tempdir().unwrap();
    let w = writing(d.path());
    let (file, _) = write_record(&raw(), &w, &GitId::default(), None).unwrap();
    let index = d.path().join("index.jsonl");
    std::fs::remove_file(&index).unwrap();
    std::fs::create_dir(&index).unwrap();
    let mut changed = raw();
    changed.set("verdict", Js::str("Block"));
    write_record(&changed, &w, &GitId::default(), Some(&file)).unwrap_err();
    let foreign = r#"{"a":"later writer"}"#;
    std::fs::write(&file, foreign).unwrap();
    std::fs::remove_dir(&index).unwrap();
    let error = write_record(&changed, &w, &GitId::default(), Some(&file)).unwrap_err();
    assert!(error.to_string().contains("filing conflict"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), foreign);
    assert_eq!(
        std::fs::read_dir(d.path().join(".filing-intents"))
            .unwrap()
            .count(),
        1
    );
    assert!(!index.exists());
}
