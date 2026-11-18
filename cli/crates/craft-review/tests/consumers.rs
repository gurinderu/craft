//! `craft review start` builds the consumers list of a change with a caller: the whole list saved
//! in the run directory, the lenses handed their part.

mod common;

use common::{git, ids, opts, prompt_of, scout, submit};
use craft_review::step;
use serde_json::{Value, json};

#[test]
fn start_saves_the_list_and_hands_the_lenses_its_lines() {
    let repo = tempfile::tempdir().unwrap();
    let d = repo.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn shared_target() -> u8 {\n    1\n}\n",
    )
    .unwrap();
    let user = "pub fn user() -> u8 {\n    crate::shared_target()\n}\n";
    std::fs::write(d.join("src/user.rs"), user).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn shared_target() -> u8 {\n    2\n}\n",
    )
    .unwrap();
    git(d, &["commit", "-qam", "fix: return 2"]);

    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(d, out.path())).unwrap();
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("consumers.json")).unwrap())
            .unwrap();
    assert_eq!(saved["symbols"][0]["name"], json!("shared_target"));
    assert_eq!(
        saved["symbols"][0]["sites"][0]["file"],
        json!("src/user.rs")
    );

    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    let task = s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!("lens-rust-errors-r1"))
        .unwrap_or_else(|| panic!("{:?}", ids(&s)));
    let prompt = prompt_of(task);
    assert!(prompt.contains("CONSUMERS (required)"), "{prompt}");
    assert!(
        prompt.contains("- src/user.rs:2: crate::shared_target()"),
        "{prompt}"
    );
}
