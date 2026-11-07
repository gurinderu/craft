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
