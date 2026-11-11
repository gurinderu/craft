//! One agent subprocess: started in a process group of its own ([`crate::process_group`]), its
//! input written to stdin and closed, and everything it printed collected when it exits. Every
//! backend that runs a host CLI goes through it.

use std::path::Path;
use std::process::{Output, Stdio};

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::AgentError;
use crate::process_group::{self, GroupGuard};

/// What one subprocess is started as.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Spawn<'a> {
    pub(crate) program: &'a Path,
    pub(crate) args: &'a [String],
    pub(crate) cwd: &'a Path,
    /// Variables set on top of craft's own environment.
    pub(crate) env: &'a [(String, String)],
    pub(crate) stdin: &'a [u8],
}

/// Runs the subprocess to its exit. Dropping the future (a timeout, a stop) stops its group.
pub(crate) async fn output(spawn: Spawn<'_>) -> Result<Output, AgentError> {
    let mut command = Command::new(spawn.program);
    command
        .args(spawn.args)
        .current_dir(spawn.cwd)
        .envs(spawn.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_group::isolate(&mut command);
    let mut child = command.spawn().map_err(|source| AgentError::Spawn {
        command: spawn.program.display().to_string(),
        source,
    })?;
    // Lives until this future ends or is dropped (a timeout, a stop): then the child's process
    // group is stopped.
    let _group = GroupGuard::new(child.id());
    if let Some(mut stdin) = child.stdin.take() {
        // A child that exits without reading its input breaks the pipe; its exit status and
        // stderr say why, so the broken pipe is not the error reported.
        if let Err(e) = feed(&mut stdin, spawn.stdin).await
            && e.kind() != std::io::ErrorKind::BrokenPipe
        {
            return Err(e.into());
        }
    }
    Ok(child.wait_with_output().await?)
}

/// Writes the input and closes stdin, so the child sees its end.
async fn feed(stdin: &mut tokio::process::ChildStdin, input: &[u8]) -> std::io::Result<()> {
    stdin.write_all(input).await?;
    stdin.shutdown().await
}

/// A failed exit as the error that keeps both streams: what a host CLI says of a missing login or
/// a usage limit may be on either.
pub(crate) fn quit(output: &Output) -> AgentError {
    AgentError::Quit {
        code: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
    }
}

/// A clean exit that left no answer, both streams kept for what the process last said.
pub(crate) fn no_answer(output: &Output) -> AgentError {
    AgentError::NoAnswer {
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
    }
}
