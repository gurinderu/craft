//! Real native helper and Node writer, on every shipped native platform (#563 in @nick/craft).
#![expect(clippy::unwrap_used, reason = "integration fixtures fail loudly")]
use craft_store::{lock::with_index_lock, process_identity::query};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_craft");
const PRELUDE: &str = r"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
const {withIndexLock} = await import(pathToFileURL(path.join(process.env.ROOT, 'integrations/shared/index-lock.mjs')));
const {withIndexTurn,TURNS} = await import(pathToFileURL(path.join(process.env.ROOT, 'integrations/shared/index-turn.mjs')));
const {processIdentity} = await import(pathToFileURL(path.join(process.env.ROOT, 'integrations/shared/process-identity.mjs')));
const store = process.env.STORE;
const marker = path.join(store, 'entered');
const options = {timeoutMs: 500, waitMs: 2};
const helper = pid => JSON.parse(execFileSync(process.env.CRAFT_BIN, ['__craft-process-identity', '--pid', String(pid)], {encoding:'utf8'}));
";

fn node(store: &Path, script: &str) -> Command {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let mut cmd = Command::new("node");
    cmd.args(["--input-type=module", "-e", &format!("{PRELUDE}\n{script}")])
        .env("ROOT", root)
        .env("STORE", store)
        .env("CRAFT_BIN", BIN);
    cmd
}

struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) {
        drop(self.0.kill());
        drop(self.0.wait());
    }
}
fn ready(mut cmd: Command) -> Worker {
    let mut child = Worker(cmd.stdout(Stdio::piped()).spawn().unwrap());
    let mut line = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line, "ready\n");
    child
}
fn helper(pid: u32) -> serde_json::Value {
    let output = Command::new(BIN)
        .args(["__craft-process-identity", "--pid", &pid.to_string()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn helper_queries_current_and_killed_process_and_refuses_invalid_pid() {
    let pid = std::process::id();
    assert_eq!(
        helper(pid),
        serde_json::json!({"version":1,"pid":pid,"identity":query(pid).unwrap()})
    );
    let d = tempfile::tempdir().unwrap();
    let mut child = ready(node(
        d.path(),
        "process.stdout.write('ready\\n'); setInterval(()=>{},1000);",
    ));
    let child_pid = child.0.id();
    assert!(helper(child_pid)["identity"].is_string());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(helper(child_pid)["identity"].is_null());
    let refused = Command::new(BIN)
        .args(["__craft-process-identity", "--pid", "0"])
        .output()
        .unwrap();
    assert!(!refused.status.success());
    assert!(refused.stdout.is_empty());
    assert!(!refused.stderr.is_empty());
}

#[test]
fn node_uses_native_identity_and_refuses_live_or_malformed_owners() {
    let d = tempfile::tempdir().unwrap();
    let output = node(d.path(), r"
const id = processIdentity(process.pid, performance.now()+5000);
assert.deepEqual(helper(process.pid), {version:1,pid:process.pid,identity:id});
const root = path.join(store,TURNS); fs.mkdirSync(root);
const name = `${process.pid}-${id}-${'0'.repeat(24)}`;
const peer = path.join(root,name); fs.mkdirSync(peer);
for (const number of [null,'1']) {
  if(number) fs.writeFileSync(path.join(peer,'number'),number);
  assert.throws(()=>withIndexTurn(store,()=>assert.fail('entered beside live owner'),options),
    error=>error.code==='ETIMEDOUT'||/admission deadline/.test(error.message));
  assert.deepEqual(fs.readdirSync(root),[name]);
}
fs.rmSync(peer,{recursive:true});
for(const stale of [id.slice(0,36)+(id.endsWith('0'.repeat(16))?'1':'0').repeat(16), 'v1_'+(id.slice(3,35)==='0'.repeat(32)?'1':'0').repeat(32)+id.slice(35)]) {
  const old=path.join(root,`${process.pid}-${stale}-${'0'.repeat(24)}`); fs.mkdirSync(old);
  assert.equal(withIndexTurn(store,()=>true,options),true); assert.ok(fs.existsSync(old)); fs.rmdirSync(old);
}
fs.mkdirSync(path.join(root,'malformed'));
assert.throws(()=>withIndexTurn(store,()=>assert.fail('entered'),options),/invalid index writer ticket/);
fs.rmdirSync(path.join(root,'malformed'));
if(process.platform!=='linux') {
  for(const bin of [path.join(store,'absent'),process.execPath]) {
    process.env.CRAFT_BIN=bin;
    assert.throws(()=>withIndexTurn(store,()=>true,options));
    assert.deepEqual(fs.readdirSync(root),[]);
  }
}
").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn node_and_rust_exclude_each_other_with_the_real_helper() {
    let d = tempfile::tempdir().unwrap();
    let mut child = None;
    with_index_lock(d.path(), || {
        child = Some(ready(node(d.path(), "process.stdout.write('ready\\n'); withIndexLock(store,()=>fs.writeFileSync(marker,'node'));")));
        std::thread::sleep(Duration::from_millis(200));
        assert!(!d.path().join("entered").exists());
        Ok(())
    }).unwrap();
    assert!(child.as_mut().unwrap().0.wait().unwrap().success());
    assert_eq!(
        std::fs::read_to_string(d.path().join("entered")).unwrap(),
        "node"
    );
    let mut child = ready(node(
        d.path(),
        r"
withIndexLock(store,()=>{
  fs.writeFileSync(marker,'holding'); process.stdout.write('ready\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
  fs.writeFileSync(marker,'released');
});",
    ));
    with_index_lock(d.path(), || {
        assert_eq!(
            std::fs::read_to_string(d.path().join("entered")).unwrap(),
            "released"
        );
        Ok(())
    })
    .unwrap();
    assert!(child.0.wait().unwrap().success());
}
