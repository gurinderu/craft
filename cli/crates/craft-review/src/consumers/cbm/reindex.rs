//! The graph brought to the checkout a review reads (realm @nick/craft, node #529): one
//! `index_repository` of it, under craft's own project, within the review's graph deadline, one
//! review at a time per project ([`super::lock`]). The graph indexes incrementally and swaps the
//! new graph in whole when it is done; while it runs, its questions answer from the graph it had
//! (observed on cbm 0.12.1, node #533). An index is never killed: one past the deadline, or one a
//! stop reaches, is left to finish in the background, since a killed index leaves its staging
//! files behind and, on a first index, no project at all (node #530).

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::lock::{self, Lock};
use super::{Cbm, CbmError, payload};
use crate::cancel::detached;
use crate::sources::spool::Spool;

/// The index mode asked for. `fast` and `moderate` leave out every directory named `bin`,
/// `docs` or `scripts` (where a workspace's binaries often live), so their callers would never
/// be asked; `full` leaves out only build output and tool directories, and its incremental run
/// over an unchanged checkout takes under a second (observed on cbm 0.12.1, node #530).
const MODE: &str = "full";
/// How much of the index's answer is read.
const CAP: u64 = 16 << 20;
/// How often the index is checked for having exited.
const POLL: Duration = Duration::from_millis(20);
/// The index run, under `sh`: the lock touched every `$4` seconds while it is this run's, the
/// tool, then the lock removed while it is still this run's. `$0` the tool, `$1` its arguments,
/// `$2` the lock directory, `$3` the lock's token.
const RUN: &str = r#"(while sleep "$4"; do [ "$(cat "$2/owner" 2>/dev/null)" = "$3" ] && touch "$2"; done) & beat=$!; "$0" cli --quiet index_repository "$1"; s=$?; kill "$beat" 2>/dev/null; [ "$(cat "$2/owner" 2>/dev/null)" = "$3" ] && rm -rf "$2"; exit $s"#;

impl Cbm {
    /// Indexes the checkout at `repo` as the project `name`, refused past `deadline`.
    ///
    /// # Errors
    /// When another review holds the project's lock past `deadline`, the index runs past it or a
    /// stop comes first (it is then left running), or the graph answers with an error or says
    /// the index is not done.
    pub fn reindex(&self, repo: &str, name: &str, deadline: Instant) -> Result<(), CbmError> {
        let lock = lock::take((&self.locks, self.lock_stale), name, deadline, &self.cancel)?;
        // An accepted limit (realm @nick/craft, node #530): a craft killed here, before the index
        // run below holds the lock, leaves a lock with no process behind it, and every review
        // skips the graph as locked until it goes stale, up to the stale age.
        let args = json!({"repo_path": repo, "mode": MODE, "name": name, "format": "json"});
        let started = self.spawn(&args.to_string(), &lock);
        let (child, out, err) = started.inspect_err(|_| lock.release())?;
        let answer = self.wait(child, out, err, deadline)?;
        match answer.get("status").and_then(Value::as_str) {
            Some("indexed") => Ok(()),
            other => Err(CbmError::Graph(format!(
                "index_repository: its answer says {}, not indexed",
                other.unwrap_or("no status")
            ))),
        }
    }

    /// The index run started detached, with no stdin, its output in spools.
    fn spawn(&self, args: &str, lock: &Lock) -> Result<(Child, Spool, Spool), CbmError> {
        let kept = |e: std::io::Error| CbmError::Output(format!("index output unreadable: {e}"));
        let (out, to_out) = Spool::new().map_err(kept)?;
        let (err, to_err) = Spool::new().map_err(kept)?;
        let mut cmd = Command::new("sh");
        let dir = lock.dir.display().to_string();
        let beat = format!("{:.3}", self.heartbeat.as_secs_f64());
        cmd.args(["-c", RUN, &self.tool, args, &dir, &lock.token, &beat]);
        cmd.stdin(Stdio::null()).stdout(to_out).stderr(to_err);
        detached(&mut cmd);
        let child = cmd
            .spawn()
            .map_err(|e| CbmError::Spawn(format!("{} could not run: {e}", self.tool)))?;
        Ok((child, out, err))
    }

    /// The index's answer once it exits before `deadline` and before a stop; past either it is
    /// left to finish, reaped in the background.
    fn wait(
        &self,
        mut child: Child,
        mut out: Spool,
        mut err: Spool,
        deadline: Instant,
    ) -> Result<Value, CbmError> {
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if self.cancel.is_cancelled() => {
                    return Err(leave(child, CbmError::Stopped));
                }
                Ok(None) if Instant::now() >= deadline => {
                    let ran = started.elapsed();
                    return Err(leave(child, CbmError::StillIndexing(ran)));
                }
                Ok(None) => std::thread::sleep(POLL),
                Err(e) => return Err(CbmError::Spawn(format!("waiting on the index failed: {e}"))),
            }
        };
        let kept = |e: std::io::Error| CbmError::Output(format!("index output unreadable: {e}"));
        let stdout = out.whole(CAP).map_err(kept)?;
        let stderr = err.whole(CAP).map_err(kept)?;
        payload("index_repository", status.success(), &stdout, &stderr)
    }
}

/// `why`, the index left running and reaped by a thread of its own when it exits.
fn leave(mut child: Child, why: CbmError) -> CbmError {
    std::thread::spawn(move || child.wait().map_or((), drop));
    why
}
