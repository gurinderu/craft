//! The preparation against a real git and a local repository standing in for the remote: a URL
//! git rewrites to it (`url.<dir>.insteadOf`), a temporary cache, no network.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;

use super::spec::{cache_segments, is_commit_id, ref_fault, repo_parts};
use super::{Git, Sources, cache_root, lens_block, prepare, section, verify_block};
use crate::project::IntegrationPoint;

const URL: &str = "https://example.com/org/sys.git";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A remote with a tag `v1.2.3` and a branch `dev`, and a cache beside it; the tag's commit.
fn remote() -> (tempfile::TempDir, String) {
    let t = tempfile::tempdir().unwrap();
    let r = t.path().join("remote");
    std::fs::create_dir_all(&r).unwrap();
    git(&r, &["init", "-q", "-b", "main"]);
    std::fs::write(r.join("main.go"), "package main\n").unwrap();
    git(&r, &["add", "."]);
    git(&r, &["commit", "-qm", "one"]);
    git(&r, &["tag", "v1.2.3"]);
    git(&r, &["branch", "dev"]);
    let sha = git(&r, &["rev-parse", "HEAD"]);
    (t, sha)
}

/// git that reaches `URL` at the local repository under `t` (or at nothing, `None`).
fn git_to(t: Option<&Path>) -> Git {
    let to = t.map_or_else(
        || "file:///nonexistent/craft-remote".to_owned(),
        |t| format!("file://{}", t.join("remote").display()),
    );
    let mut g = Git::prompt_free();
    g.env.extend([
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        (
            "GIT_CONFIG_KEY_0".into(),
            format!("url.{to}.insteadOf").into(),
        ),
        ("GIT_CONFIG_VALUE_0".into(), URL.into()),
    ]);
    g
}

fn point(rev: &str) -> IntegrationPoint {
    IntegrationPoint {
        name: "sys".into(),
        repo: URL.into(),
        rev: rev.into(),
    }
}

fn cache(t: &Path) -> PathBuf {
    t.join("cache")
}

/// Where `URL` at `rev` lands in the cache under `t`.
fn copy_at(t: &Path, rev: &str) -> PathBuf {
    let parts = repo_parts(URL).unwrap();
    cache_segments(&parts, URL, rev)
        .iter()
        .fold(cache(t), |d, s| d.join(s))
}

#[test]
fn a_tag_is_fetched_into_its_cache_directory_without_git_and_reused_without_a_remote() {
    let (t, _) = remote();
    let got = prepare(
        &[point("v1.2.3")],
        Ok(&cache(t.path())),
        &git_to(Some(t.path())),
    );
    let dir = copy_at(t.path(), "v1.2.3");
    assert_eq!(got.failed, []);
    assert_eq!(got.prepared[0].dir, dir.display().to_string());
    assert!(dir.join("main.go").is_file() && !dir.join(".git").exists());
    // The remote gone: the copy in the cache is taken as it is, no git run.
    let again = prepare(&[point("v1.2.3")], Ok(&cache(t.path())), &git_to(None));
    assert_eq!((again.prepared, again.failed), (got.prepared, vec![]));
}

#[test]
fn a_bare_version_resolves_to_its_v_tag_and_a_commit_is_fetched_by_its_id() {
    let (t, sha) = remote();
    let g = git_to(Some(t.path()));
    let got = prepare(&[point("1.2.3"), point(&sha)], Ok(&cache(t.path())), &g);
    let revs: Vec<&str> = got.prepared.iter().map(|p| p.rev.as_str()).collect();
    assert_eq!(revs, ["v1.2.3", sha.as_str()]);
    assert!(Path::new(&got.prepared[1].dir).join("main.go").is_file());
}

#[test]
fn a_branch_is_refused_before_anything_is_cloned() {
    let (t, _) = remote();
    let got = prepare(
        &[point("dev")],
        Ok(&cache(t.path())),
        &git_to(Some(t.path())),
    );
    assert_eq!(got.prepared, []);
    assert!(
        got.failed[0]
            .error
            .contains("dev is not a tag or a commit — a branch would be cached stale")
    );
    assert!(!copy_at(t.path(), "dev").exists());
}

