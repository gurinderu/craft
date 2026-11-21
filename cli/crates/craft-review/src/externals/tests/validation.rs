use super::super::{candidate::Candidate, manifest::Raw, pattern::Engine};

fn raw() -> Raw {
    Raw {
        system: "kube-ovn".into(),
        repo: "https://github.com/kubeovn/kube-ovn".into(),
        guessed: true,
        version: "v1.12.3".into(),
        pattern: r"tag: (\S+)".into(),
        note: String::new(),
    }
}

#[test]
fn discovery_candidate_checks_derived_paths_pattern_and_controls() {
    let engine = Engine::new().unwrap();
    let long_path = format!("{}/values.yaml", "a".repeat(301));
    let check = |r, file| Candidate::checked(&engine, r, file, "tag: v1.12.3").unwrap();
    let got = check(raw(), "charts/values.yaml").unwrap().json();
    assert_eq!(got.as_obj().unwrap().text("scope").unwrap(), "charts");
    for (field, value) in [
        ("system", "a b"),
        ("system", "a\u{7f}"),
        ("pattern", "(a)(b)"),
        ("pattern", "a`(b)"),
        ("version", "-x"),
        ("note", "line\nfeed"),
    ] {
        let mut r = raw();
        match field {
            "system" => r.system = value.into(),
            "pattern" => r.pattern = value.into(),
            "version" => r.version = value.into(),
            _ => r.note = value.into(),
        }
        assert!(check(r, "charts/values.yaml").is_none(), "{field}: {value}");
    }
    for file in [
        "../x/values.yaml",
        "/etc/values.yaml",
        "x;rm/values.yaml",
        "a/../../b/values.yaml",
        "line\nfeed/values.yaml",
        "a\u{7f}/values.yaml",
        &long_path,
    ] {
        assert!(check(raw(), file).is_none(), "{file}");
    }
    // Discovery clears unusable repositories before candidate validation, as candidatesIn did.
    for repo in ["ftp://x/y", "git@github.com:a/b", ""] {
        let mut r = raw();
        r.repo = repo.into();
        r.note = "a b`c".into();
        let got = check(r, "charts/values.yaml").unwrap().json();
        let o = got.as_obj().unwrap();
        assert_eq!(o.text("repo").unwrap(), "");
        assert_eq!(
            o.get("repoGuessed"),
            Some(&craft_store::js::Js::Bool(false))
        );
        assert_eq!(o.text("note").unwrap(), "a b c");
    }
}
