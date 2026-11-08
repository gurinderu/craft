//! `craft init` and the review that reads what it wrote: the profile proposed and written outside
//! the repository, then `review start` preparing each integration point's source into the cache
//! and the lenses that judge another system's behaviour reading it. The remote is a local
//! repository git reaches through `url.<dir>.insteadOf`, and HOME a temporary directory.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;

const URL: &str = "https://example.com/org/sys.git";

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}");
}

/// A repository with a Rust change on top of `origin/main`, and a remote tagged `v1.2.3`.
fn fixture(t: &Path) {
    let (repo, remote) = (t.join("repo"), t.join("remote"));
    for (d, file) in [(&repo, "README.md"), (&remote, "api.go")] {
        std::fs::create_dir_all(d).unwrap();
        git(d, &["init", "-q", "-b", "main"]);
        std::fs::write(d.join(file), "x\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "init"]);
    }
    git(&remote, &["tag", "v1.2.3"]);
    git(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "feat: add f"]);
}

/// `craft <args>` with HOME, the cache and the remote's rewrite under `t`.
fn craft(t: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env("CRAFT_SOURCES_DIR", t.join("cache"))
        .env("GIT_CONFIG_COUNT", "1")
        .env(
            "GIT_CONFIG_KEY_0",
            format!("url.file://{}.insteadOf", t.join("remote").display()),
        )
        .env("GIT_CONFIG_VALUE_0", URL)
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap()
}

fn json_of(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn repo_arg(t: &Path) -> String {
    t.join("repo").display().to_string()
}

#[test]
fn init_proposes_writes_and_proposes_again_what_it_wrote_outside_the_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    fixture(t);
    let repo = repo_arg(t);
    let empty = t.join("plugin").display().to_string();
    let propose = ["init", "--propose", "--cwd", &repo, "--craft-root", &empty];
    let first = json_of(&craft(t, &propose));
    assert_eq!(
        (&first["exists"], &first["integrations"]),
        (&Value::Bool(false), &serde_json::json!([]))
    );
    assert_eq!(
        first["discovery"]["ran"], false,
        "no discovery script in that root"
    );
    let profile = first["profile"].as_str().unwrap();
    assert!(
        profile.starts_with(t.join("home/.craft/projects/repo-").to_str().unwrap()),
        "{profile}"
    );
    assert!(profile.ends_with("/review.toml"));

    let point = format!("sys={URL}@v1.2.3");
    json_of(&craft(
        t,
        &["init", "--write", "--cwd", &repo, "--point", &point],
    ));
    let again = json_of(&craft(
        t,
        &["init", "--propose", "--cwd", &format!("{repo}/src")],
    ));
    assert_eq!(
        again["profile"], first["profile"],
        "a subdirectory is the same repository"
    );
    assert_eq!(again["exists"], true);
    assert_eq!(again["integrations"][0]["ref"], "v1.2.3");
    let refused = craft(
        t,
        &[
            "init",
            "--write",
            "--cwd",
            &repo,
            "--point",
            "sys=file:///x@v1",
        ],
    );
    assert!(!refused.status.success());
    assert!(!t.join("repo/review.toml").exists());
}

