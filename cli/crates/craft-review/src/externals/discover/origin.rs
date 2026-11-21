use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(super) fn url(root: &Path) -> String {
    read(root).unwrap_or_default()
}

fn read(root: &Path) -> Option<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", "origin"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        stdout.read_to_end(&mut out).map(|_| out)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) | Err(_) => {
                drop(child.kill());
                drop(child.wait());
                break None;
            }
        }
    };
    // Do not wait on a descendant retaining the pipe after the deadline.
    if !status.is_some_and(|s| s.success()) {
        return None;
    }
    let bytes = reader.join().ok()?.ok()?;
    let raw = String::from_utf8_lossy(&bytes);
    let value = raw.trim_matches(super::super::text::whitespace);
    let rest = value.strip_prefix("https://");
    if let Some((auth, path)) = rest
        .and_then(|r| r.split_once('@'))
        .filter(|(auth, _)| !auth.is_empty() && !auth.contains('/'))
    {
        let _ = auth;
        return Some(format!("https://{path}"));
    }
    Some(value.into())
}
