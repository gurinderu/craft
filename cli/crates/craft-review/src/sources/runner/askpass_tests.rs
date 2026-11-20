//! An askpass program on a desktop (`DISPLAY` set): a remote that answers 401 makes git ask for a
//! username, and the askpass the caller's environment names (`GIT_ASKPASS`, `SSH_ASKPASS`,
//! `core.askPass`) is never started — git fails at once, named.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use super::Git;
use crate::project::IntegrationPoint;
use crate::sources::{prepare, section};

const URL: &str = "https://example.com/org/sys.git";

/// A remote on localhost that answers every request with 401, asking for a password; its URL.
fn asking_remote() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/org/sys.git", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let mut buf = [0u8; 4096];
            let _read = s.read(&mut buf);
            let _wrote = s.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"r\"\r\n\
                  Content-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    });
    url
}

#[test]
fn an_askpass_program_is_never_started_and_git_fails_at_once() {
    let tmp = tempfile::tempdir().unwrap();
    let calls = tmp.path().join("calls");
    let askpass = tmp.path().join("askpass");
    std::fs::write(
        &askpass,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\nsleep 30\n",
            calls.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&askpass, std::fs::Permissions::from_mode(0o755)).unwrap();
    let ask = askpass.clone().into_os_string();
    let mut git = Git::prompt_free();
    git.timeout = Duration::from_secs(15);
    git.env.extend([
        ("DISPLAY".into(), ":0".into()),
        ("GIT_ASKPASS".into(), ask.clone()),
        ("SSH_ASKPASS".into(), ask),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_CONFIG_COUNT".into(), "2".into()),
        (
            "GIT_CONFIG_KEY_0".into(),
            format!("url.{}.insteadOf", asking_remote()).into(),
        ),
        ("GIT_CONFIG_VALUE_0".into(), URL.into()),
        ("GIT_CONFIG_KEY_1".into(), "core.askPass".into()),
        ("GIT_CONFIG_VALUE_1".into(), askpass.into_os_string()),
    ]);
    let point = IntegrationPoint {
        name: "sys".into(),
        repo: URL.into(),
        rev: "v1.2.3".into(),
    };
    let cache = tempfile::tempdir().unwrap();
    let began = Instant::now();
    let got = prepare(&[point], Ok(cache.path()), &git);
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "{:?}: {got:?}",
        began.elapsed()
    );
    assert!(!calls.exists(), "askpass was started: {got:?}");
    let error = &got.failed[0].error;
    assert!(error.starts_with("git failed: "), "{got:?}");
    assert!(error.contains("credential helper"), "{error}");
    assert!(section(&got, &[]).contains("- ⚠️ sys: git failed: "));
}