#[test]
fn a_review_prepares_the_profiles_sources_and_its_reconciler_lens_reads_them() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    fixture(t);
    let repo = repo_arg(t);
    let point = format!("sys={URL}@v1.2.3");
    json_of(&craft(
        t,
        &["init", "--write", "--cwd", &repo, "--point", &point],
    ));
    let run = t.join("run").display().to_string();
    let start = [
        "review",
        "start",
        "--cwd",
        &repo,
        "--run-dir",
        &run,
        "--no-recall",
    ];
    json_of(&craft(t, &start));
    let mut copies = std::fs::read_dir(t.join("cache/example.com/org")).unwrap();
    let dir = copies.next().unwrap().unwrap().path();
    assert!(copies.next().is_none(), "one copy, no temporary left");
    let leaf = dir.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        leaf.starts_with("sys.") && leaf.ends_with("@v1.2.3"),
        "{leaf}"
    );
    assert!(dir.join("api.go").is_file());
    let answers = t.join("answers.json");
    let scout = r#"{"scout-rust": {"sizeBucket": "small", "lenses": ["reconciler"], "isLibrary": false,
        "securitySensitive": false, "intent": "", "churn": [], "repoRules": [], "notes": ""}}"#;
    std::fs::write(&answers, scout).unwrap();
    let step = json_of(&craft(
        t,
        &[
            "review",
            "submit",
            "--run",
            &run,
            "--answers",
            answers.to_str().unwrap(),
        ],
    ));
    let prompt_of = |id: &str| {
        let task = step["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == id)
            .unwrap();
        std::fs::read_to_string(task["promptFile"].as_str().unwrap()).unwrap()
    };
    let block = format!(
        "EXTERNAL SOURCES (read-only — the source of a system this code relies on, at the version the consumer deploys; read it with your own Read, Grep and Glob tools inside that directory, never modify it):\n- sys @ v1.2.3: {}\n",
        dir.display()
    );
    assert!(prompt_of("lens-rust-reconciler-r1").contains(&block));
    let ids: Vec<&str> = step["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert!(
        !prompt_of("lens-rust-intent-r1").contains("EXTERNAL SOURCES"),
        "{ids:?}"
    );
}

/// `craft <args>` as [`craft`] runs it, `stdin` piped in.
fn craft_fed(t: &Path, args: &[&str], stdin: &str) -> Output {
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(args)
        .env("HOME", t.join("home"))
        .env_remove("CRAFT_ROOT")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn propose_imports_the_memorys_external_records_with_the_revision_their_file_names() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    fixture(t);
    let repo = repo_arg(t);
    std::fs::create_dir_all(t.join("repo/deploy")).unwrap();
    std::fs::write(t.join("repo/deploy/values.yaml"), "sys:\n  tag: v1.2.3\n").unwrap();
    // craft's own checkout: its lib/craft-externals.mjs reads the records.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let root = root.canonicalize().unwrap().display().to_string();
    let records = serde_json::json!([
        {"kind": "external", "system": "sys", "repo": URL, "versionFrom": "deploy/values.yaml",
         "versionMatch": "tag: (\\S+)", "scope": "src", "status": "active"},
        {"kind": "external", "system": "old", "repo": URL, "version": "v1", "status": "withdrawn"},
    ])
    .to_string();
    let propose = [
        "init",
        "--propose",
        "--cwd",
        &repo,
        "--craft-root",
        &root,
        "--memory-externals",
        "-",
    ];
    let first = json_of(&craft_fed(t, &propose, &records));
    let memory = &first["memory"];
    assert_eq!(memory["ran"], true, "{memory}");
    assert_eq!(
        memory["candidates"],
        serde_json::json!([{
            "system": "sys", "repo": URL, "ref": "v1.2.3", "scope": "src",
            "versionFrom": "deploy/values.yaml", "versionMatch": "tag: (\\S+)",
            "point": format!("sys={URL}@v1.2.3"), "profileRef": null
        }])
    );
    assert_eq!(
        memory["refused"],
        serde_json::json!(["external record #1 (old): status withdrawn"])
    );
    assert_eq!(first["discovery"]["ran"], true, "{}", first["discovery"]);

    // The reviewer confirms it: written, the next proposal names the profile's revision beside it.
    let point = memory["candidates"][0]["point"].as_str().unwrap();
    json_of(&craft(
        t,
        &["init", "--write", "--cwd", &repo, "--point", point],
    ));
    let again = json_of(&craft_fed(t, &propose, &records));
    assert_eq!(again["memory"]["candidates"][0]["profileRef"], "v1.2.3");

    // Without the flag, or with stdin that is no JSON, the proposal still runs and says why.
    let plain = json_of(&craft(t, &propose[..6]));
    assert_eq!(plain["memory"]["ran"], false);
    let unreadable = json_of(&craft_fed(t, &propose, "not json"));
    assert!(
        unreadable["memory"]["why"]
            .as_str()
            .unwrap()
            .contains("stdin is not JSON"),
        "{unreadable}"
    );
}
