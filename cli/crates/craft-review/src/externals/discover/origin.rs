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
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut out = Vec::new();
        drop(send.send(stdout.read_to_end(&mut out).map(|_| out)));
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
    // The same deadline bounds the pipe (realm @nick/craft, node #575).
    if !status.is_some_and(|s| s.success()) {
        return None;
    }
    let bytes = receive
        .recv_timeout(deadline.checked_duration_since(Instant::now())?)
        .ok()?
        .ok()?;
    let raw = String::from_utf8_lossy(&bytes);
    let value = raw.trim_matches(craft_store::js::is_space);
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
