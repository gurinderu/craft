//! The real write: `node <root>/lib/cli-review-file.mjs <command> --input <file>`, run in the
//! run's `filing/` directory, which holds the request, the answer the last line the adapter
//! printed. Bounded as a gate tool is ([`crate::gate::runner`]): a hung writer
//! is killed and the review goes on without its record.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::wire::{Call, WriteError, Writer};
use crate::gate::runner::{Ran, Runner};

/// The adapter, inside craft's plugin root.
pub(super) const ADAPTER: &str = "lib/cli-review-file.mjs";
/// How long one write may take: craft-log-run reads git and the store, nothing slower.
const BUDGET: Duration = Duration::from_secs(60);

/// Runs each write with the `node` on the PATH.
#[derive(Debug, Clone, Copy, Default)]
pub struct NodeWriter;

impl Writer for NodeWriter {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        run_writer(call, "node")
    }
}

/// One write through `program` over the adapter, run in the run's `filing/` directory: the
/// reviewed repository is named in the request, and a run filed again after its worktree was
/// removed still has somewhere to run.
fn run_writer(call: &Call<'_>, program: &str) -> Result<Value, WriteError> {
    let dir = call.run.join("filing");
    let input = dir.join(format!("{}.json", call.command));
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&input, call.request.to_string()))
        .map_err(|e| WriteError::Broken(format!("writing {}: {e}", input.display())))?;
    let adapter = Path::new(call.root).join(ADAPTER);
    let (adapter, input) = (adapter.display().to_string(), input.display().to_string());
    let ran = Runner::new(BUDGET, None, dir.clone()).run(
        &dir,
        program,
        &[&adapter, call.command, "--input", &input],
    );
    answer(ran)
}

/// The adapter's answer from what running it came to.
fn answer(ran: Ran) -> Result<Value, WriteError> {
    match ran {
        Ran::Exited {
            ok: true, out, err, ..
        } => out
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .and_then(|l| serde_json::from_str::<Value>(l).ok())
            .filter(Value::is_object)
            .ok_or_else(|| WriteError::NoAnswer(last_words(&err))),
        Ran::Exited { ok: false, err, .. } => Err(WriteError::Exited(last_words(&err))),
        Ran::Missing => Err(WriteError::NoNode),
        Ran::TimedOut(d) => Err(WriteError::TimedOut(d.as_secs())),
        Ran::Broken(e) => Err(WriteError::Broken(e)),
    }
}

/// The last thing the writer said on stderr, or that it said nothing.
fn last_words(err: &str) -> String {
    err.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map_or_else(|| "it said nothing".to_owned(), |l| l.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A writer run as `sh` over a shell script at the adapter's place, which answers with the
    /// directory it ran in.
    #[test]
    fn the_writer_runs_in_the_runs_filing_directory_whatever_became_of_the_reviewed_repo() {
        let (root, run) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::create_dir_all(root.path().join("lib")).unwrap();
        std::fs::write(
            root.path().join(ADAPTER),
            "printf '{\"ok\":true,\"cwd\":\"%s\"}\\n' \"$(pwd -P)\"\n",
        )
        .unwrap();
        let root_str = root.path().display().to_string();
        let call = Call {
            run: run.path(),
            root: &root_str,
            command: "finalize",
            request: &json!({"repo": "/gone/worktree"}),
        };
        let got = run_writer(&call, "sh").unwrap();
        let filing = run.path().join("filing").canonicalize().unwrap();
        assert_eq!(got["cwd"], json!(filing.display().to_string()));
    }

    #[test]
    fn the_answer_is_the_last_line_whatever_the_logger_printed_before_it() {
        let out = "wrote /store/r.json\n{\"ok\":true,\"reason\":\"\"}\n".to_owned();
        let ran = Ran::Exited {
            ok: true,
            code: Some(0),
            out,
            err: String::new(),
        };
        assert_eq!(answer(ran), Ok(json!({"ok": true, "reason": ""})));
    }

    #[test]
    fn a_writer_that_could_not_run_says_why() {
        let failed = Ran::Exited {
            ok: false,
            code: Some(1),
            out: String::new(),
            err: "x\ncli-review-file: the input cannot be read\n".into(),
        };
        assert_eq!(
            answer(failed),
            Err(WriteError::Exited(
                "cli-review-file: the input cannot be read".into()
            ))
        );
        assert_eq!(answer(Ran::Missing), Err(WriteError::NoNode));
        let silent = Ran::Exited {
            ok: true,
            code: Some(0),
            out: "not json\n".into(),
            err: String::new(),
        };
        assert_eq!(
            answer(silent),
            Err(WriteError::NoAnswer("it said nothing".into()))
        );
    }
}
