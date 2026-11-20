//! Isolation of a run-store write from the review driver.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use craft_review::filing::{Call, StoreWriter, WriteError, Writer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const BUDGET: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize)]
struct Request {
    run: PathBuf,
    root: String,
    command: String,
    request: Value,
}

pub struct BoundedWriter;

impl Writer for BoundedWriter {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        let executable = std::env::current_exe().map_err(|e| WriteError::Broken(e.to_string()))?;
        let request = Request {
            run: call.run.to_path_buf(),
            root: call.root.into(),
            command: call.command.into(),
            request: call.request.clone(),
        };
        let input = serde_json::to_vec(&request).map_err(|e| WriteError::Broken(e.to_string()))?;
        let mut command = Command::new(executable);
        command.arg("__craft-file-run");
        command.env("TOKIO_WORKER_THREADS", "1");
        let output =
            run(&mut command, input, BUDGET).map_err(|e| WriteError::Broken(e.to_string()))?;
        let answer: Result<Value, String> =
            serde_json::from_slice(&output).map_err(|e| WriteError::NoAnswer(e.to_string()))?;
        answer.map_err(WriteError::Store)
    }
}

pub fn worker() -> anyhow::Result<std::process::ExitCode> {
    let input: Request = serde_json::from_reader(std::io::stdin().lock())?;
    let call = Call {
        run: &input.run,
        root: &input.root,
        command: &input.command,
        request: &input.request,
    };
    let output = StoreWriter::default()
        .write(&call)
        .map_err(|e| e.to_string());
    serde_json::to_writer(std::io::stdout().lock(), &output)?;
    Ok(std::process::ExitCode::SUCCESS)
}

fn run(command: &mut Command, input: Vec<u8>, limit: Duration) -> std::io::Result<Vec<u8>> {
    craft_review::cancel::detached(command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("writer stdin missing"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("writer stdout missing"))?;
    std::thread::spawn(move || {
        drop(stdin.write_all(&input));
    });
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        drop(tx.send(stdout.read_to_end(&mut bytes).map(|_| bytes)));
    });
    let deadline = Instant::now() + limit;
    let mut status = None;
    loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(s) => status = s,
                Err(e) => {
                    craft_review::cancel::kill_group(&mut child);
                    return Err(e);
                }
            }
        }
        if let Some(s) = status {
            if !s.success() {
                return Err(std::io::Error::other(format!("writer exited {s}")));
            }
            if let Ok(result) = rx.try_recv() {
                return result;
            }
        }
        if Instant::now() >= deadline {
            craft_review::cancel::kill_group(&mut child);
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "store writer exceeded its deadline",
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn a_stalled_writer_is_cut_at_the_deadline() {
        let mut command = Command::new("sleep");
        command.arg("2");
        let started = Instant::now();
        let result = run(&mut command, Vec::new(), Duration::from_millis(100));
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn a_descendant_holding_stdout_does_not_extend_the_deadline() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 2 & exit 0"]);
        let started = Instant::now();
        assert_eq!(
            run(&mut command, Vec::new(), Duration::from_millis(100))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn a_timed_out_writer_and_its_child_do_not_write_later() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("late");
        let mut command = Command::new("sh");
        command.args(["-c", "(sleep 1; printf late > \"$1\") & wait", "sh"]);
        command.arg(&marker);
        assert_eq!(
            run(&mut command, Vec::new(), Duration::from_millis(100))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        std::thread::sleep(Duration::from_millis(1300));
        assert!(!marker.exists());
    }

    #[test]
    fn a_large_request_reaches_the_writer_without_blocking_its_output() {
        let input = vec![b'x'; 1_000_000];
        let got = run(
            &mut Command::new("cat"),
            input.clone(),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(got, input);
    }
}