#[test]
fn an_unreachable_source_is_named_and_the_review_goes_on_without_it() {
    let t = tempfile::tempdir().unwrap();
    let got = prepare(&[point("v1.2.3")], Ok(&cache(t.path())), &git_to(None));
    assert!(
        got.failed[0].error.starts_with("git failed: "),
        "{:?}",
        got.failed
    );
    let text = section(&got, &[]);
    assert!(text.contains("## External sources") && text.contains("- ⚠️ sys: git failed: "));
    assert!(text.contains("— reviewed without external context"));
    let none = prepare(
        &[point("v1.2.3")],
        Err("CRAFT_SOURCES_DIR is not absolute: x"),
        &git_to(None),
    );
    assert!(section(&none, &[]).contains(
        "- ⚠️ the source cache was unreachable (CRAFT_SOURCES_DIR is not absolute: x) — sys reviewed without external context"
    ));
}

#[test]
fn a_dead_runs_temporary_copy_is_swept_and_a_young_one_left() {
    let (t, _) = remote();
    let at = copy_at(t.path(), "v1.2.3");
    let parent = at.parent().unwrap();
    let leaf = at.file_name().unwrap().to_string_lossy().into_owned();
    let (old, young) = (
        parent.join(format!("{leaf}.tmp-1-a")),
        parent.join(format!("{leaf}.tmp-2-b")),
    );
    for d in [&old, &young] {
        std::fs::create_dir_all(d).unwrap();
    }
    let stamp = Command::new("touch")
        .args(["-d", "2 hours ago"])
        .arg(&old)
        .status()
        .unwrap();
    assert!(stamp.success());
    let got = prepare(
        &[point("v1.2.3")],
        Ok(&cache(t.path())),
        &git_to(Some(t.path())),
    );
    assert_eq!(got.failed, []);
    assert!(!old.exists() && young.exists());
}

#[test]
fn urls_revisions_and_cache_segments_are_checked_as_the_engine_checks_them() {
    let p = repo_parts("https://GitHub.com/kubevirt/kubevirt.git").unwrap();
    assert_eq!(
        (p.host.as_str(), p.path.as_str()),
        ("github.com", "kubevirt/kubevirt")
    );
    assert_eq!(
        repo_parts("ssh://git@gitlab.example:2222/a/b")
            .unwrap()
            .path,
        "a/b"
    );
    assert_eq!(
        repo_parts("git@github.com:kubeovn/kube-ovn.git")
            .unwrap()
            .path,
        "kubeovn/kube-ovn"
    );
    for bad in [
        "",
        "-u",
        "https://h/a b",
        "http://h/a",
        "file:///x",
        "https://user:pw@h/a",
        "https://../a",
        "https://h/a/../b",
        "git@h:-x",
        "ext::sh -c x",
    ] {
        assert!(repo_parts(bad).is_err(), "{bad}");
    }
    for ok in ["v1.13.2", "release/1.2", "kubernetes-1.30.0", "v1+build"] {
        assert_eq!(ref_fault(ok), None, "{ok}");
    }
    let long = "v".repeat(129);
    for bad in [
        "", "-x", "a..b", "a//b", "a/", "x.lock", "a b", "a;b", "$(x)", &long,
    ] {
        assert!(ref_fault(bad).is_some(), "{bad}");
    }
    assert!(is_commit_id(&"a".repeat(40)) && !is_commit_id("abc"));
}

#[test]
fn the_cache_key_is_readable_and_tells_every_repository_apart() {
    let parts = super::spec::RepoParts {
        host: "github.com".into(),
        path: "k8s/api server".into(),
    };
    let segs = cache_segments(&parts, "https://github.com/k8s/api server", "release/1.2");
    assert_eq!(segs[..2], ["github.com", "k8s"]);
    assert!(
        segs[2].starts_with("api_server.") && segs[2].ends_with("@release~1.2"),
        "{segs:?}"
    );
    // Two repositories the readable part spells alike never share a directory: by scheme and
    // port, by user, by a character `segment` replaces.
    for (a, b) in [
        ("https://h.example/a/b", "ssh://h.example:2222/a/b"),
        ("git@h.example:a/b", "deploy@h.example:a/b"),
        ("https://h.example/a~b/c", "https://h.example/a_b/c"),
    ] {
        let (pa, pb) = (repo_parts(a).unwrap(), repo_parts(b).unwrap());
        assert_eq!(
            (&pa.host, pa.path.replace('~', "_")),
            (&pb.host, pb.path.replace('~', "_"))
        );
        assert_ne!(
            cache_segments(&pa, a, "v1"),
            cache_segments(&pb, b, "v1"),
            "{a} {b}"
        );
    }
    let same = repo_parts("https://h.example/a/b.git").unwrap();
    assert_eq!(
        cache_segments(&same, "https://h.example/a/b.git", "v1"),
        cache_segments(&same, "https://h.example/a/b", "v1"),
        "the .git spelling is the same repository"
    );
}

