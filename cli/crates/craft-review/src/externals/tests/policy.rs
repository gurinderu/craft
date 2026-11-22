use super::super::{pattern::Engine, text};
use crate::sources::spec::repo_parts;

#[test]
fn repository_and_revision_policy_retains_the_legacy_tables() {
    for (url, host, path) in [
        (
            "https://GitHub.com/kubevirt/kubevirt.git",
            "github.com",
            "kubevirt/kubevirt",
        ),
        ("ssh://git@gitlab.example:2222/a/b", "gitlab.example", "a/b"),
        (
            "git@github.com:kubeovn/kube-ovn.git",
            "github.com",
            "kubeovn/kube-ovn",
        ),
    ] {
        let parts = repo_parts(url).unwrap();
        assert_eq!((parts.host.as_str(), parts.path.as_str()), (host, path));
    }
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
        assert!(!repo_parts(bad).unwrap_err().is_empty(), "{bad}");
    }
    for ok in [
        "v1.13.2",
        "release/1.2",
        "kubernetes-1.30.0",
        "0123456789abcdef0123456789abcdef01234567",
        "v1+build",
    ] {
        assert_eq!(text::ref_fault(&ok.into()), None, "{ok}");
    }
    for bad in [
        "",
        "-x",
        "a..b",
        "a//b",
        "a/",
        "x.lock",
        "a b",
        "a;b",
        "$(x)",
        &"v".repeat(129),
    ] {
        assert!(text::ref_fault(&bad.into()).is_some(), "{bad}");
    }
}

#[test]
fn legacy_pattern_examples_retain_their_capture_and_length_boundaries() {
    let engine = Engine::new().unwrap();
    let pattern = r#"^version: "?([^"\s]+)"#.into();
    engine.check(&pattern).unwrap();
    assert_eq!(
        engine
            .read_ref(&pattern, &"name: x\nversion: \"v0.4.1\"\n".into())
            .unwrap(),
        "v0.4.1"
    );
    assert_eq!(
        engine
            .read_ref(&pattern, &"none".into())
            .unwrap_err()
            .to_string(),
        "versionMatch found no version in versionFrom"
    );
    assert_eq!(
        engine.check(&"(?<a>x)(y)".into()).unwrap_err().to_string(),
        "versionMatch has 2 capture groups, not exactly one"
    );
    engine.check(&r"(?:v)(\d+)".into()).unwrap();
    engine
        .check(&format!("(v){}", "x".repeat(197)).into())
        .unwrap();
    assert_eq!(
        engine
            .check(&format!("(v){}", "x".repeat(198)).into())
            .unwrap_err()
            .to_string(),
        "versionMatch over 200 characters"
    );
}
