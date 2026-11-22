use super::{discover, put};
use serde_json::json;

#[test]
fn coverage_is_loose_and_keeps_self_image_without_guessed_repo() {
    let root = tempfile::tempdir().unwrap();
    put(
        root.path(),
        "values.yaml",
        "image: ghcr.io/acme/app:v1\nimage: postgres:16\nimage: containers.example/snapshot/my-app:main\n",
    );
    let known = json!([
        {"kind":null,"status":false,"repo":"ssh://git@GitHub.com:22/ACME//app.git","version":"bad"},
        {"system":"POSTGRES","version":"-invalid","kind":"external"},
        {"system":"my-app","version":"v1","status":"withdrawn"}
    ]);
    let got = discover(root.path(), None, known);
    assert_eq!(got["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(got["candidates"][0]["system"], "my-app");
    assert_eq!(got["candidates"][0]["version"], "main");
    let got = discover(
        root.path(),
        None,
        json!([{"system":"postgres","versionFrom":"values.yaml"}]),
    );
    assert_eq!(got["candidates"].as_array().unwrap().len(), 2);
}

#[test]
fn explicit_order_duplicates_later_unread_and_more_survive_candidate_cap() {
    let root = tempfile::tempdir().unwrap();
    let values: String = (0..65).map(|i| format!("image: x/s{i}:v1\n")).collect();
    put(root.path(), "values.yaml", values);
    let got = discover(
        root.path(),
        Some(&["values.yaml", "values.yaml", "missing"]),
        json!([]),
    );
    assert_eq!(got["candidates"].as_array().unwrap().len(), 64);
    assert_eq!(got["more"], 66);
    assert_eq!(
        got["unread"],
        json!([{"file":"missing","error":"manifest missing not found"}])
    );
    for name in ["A", "z"] {
        put(
            root.path(),
            &format!("{name}/values.yaml"),
            format!("image: x/{name}:v1\n"),
        );
    }
    let got = discover(
        root.path(),
        Some(&["z/values.yaml", "A/values.yaml", "z/values.yaml"]),
        json!([]),
    );
    assert_eq!(
        got["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["system"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["z", "A", "z"]
    );
}

#[test]
fn utf16_order_controls_the_real_64_candidate_boundary() {
    let root = tempfile::tempdir().unwrap();
    let values: String = (0..63).map(|i| format!("image: x/s{i}:v1\n")).collect();
    put(root.path(), "A/values.yaml", values);
    put(root.path(), "Z/values.yaml", "image: x/upper:v1\n");
    put(root.path(), "b/values.yaml", "image: x/lower:v1\n");
    let got = discover(root.path(), None, json!([]));
    assert_eq!(got["candidates"][63]["system"], "upper");
    assert_eq!(got["more"], 1);
}

#[test]
fn utf16_order_and_skipped_entries_control_the_real_walk_boundary() {
    let root = tempfile::tempdir().unwrap();
    // 99,997 skipped entries count, then Z and its manifest reach 99,999.
    for i in 0..99_997 {
        std::fs::write(root.path().join(format!(".skip{i:05}")), "").unwrap();
    }
    put(root.path(), "Z/values.yaml", "image: x/upper:v1\n");
    put(root.path(), "a/values.yaml", "image: x/lower:v1\n");
    let got = discover(root.path(), None, json!([]));
    assert_eq!(got["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(got["candidates"][0]["system"], "upper");
    assert!(
        got["walkCut"]
            .as_str()
            .unwrap()
            .contains("100000 directory entries")
    );
    assert_eq!(got["more"], 0);
}

#[test]
fn full_walk_skips_named_directories_and_regular_file_root_is_empty() {
    let root = tempfile::tempdir().unwrap();
    for dir in [".hidden", "node_modules", "vendor", "target"] {
        put(
            root.path(),
            &format!("{dir}/values.yaml"),
            "image: x/hidden:v1\n",
        );
    }
    put(root.path(), "values.yaml", "image: x/visible:v1\n");
    assert_eq!(
        discover(root.path(), None, json!([]))["candidates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        discover(&root.path().join("values.yaml"), None, json!([])),
        json!({"candidates":[],"more":0,"unread":[]})
    );
}
