use serde_json::json;

use super::{Input, read};

const OPENED: &str =
    "Creating pull request for feat/x into main in o/r\n\nhttps://github.com/o/r/pull/7\n";

fn bash(command: &str, response: &serde_json::Value) -> String {
    json!({"cwd": "/w", "hook_event_name": "PostToolUse", "tool_name": "Bash",
        "tool_input": {"command": command}, "tool_response": response})
    .to_string()
}

fn opened(input: &str) -> (String, Option<String>) {
    match read(input) {
        Input::Opened { url, cwd } => (url, cwd.map(|c| c.display().to_string())),
        other @ (Input::Silent | Input::Unreadable(_)) => panic!("expected a PR, got {other:?}"),
    }
}

#[test]
fn a_pr_url_after_pr_create_is_a_pr_opened() {
    let out = json!({"stdout": OPENED, "stderr": "", "interrupted": false});
    assert_eq!(
        opened(&bash("gh pr create --fill", &out)),
        ("https://github.com/o/r/pull/7".into(), Some("/w".into()))
    );
    for command in ["rtk gh pr new -t x", "cd a && gh pr create"] {
        assert_eq!(
            opened(&bash(command, &out)).0,
            "https://github.com/o/r/pull/7"
        );
    }
    let enterprise =
        json!({"stdout": "", "stderr": "see https://git.example.com/g/s.r-1/pull/42."});
    assert_eq!(
        opened(&bash("gh pr create", &enterprise)).0,
        "https://git.example.com/g/s.r-1/pull/42"
    );
    let text = json!("warning\nhttps://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/9\n");
    assert_eq!(
        opened(&bash("gh pr create", &text)).0,
        "https://github.com/o/r/pull/9",
        "the last one gh printed"
    );
}

#[test]
fn every_other_bash_result_is_silent() {
    let out = json!({"stdout": OPENED, "stderr": ""});
    let silent = [
        bash("git status", &out),
        bash("gh pr view 7", &out),
        bash("gh pr create", &json!({"stdout": "aborted\n", "stderr": ""})),
        bash(
            "gh pr create",
            &json!({"stdout": "https://github.com/o/r/issues/7 https://github.com/o/r/pull/x https://github.com/o/pull/7", "stderr": ""}),
        ),
        bash("gh pr create", &json!(null)),
        json!({"tool_name": "Write", "tool_input": {"command": "gh pr create"}, "tool_response": out}).to_string(),
        json!({"tool_name": "Bash", "tool_response": out}).to_string(),
        "{not json".into(),
        String::new(),
    ];
    for input in silent {
        assert!(matches!(read(&input), Input::Silent), "{input}");
    }
}

#[test]
fn input_that_is_not_json_but_names_a_pull_is_unreadable() {
    assert!(matches!(
        read("{\"tool_name\": \"Bash\", https://github.com/o/r/pull/7"),
        Input::Unreadable(_)
    ));
}
