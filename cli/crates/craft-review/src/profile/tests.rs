use super::*;

#[test]
fn the_rust_profile_reads_and_every_brief_is_carried() {
    let p = Profile::rust().unwrap();
    assert_eq!(p.id, "rust");
    assert!(p.offers("intent") && !p.offers("negative-space"));
    assert!(p.lens("negative-space").is_some());
    assert_eq!(p.lens_agent, Some(AgentKind::RustReviewer));
    for l in p.lenses.iter().chain(&p.floor_lenses) {
        content::text(&l.brief).unwrap();
    }
    content::text(&p.scout_rules).unwrap();
    assert!(p.covers("a/Cargo.toml") && p.covers("src/x.rs") && !p.covers("x.rsx"));
}

#[test]
fn every_profile_reads_and_carries_its_briefs_and_scout_rules() {
    let all = Profile::all().unwrap();
    assert_eq!(
        all.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        IDS,
        "in the order a file is offered to them"
    );
    for p in &all {
        for l in p.lenses.iter().chain(&p.floor_lenses) {
            content::text(&l.brief).unwrap();
        }
        content::text(&p.scout_rules).unwrap();
        for l in &p.always_lenses {
            assert!(p.offers(l), "{}: {l}", p.id);
        }
        assert_eq!(
            p.lens("negative-space").is_some(),
            p.negative_space.is_some(),
            "{}: a negative-space lens names its surface",
            p.id
        );
    }
    Profile::load("go").unwrap_err();
}

#[test]
fn the_nix_profile_runs_its_lenses_on_the_nix_reviewer_over_its_globs() {
    let p = Profile::load("nix").unwrap();
    assert_eq!(p.lens_agent, Some(AgentKind::NixReviewer));
    assert!(p.rule_catalog, "nix-review ships rules.md");
    assert_eq!(
        (
            p.rubric_skill.as_str(),
            p.fp_rules.as_str(),
            p.safety_lens.as_str()
        ),
        ("nix-review", "", "injection")
    );
    assert!(p.covers("a/b.nix") && p.covers("flake.lock") && !p.covers("a.nixx"));
    assert_eq!(p.pathspec(&["x.nix".into()]), "'*.nix' 'flake.lock'");
}

#[test]
fn the_general_profile_takes_code_but_not_prose_or_configuration() {
    let p = Profile::load("general").unwrap();
    assert_eq!(
        p.lens_agent, None,
        "its lenses run on the host's default agent"
    );
    assert!(p.lens("negative-space").is_none());
    assert!(!p.rule_catalog, "review-rules ships no rules.md");
    assert!(
        p.lens("complexity").is_some_and(|l| l.metrics) && crate::complexity::wanted(&p),
        "complexity, behind its code-metrics index"
    );
    assert!(!Profile::rust().unwrap().lenses.iter().any(|l| l.metrics));
    for f in ["web/app.ts", "main.py", "src/lib.rs", "scripts/build.sh"] {
        assert!(p.covers(f), "{f}");
    }
    for f in [
        "README.md",
        "Cargo.lock",
        "Dockerfile",
        ".github/workflows/ci.yml",
    ] {
        assert!(!p.covers(f), "{f}");
    }
    assert_eq!(
        p.pathspec(&["web/app.ts".into(), "it's.py".into()]),
        r"':(literal)web/app.ts' ':(literal)it'\''s.py'",
        "its own files, each literal and quoted"
    );
}

#[test]
fn an_unknown_agent_or_model_token_refuses_the_profile() {
    let raw: serde_json::Value =
        serde_json::from_str(content::raw("profiles/rust.json").unwrap()).unwrap();
    for (key, bad) in [("lensAgent", "craft:rust-reviewer"), ("scoutModel", "gpt")] {
        let mut v = raw.clone();
        v[key] = serde_json::json!(bad);
        let err = serde_json::from_value::<Profile>(v).unwrap_err();
        assert!(err.to_string().contains("unknown variant"), "{key}: {err}");
    }
}
