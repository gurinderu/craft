use super::super::{manifest, pattern::Engine};

fn crd(fields: usize) -> String {
    let mut text = String::from("apiVersion: v1\nkind: Thing\nspec:\n");
    for i in 0..fields {
        text.push_str(&format!(
            "  field{i}:\n    description: \"field {i} # docs\"\n    type: string\n    # note\n\n"
        ));
    }
    text.push_str("  image: ghcr.io/acme/app:v1.2.3\n");
    text
}

#[test]
fn a_manifests_lines_cost_a_fixed_number_of_engine_calls_not_a_few_each() {
    for fields in [10, 5_000] {
        let engine = Engine::new().unwrap();
        manifest::lines::Document::new(&engine, &crd(fields)).unwrap();
        assert_eq!(engine.calls(), 4, "{fields} fields");
    }
}

#[test]
fn discovery_over_a_large_manifest_stays_bounded_in_calls_and_finds_the_same() {
    let (small, large) = (Engine::new().unwrap(), Engine::new().unwrap());
    let found = |engine: &Engine, fields| {
        manifest::candidates(engine, "deploy/crd.yaml", &crd(fields))
            .unwrap()
            .into_iter()
            .map(|c| c.system)
            .collect::<Vec<_>>()
    };
    assert_eq!(found(&small, 10), ["app"]);
    assert_eq!(found(&large, 20_000), ["app"]);
    assert_eq!(small.calls(), large.calls());
}

#[test]
fn a_system_already_found_is_not_read_again() {
    let engine = Engine::new().unwrap();
    let text = "apiVersion: v1\nkind: Pod\nspec:\n  a:\n    image: ghcr.io/acme/app:v1\n  b:\n    image: ghcr.io/acme/app:v2\n";
    let once = engine.calls();
    let found = manifest::candidates(&engine, "deploy/pod.yaml", text).unwrap();
    assert_eq!(found.len(), 1);
    let twice = Engine::new().unwrap();
    manifest::candidates(
        &twice,
        "deploy/pod.yaml",
        &text.replace("app:v2", "other:v2"),
    )
    .unwrap();
    assert!(
        engine.calls() - once < twice.calls(),
        "the duplicate was read"
    );
}
