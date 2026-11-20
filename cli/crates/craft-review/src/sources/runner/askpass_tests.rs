//! A remote that asks for a password (401, Basic): the caller's own `GIT_ASKPASS` (a CI token
//! script) is used, git authenticates and the source is prepared — craft's no-prompt environment
//! leaves git's askpass alone (realm @nick/craft, node #545). The remote is a local repository
//! served by `git http-backend` behind a minimal HTTP server.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::Git;
use crate::project::IntegrationPoint;
use crate::sources::prepare;

const URL: &str = "https://example.com/org/sys.git";
/// `craft:token`, as Basic sends it.
const CRAFT_TOKEN: &str = "Basic Y3JhZnQ6dG9rZW4=";

/// git in `dir`, as a fixture runs it.
fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

/// A bare repository `<root>/org/sys.git` with a tag `v1.2.3`.
fn repository(root: &Path) {
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("main.go"), "package main\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "one"]);
    git(&work, &["tag", "v1.2.3"]);
    let bare = root.join("org/sys.git");
    git(
        root,
        &[
            "clone",
            "-q",
            "--bare",
            "--",
            work.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
}

/// One request: its first line, its headers by lowercase name, its body (by Content-Length).
fn request(s: &TcpStream) -> (String, Vec<(String, String)>, Vec<u8>) {
    let mut r = BufReader::new(s);
    let mut first = String::new();
    r.read_line(&mut first).unwrap_or(0);
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_owned()));
        }
    }
    let len = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; len];
    r.read_exact(&mut body).unwrap_or(());
    (first, headers, body)
}

/// `git http-backend` answering one authenticated request, as an HTTP response.
fn backend(root: &Path, first: &str, headers: &[(String, String)], body: &[u8]) -> Vec<u8> {
    let mut parts = first.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("GET"), parts.next().unwrap_or("/"));
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map_or("", |(_, v)| v.as_str())
    };
    let mut cgi = Command::new("git")
        .arg("http-backend")
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", method)
        .env("PATH_INFO", path)
        .env("QUERY_STRING", query)
        .env("CONTENT_TYPE", header("content-type"))
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("HTTP_CONTENT_ENCODING", header("content-encoding"))
        .env("REMOTE_USER", "craft")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    cgi.stdin.take().unwrap().write_all(body).unwrap();
    let out = cgi.wait_with_output().unwrap().stdout;
    let split = out
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(out.len(), |i| i + 4);
    let head = String::from_utf8_lossy(&out[..split]);
    let status = head
        .lines()
        .find_map(|l| l.strip_prefix("Status: "))
        .unwrap_or("200 OK")
        .to_owned();
    let kept: String = head
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with("Status:"))
        .map(|l| format!("{l}\r\n"))
        .collect();
    let mut answer = format!("HTTP/1.1 {status}\r\n{kept}Connection: close\r\n\r\n").into_bytes();
    answer.extend_from_slice(&out[split..]);
    answer
}

/// A remote on localhost serving the repository under `root` to a request with credentials and
/// answering 401 to one without; its URL, and the `Authorization` values it was sent.
fn asking_remote(root: PathBuf) -> (String, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/org/sys.git", l.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let saw = Arc::clone(&seen);
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let (first, headers, body) = request(&s);
            let auth = headers.iter().find(|(k, _)| k == "authorization");
            let answer = match auth {
                Some((_, a)) => {
                    saw.lock().unwrap().push(a.clone());
                    backend(&root, &first, &headers, &body)
                }
                None => b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"r\"\r\n\
                          Content-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_vec(),
            };
            let _wrote = s.write_all(&answer);
        }
    });
    (url, seen)
}

/// An askpass at `dir/askpass` that records each call in `dir/calls` and answers `craft` for a
/// username and `token` for a password.
fn askpass(dir: &Path) -> PathBuf {
    let at = dir.join("askpass");
    let script = format!(
        "#!/bin/sh\necho \"$*\" >> '{}'\n\
         case \"$1\" in Username*) echo craft ;; *) echo token ;; esac\n",
        dir.join("calls").display()
    );
    std::fs::write(&at, script).unwrap();
    std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
    at
}

#[test]
fn the_callers_own_askpass_is_used_git_authenticates_and_the_source_is_prepared() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("served");
    repository(&root);
    let (remote, seen) = asking_remote(root);
    let mut git = Git::prompt_free();
    git.timeout = Duration::from_secs(15);
    git.env.extend([
        ("GIT_ASKPASS".into(), askpass(tmp.path()).into_os_string()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        (
            "GIT_CONFIG_KEY_0".into(),
            format!("url.{remote}.insteadOf").into(),
        ),
        ("GIT_CONFIG_VALUE_0".into(), URL.into()),
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
        "{:?}",
        began.elapsed()
    );
    assert!(
        tmp.path().join("calls").is_file(),
        "askpass never ran: {got:?}"
    );
    assert!(
        seen.lock().unwrap().iter().any(|a| a == CRAFT_TOKEN),
        "{seen:?}: {got:?}"
    );
    assert_eq!(got.failed, [], "{got:?}");
    assert!(
        Path::new(&got.prepared[0].dir).join("main.go").is_file(),
        "{got:?}"
    );
}
