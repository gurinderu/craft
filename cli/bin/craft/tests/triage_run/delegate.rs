use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;

use serde_json::{Value, json};

use super::fixture::{Bench, read};

#[test]
fn delegated_tasks_use_the_same_answer_loop_and_never_spawn_the_host() {
    let b = Bench::new();
    let mut child = b
        .delegated("opencode", "ok")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let events = BufReader::new(child.stderr.take().unwrap());
    let mut tasks = Vec::new();
    let mut result = Value::Null;
    for line in events.lines() {
        let line = line.unwrap();
        let event: Value = serde_json::from_str(&line).unwrap();
        assert!(
            result.is_null(),
            "the result is the last event: after it came {line:?}"
        );
        if event["type"] == "triage_result" {
            result = event.clone();
        }
        if event["type"] != "task" {
            continue;
        }
        assert_eq!(event["cwd"], json!(b.path("repo")));
        assert_eq!(event["agent"], "review-task");
        let id = event["id"].as_str().unwrap();
        let answer = if id == "plan" {
            json!({"plan_markdown":"body", "summary":"delegated", "ledger":[]})
        } else {
            json!({"source":"review","findings":[]})
        };
        writeln!(
            input,
            "{}",
            json!({"key":event["key"],"text":format!("```craft-answer\n{answer}\n```")})
        )
        .unwrap();
        input.flush().unwrap();
        tasks.push(id.to_owned());
    }
    drop(input);
    let out = child.wait_with_output().unwrap();
    b.expect(&out, 0);
    assert_eq!(tasks, ["gather-report", "plan"]);
    assert_eq!(result["exit_code"], 0);
    assert_eq!(result["summary"], "delegated");
    assert!(b.calls().is_empty());
    assert_eq!(read(&b.path("run/record.json"))["runtime"], "opencode");
}
