//! A remote that asks for a password (401, Basic): with no askpass of the caller's own, a
//! desktop's (`SSH_ASKPASS`, `core.askPass`, `DISPLAY` set) is never started and git fails at
//! once, named; the caller's own `GIT_ASKPASS` (a CI token script) is used and git authenticates.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::Git;
use crate::cancel::caller_chooses_prompts;
use crate::project::IntegrationPoint;
use crate::sources::{Sources, prepare, section};

const URL: &str = "https://example.com/org/sys.git";
/// `craft:token`, as Basic sends it.
const CRAFT_TOKEN: &str = "Authorization: Basic Y3JhZnQ6dG9rZW4=";

/// A remote on localhost that answers 401 to a request without credentials and an empty
/// advertisement to one with them; its URL, and the `Authorization` lines it was sent.
fn asking_remote() -> (String, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/org/sys.git", l.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let saw = Arc::clone(&seen);
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let auth: Vec<String> = req
                .lines()
                .filter(|l| l.starts_with("Authorization:"))
                .map(str::to_owned)
                .collect();
            let answer: &[u8] = if auth.is_empty() {
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"r\"\r\n\
                  Content-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                b"HTTP/1.1 200 OK\r\n\
                  Content-Type: application/x-git-upload-pack-advertisement\r\n\
                  Content-Length: 34\r\nConnection: close\r\n\r\n\
                  001e# service=git-upload-pack\n00000000"
            };
            saw.lock().unwrap().extend(auth);
            let _wrote = s.write_all(answer);
        }
    });
    (url, seen)
}

/// An askpass at `dir/askpass` that records each call in `dir/calls`, answers `craft` for a
/// username and `token` for a password, after `pause` seconds.
fn askpass(dir: &Path, pause: u32) -> std::path::PathBuf {
    let at = dir.join("askpass");
    let script = format!(
        "#!/bin/sh\necho \"$*\" >> '{}'\nsleep {pause}\n\
         case \"$1\" in Username*) echo craft ;; *) echo token ;; esac\n",
        dir.join("calls").display()
    );
    std::fs::write(&at, script).unwrap();
    std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
    at
}

/// git reaching `URL` at the asking remote, no configuration but this test's.
fn git_to(remote: &str) -> Git {
    let mut git = Git::prompt_free();
    git.timeout = Duration::from_secs(15);
    git.env.extend([
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        (
            "GIT_CONFIG_KEY_0".into(),
            format!("url.{remote}.insteadOf").into(),
        ),
        ("GIT_CONFIG_VALUE_0".into(), URL.into()),
    ]);
    git
}

fn prepared_by(git: &Git) -> (Sources, Duration) {
    let point = IntegrationPoint {
        name: "sys".into(),
        repo: URL.into(),
        rev: "v1.2.3".into(),
    };
    let cache = tempfile::tempdir().unwrap();
    let began = Instant::now();
    let got = prepare(&[point], Ok(cache.path()), git);
    (got, began.elapsed())
}

#[test]
fn a_desktop_askpass_is_never_started_and_git_fails_at_once() {
    if caller_chooses_prompts("a_desktop_askpass_is_never_started_and_git_fails_at_once") {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let ask = askpass(tmp.path(), 30).into_os_string();
    let (remote, _) = asking_remote();
    let mut git = git_to(&remote);
    git.env.extend([
        ("DISPLAY".into(), ":0".into()),
        ("SSH_ASKPASS".into(), ask.clone()),
        ("GIT_CONFIG_COUNT".into(), "2".into()),
        ("GIT_CONFIG_KEY_1".into(), "core.askPass".into()),
        ("GIT_CONFIG_VALUE_1".into(), ask),
    ]);
    let (got, took) = prepared_by(&git);
    assert!(took < Duration::from_secs(10), "{took:?}: {got:?}");
    assert!(
        !tmp.path().join("calls").exists(),
        "askpass was started: {got:?}"
    );
    let error = &got.failed[0].error;
    assert!(error.starts_with("git failed: "), "{got:?}");
    assert!(error.contains("credential helper"), "{error}");
    assert!(section(&got, &[]).contains("- ⚠️ sys: git failed: "));
}

#[test]
fn the_callers_own_askpass_is_used_and_git_authenticates() {
    let tmp = tempfile::tempdir().unwrap();
    let ask = askpass(tmp.path(), 0).into_os_string();
    let (remote, seen) = asking_remote();
    let mut git = git_to(&remote);
    git.env.push(("GIT_ASKPASS".into(), ask));
    let (got, took) = prepared_by(&git);
    assert!(took < Duration::from_secs(10), "{took:?}: {got:?}");
    assert!(
        tmp.path().join("calls").is_file(),
        "askpass never ran: {got:?}"
    );
    assert!(
        seen.lock().unwrap().iter().any(|a| a.trim() == CRAFT_TOKEN),
        "{seen:?}: {got:?}"
    );
}