#[test]
fn the_cache_is_the_variable_when_absolute_else_under_home() {
    assert_eq!(cache_root(Some("/c"), None), Ok(PathBuf::from("/c")));
    cache_root(Some("rel"), Some(Path::new("/h"))).unwrap_err();
    assert_eq!(
        cache_root(None, Some(Path::new("/h"))),
        Ok(PathBuf::from("/h/.craft/sources"))
    );
    cache_root(None, None).unwrap_err();
}

#[test]
fn the_blocks_are_empty_without_a_source_and_the_section_names_an_unrecorded_system() {
    assert_eq!(
        (lens_block(&[]), verify_block(&[])),
        (String::new(), String::new())
    );
    assert_eq!(section(&Sources::default(), &[]), "");
    let s = Sources {
        systems: vec!["kube-ovn".into()],
        ..Sources::default()
    };
    let findings = [
        json!({"externalSystem": "LINSTOR"}),
        json!({"externalSystem": "Kube-OVN"}),
        json!({"externalSystem": "a\nb"}),
    ];
    let text = section(&s, &findings);
    assert!(
        text.contains("- not recorded: LINSTOR — add it to the review profile with `craft init`")
    );
    assert!(!text.contains("Kube-OVN") && !text.contains("a\nb"));
}

#[test]
fn a_profile_that_cannot_be_read_is_named_and_the_review_goes_on_without_sources() {
    let (t, _) = remote();
    let repo = t.path().join("remote");
    let setup = super::SourcesSetup {
        projects: t.path().join("projects"),
        cache: Ok(cache(t.path())),
        git: git_to(None),
    };
    assert!(
        super::for_repo(&repo, &setup).is_empty(),
        "no profile, no sources"
    );
    let (path, _) = crate::project::profile_path(&setup.projects, &repo).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "version = \"one\"\n").unwrap();
    let got = super::for_repo(&repo, &setup);
    assert!(
        got.skipped
            .starts_with("the review profile could not be read: "),
        "{got:?}"
    );
    assert!(
        section(&got, &[]).contains(
            "- ⚠️ reviewed without external context — the review profile could not be read"
        )
    );
}

#[test]
fn the_budget_names_the_points_it_left_no_time_for_and_still_takes_a_cached_copy() {
    let (t, _) = remote();
    let mut g = git_to(None);
    // A remote that never answers: ssh hangs past the budget.
    g.env.push(("GIT_SSH_COMMAND".into(), "sleep 30;:".into()));
    g.budget = std::time::Duration::from_secs(1);
    let slow = |name: &str| IntegrationPoint {
        name: name.into(),
        repo: format!("ssh://slow.example/org/{name}.git"),
        rev: "v1.2.3".into(),
    };
    let cached = copy_at(t.path(), "v1.2.3");
    std::fs::create_dir_all(&cached).unwrap();
    let started = std::time::Instant::now();
    let points = [slow("a"), slow("b"), point("v1.2.3"), slow("c")];
    let got = prepare(&points, Ok(&cache(t.path())), &g);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(got.out_of_budget, ["a", "b", "c"]);
    assert_eq!((got.prepared.len(), got.failed.len()), (1, 0), "{got:?}");
    assert!(section(&got, &[]).contains(
        "- ⚠️ a, b, c: not prepared — the preparation's budget ran out — reviewed without external context"
    ));
}

#[test]
fn a_hooks_repository_variables_do_not_reach_the_preparation() {
    let (t, _) = remote();
    let mut g = git_to(Some(t.path()));
    let elsewhere = t.path().join("elsewhere");
    for v in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
        g.env.push((v.into(), elsewhere.clone().into_os_string()));
    }
    let got = prepare(&[point("v1.2.3")], Ok(&cache(t.path())), &g);
    assert_eq!(got.failed, []);
    assert!(Path::new(&got.prepared[0].dir).join("main.go").is_file());
    assert!(!elsewhere.exists());
}
