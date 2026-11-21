use super::craft_agent;

#[test]
fn every_agent_craft_ships_is_its_own_by_bare_and_namespaced_name() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../integrations");
    for dir in ["claude-code/agents", "opencode/agents"] {
        for e in std::fs::read_dir(format!("{root}/{dir}")).unwrap() {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            let Some(name) = name.strip_suffix(".md") else {
                continue;
            };
            assert!(craft_agent(name), "{name}");
            assert!(craft_agent(&format!("craft:{name}")), "{name}");
        }
    }
    for other in ["general-purpose", "dev", "reviewer", "rust-reviewer-2", ""] {
        assert!(!craft_agent(other), "{other}");
    }
}
