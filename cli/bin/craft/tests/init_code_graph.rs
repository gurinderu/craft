//! `craft init` and the code graph (realm @nick/craft, node #529): `--write` asks
//! `codebase-memory-mcp` whether it answers and which project indexes the repository, writes that
//! as the profile's `[code_graph]`, and says so; a graph that is missing or fails is said to be
//! not available, and init still succeeds. A stand-in program on a PATH of the test's own.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod graph_init;

use graph_init::{indexing, init, repo, stub};

#[test]
fn init_writes_the_code_graph_that_answers_for_the_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let bin = indexing(t, &repo);
    let (v, profile) = init(t, &bin, &repo, "--write");
    assert_eq!(v["codeGraph"]["project"], "mine");
    assert!(
        v["codeGraphSays"]
            .as_str()
            .unwrap()
            .contains("indexes this repository as mine")
    );
    assert!(profile.contains("[code_graph]"), "{profile}");
    assert!(
        profile.contains("tool = \"codebase-memory-mcp\""),
        "{profile}"
    );
    assert!(profile.contains("state = \"indexed\""), "{profile}");
    assert!(profile.contains("project = \"mine\""), "{profile}");
}

#[test]
fn init_says_a_failing_code_graph_is_not_available_and_still_writes() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let bin = stub(t, "#!/bin/sh\necho 'database locked' >&2\nexit 3\n");
    let (v, profile) = init(t, &bin, &repo, "--write");
    let says = v["codeGraphSays"].as_str().unwrap();
    assert!(
        says.contains("is not available (list_projects: database locked)"),
        "{says}"
    );
    assert!(says.contains("name search alone"), "{says}");
    assert!(profile.contains("state = \"unavailable\""), "{profile}");
}
