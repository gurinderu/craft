//! `craft pr rejections`: a PR's threads asked of gh — a stand-in that answers only a query asking
//! whether the PR is a fork's — or read from a saved answer.

use serde_json::{Value, json};

use super::support::{craft, gh, text};

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/pr-rejections-cases.json"
));

fn case(name: &str) -> Value {
    let file: Value = serde_json::from_str(CASES).unwrap();
    file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == json!(name))
        .unwrap()
        .clone()
}

#[test]
fn a_prs_threads_are_asked_of_gh_and_printed_as_the_javascript_reader_printed_them() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, answer) = (dir.path().join("bin"), dir.path().join("answer.json"));
    let c = case("slurped pages");
    std::fs::write(&answer, c["answer"].to_string()).unwrap();
    gh(
        &bin,
        &format!(
            "case \"$1 $2\" in\n  \"repo view\") echo '{{\"owner\":{{\"login\":\"o\"}},\"name\":\"r\"}}' ;;\n  \"pr view\") echo '{{\"number\":9}}' ;;\n  \"api graphql\") case \"$*\" in *isCrossRepository*) cat '{}' ;; *) echo 'the query asks no isCrossRepository' >&2; exit 4 ;; esac ;;\n  *) exit 3 ;;\nesac",
            answer.display()
        ),
    );
    let out = craft(dir.path(), &bin, &["pr", "rejections"], "");
    assert!(out.status.success(), "{}", text(&out.stderr));
    let printed: Value = serde_json::from_str(&text(&out.stdout)).unwrap();
    assert_eq!(printed, c["expected"]);
    assert!(text(&out.stdout).starts_with("{\n  \"decisions\": ["));
    let calls = std::fs::read_to_string(bin.join("calls")).unwrap();
    assert!(
        calls.contains("pr view --repo o/r --json number"),
        "{calls}"
    );
    assert!(
        calls.contains("api graphql --paginate --slurp -f query=query($owner:String!"),
        "{calls}"
    );
    assert!(calls.contains("-f owner=o -f name=r -F pr=9"), "{calls}");
}

#[test]
fn a_saved_answer_is_read_from_stdin_and_an_unreadable_one_exits_2() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    gh(&bin, "exit 3");
    let c = case("a rejection reply records a decision");
    let out = craft(
        dir.path(),
        &bin,
        &["pr", "rejections", "--threads", "-"],
        &c["answer"].to_string(),
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        serde_json::from_str::<Value>(&text(&out.stdout)).unwrap(),
        c["expected"]
    );
    let bad = craft(
        dir.path(),
        &bin,
        &["pr", "rejections", "--threads", "-"],
        "{\"data\":{}}",
    );
    assert_eq!(bad.status.code(), Some(2));
    assert!(
        text(&bad.stderr).contains("not a reviewThreads answer"),
        "{}",
        text(&bad.stderr)
    );
    assert!(
        !bin.join("calls").exists(),
        "gh never asked for a saved answer"
    );
    let unauthenticated = craft(
        dir.path(),
        &bin,
        &["pr", "rejections", "--pr", "3", "--repo", "o/r"],
        "",
    );
    assert_eq!(
        unauthenticated.status.code(),
        Some(2),
        "{}",
        text(&unauthenticated.stderr)
    );
}

#[test]
fn a_named_pr_and_repository_reach_gh_the_names_as_strings() {
    let dir = tempfile::tempdir().unwrap();
    let (bin, answer) = (dir.path().join("bin"), dir.path().join("answer.json"));
    let c = case("a rejection reply records a decision");
    std::fs::write(&answer, c["answer"].to_string()).unwrap();
    gh(
        &bin,
        &format!(
            "case \"$1 $2\" in\n  \"api graphql\") case \"$*\" in *isCrossRepository*) cat '{}' ;; *) echo 'the query asks no isCrossRepository' >&2; exit 4 ;; esac ;;\n  *) exit 3 ;;\nesac",
            answer.display()
        ),
    );
    let args = ["pr", "rejections", "--pr", "3", "--repo", "2048/4096"];
    let out = craft(dir.path(), &bin, &args, "");
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        serde_json::from_str::<Value>(&text(&out.stdout)).unwrap(),
        c["expected"]
    );
    let calls = std::fs::read_to_string(bin.join("calls")).unwrap();
    assert!(
        calls.contains("-f owner=2048 -f name=4096 -F pr=3"),
        "{calls}"
    );
    assert!(
        !calls.contains("repo view") && !calls.contains("pr view"),
        "neither the repository nor the PR asked: {calls}"
    );
}
