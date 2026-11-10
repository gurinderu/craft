//! An executable a test writes and then runs: a stand-in tool or script on a PATH of its own.
//! The integration tests reach it as `common::exe`; the lib's unit tests include this same file.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// Writes `content` to `path` as an executable (mode 755), through a `sh` child.
///
/// Linux refuses to exec a file that any process holds open for writing (ETXTBSY, "Text file
/// busy"). A write handle opened in this process (`std::fs::write`, `File::create`, `fs::copy`) is
/// inherited by every child another test thread forks meanwhile, and stays open in that child
/// until it execs, so running the file just written fails now and then under parallel tests.
/// Writing a temporary file and renaming it inside this process does not help: the leaked
/// descriptor points at the inode, and the rename keeps that inode. Here only the child opens the
/// file: it copies its stdin to a sibling temporary, makes it executable and renames it over
/// `path`, and once it has exited no process holds a write handle on it. This process holds only
/// the pipe.
pub fn write_executable(path: &Path, content: &str) -> std::io::Result<()> {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(r#"cat > "$1.tmp" && chmod 755 "$1.tmp" && mv -f "$1.tmp" "$1""#)
        .arg("sh")
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()?;
    let fed = child
        .stdin
        .take()
        .map_or(Ok(()), |mut stdin| stdin.write_all(content.as_bytes()));
    let status = child.wait()?;
    fed?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "writing {}: {status}",
            path.display()
        )))
    }
}
