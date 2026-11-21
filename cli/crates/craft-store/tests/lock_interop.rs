//! Real JS and Rust callers of the shared admission protocol (realm @nick/craft, #557).
#![expect(clippy::unwrap_used, reason = "test fixtures fail loudly")]

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime};

use craft_store::lock::{LOCK, with_index_lock};

struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) {
        drop(self.0.kill());
        drop(self.0.wait());
    }
}

fn javascript(store: &Path, body: &str) -> Worker {
    let module = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../integrations/shared/index-lock.mjs")
        .canonicalize()
        .unwrap();
    let mut worker = Worker(
        Command::new("node")
            .args(["--input-type=module", "-e", body])
            .env("LOCK_MODULE", module)
            .env("STORE", store)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut ready = String::new();
    BufReader::new(worker.0.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready, "ready\n");
    worker
}

const JS: &str = r"
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {withIndexLock} = await import(pathToFileURL(process.env.LOCK_MODULE));
const store = process.env.STORE;
withIndexLock(store, () => {
  const events = path.join(store, 'events');
  fs.appendFileSync(events, 'js in\n');
  fs.utimesSync(path.join(store, 'index.jsonl.lock'), new Date(0), new Date(0));
  process.stdout.write('ready\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  fs.appendFileSync(events, 'js out\n');
});
";

#[test]
fn rust_waits_for_a_live_javascript_owner_even_when_its_legacy_lock_is_old() {
    let dir = tempfile::tempdir().unwrap();
    let mut js = javascript(dir.path(), JS);
    with_index_lock(dir.path(), || {
        assert_eq!(
            std::fs::read_to_string(dir.path().join("events")).unwrap(),
            "js in\njs out\n"
        );
        Ok(())
    })
    .unwrap();
    assert!(js.0.wait().unwrap().success());
}

#[test]
fn javascript_waits_for_a_live_rust_owner_with_an_old_legacy_lock() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = None;
    with_index_lock(dir.path(), || {
        std::fs::File::options()
            .write(true)
            .open(dir.path().join(LOCK))
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        let body = JS
            .replace(
                "withIndexLock(store,",
                "process.stdout.write('ready\\n'); withIndexLock(store,",
            )
            .replace("  process.stdout.write('ready\\n');", "");
        child = Some(javascript(dir.path(), &body));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!dir.path().join("events").exists());
        Ok(())
    })
    .unwrap();
    assert!(child.as_mut().unwrap().0.wait().unwrap().success());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("events")).unwrap(),
        "js in\njs out\n"
    );
}

#[test]
fn a_process_killed_while_holding_the_lock_does_not_block_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let body = JS.replace("200);", "60000);");
    let mut js = javascript(dir.path(), &body);
    js.0.kill().unwrap();
    js.0.wait().unwrap();
    with_index_lock(dir.path(), || Ok(())).unwrap();
}

#[cfg(unix)]
#[test]
fn stopped_owner_excludes_both_writers_until_killed() {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let mut js = javascript(dir.path(), &JS.replace("200);", "60000);"));
    let pid = Pid::from_raw(i32::try_from(js.0.id()).unwrap());
    kill(pid, Signal::SIGSTOP).unwrap();
    let module = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../integrations/shared/index-lock.mjs")
        .canonicalize()
        .unwrap();
    let refused = Command::new("node").args(["--input-type=module", "-e", r"
      import {pathToFileURL} from 'node:url';
      const {withIndexLock}=await import(pathToFileURL(process.env.MODULE));
      try { withIndexLock(process.env.STORE,()=>process.exit(7),{timeoutMs:100,waitMs:2});process.exit(8); }
      catch(e) { if(!e.message.includes('deadline')) throw e; }
    "]).env("MODULE",module).env("STORE",dir.path()).status().unwrap();
    assert!(refused.success());
    let killed = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(150));
            killed.store(true, Ordering::SeqCst);
            kill(pid, Signal::SIGKILL).unwrap();
            js.0.wait().unwrap();
        });
        with_index_lock(dir.path(), || {
            assert!(killed.load(Ordering::SeqCst));
            Ok(())
        })
        .unwrap();
    });
}

#[test]
fn a_killed_writer_ticket_must_not_revive_when_its_pid_is_reassigned() {
    let dir = tempfile::tempdir().unwrap();
    let body = JS.replace("200);", "60000);");
    let mut js = distinct_javascript(dir.path(), &body);
    let root = dir.path().join(".index-writers");
    let original = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| name.starts_with(&format!("{}-", js.0.id())))
        .unwrap();
    js.0.kill().unwrap();
    js.0.wait().unwrap();
    // Real death, simulated PID reuse: retain every other byte of the owner's identity.
    let (_, identity) = original.split_once('-').unwrap();
    let reused = format!("{}-{identity}", std::process::id());
    std::fs::rename(root.join(original), root.join(&reused)).unwrap();
    std::fs::remove_file(dir.path().join(LOCK)).unwrap();
    with_index_lock(dir.path(), || Ok(())).unwrap();
    assert!(root.join(reused).exists());
}

#[expect(
    clippy::panic,
    reason = "bounded test fixture exhaustion must fail, not skip"
)]
fn distinct_javascript(store: &Path, body: &str) -> Worker {
    let own = craft_store::process_identity::query(std::process::id()).unwrap();
    for _ in 0..10 {
        let mut child = javascript(store, body);
        if craft_store::process_identity::query(child.0.id()).unwrap() != own {
            return child;
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("could not construct distinct starttime tokens after ten child processes");
}

#[test]
fn three_rust_contenders_do_not_overlap_while_the_legacy_lock_looks_stale() {
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };
    let dir = tempfile::tempdir().unwrap();
    let barrier = Barrier::new(3);
    let active = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..3 {
            scope.spawn(|| {
                barrier.wait();
                for _ in 0..5 {
                    with_index_lock(dir.path(), || {
                        assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                        std::fs::File::options()
                            .write(true)
                            .open(dir.path().join(LOCK))
                            .unwrap()
                            .set_modified(SystemTime::now() - Duration::from_secs(60))
                            .unwrap();
                        std::thread::sleep(Duration::from_millis(5));
                        assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
                        Ok(())
                    })
                    .unwrap();
                }
            });
        }
    });
}
