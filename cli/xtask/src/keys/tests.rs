use std::collections::BTreeMap;

use super::Keys;

fn keys(scripts: &[(&str, &str)]) -> Keys {
    let map: BTreeMap<String, String> = scripts
        .iter()
        .map(|(n, b)| ((*n).to_owned(), (*b).to_owned()))
        .collect();
    Keys::new(&map).unwrap()
}

fn of(k: &Keys, text: &str) -> Vec<String> {
    k.of(text).into_iter().collect()
}

#[test]
fn names_npm_scripts_node_files_recipes_xtasks_and_known_commands() {
    let k = keys(&[]);
    assert_eq!(
        of(
            &k,
            "npm ci && npm run --silent check:x && npm test && node integrations/shared/check-a.mjs --flag"
        ),
        [
            "cmd:npm ci",
            "file:integrations/shared/check-a.mjs",
            "script:check:x",
            "script:test"
        ]
    );
    assert_eq!(
        of(&k, "just gate --base x; cd cli && cargo xtask gate-steps"),
        ["cmd:cargo", "recipe:gate", "xtask:gate-steps"]
    );
    assert_eq!(
        of(
            &k,
            "npx --yes @anthropic-ai/claude-code plugin validate . --strict"
        ),
        ["cmd:plugin validate . --strict"]
    );
    assert_eq!(
        of(&k, "semgrep scan; npm audit --omit=dev"),
        ["cmd:npm audit", "cmd:semgrep"]
    );
    assert_eq!(of(&k, "echo nothing"), Vec::<String>::new());
}

#[test]
fn a_script_is_named_by_its_body_the_longest_first_and_each_match_removed() {
    let k = keys(&[
        ("dead", "knip --no-progress"),
        ("dead:production", "knip --no-progress --production"),
        ("empty", ""),
    ]);
    assert_eq!(
        of(&k, "knip --no-progress --production"),
        ["script:dead:production"]
    );
    assert_eq!(of(&k, "knip --no-progress"), ["script:dead"]);
    assert_eq!(
        of(&k, "knip --no-progress --production; knip --no-progress"),
        ["script:dead", "script:dead:production"]
    );
}

#[test]
fn a_scripts_own_keys_come_from_its_body() {
    let k = keys(&[("check", "node integrations/shared/check-x.mjs")]);
    assert_eq!(
        k.of_script("check").into_iter().collect::<Vec<_>>(),
        ["file:integrations/shared/check-x.mjs", "script:check"]
    );
    assert!(k.of_script("missing").is_empty());
}
