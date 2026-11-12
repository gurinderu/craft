//! A pi task's answer, read from what `pi -p` printed: the agent has no write tool, so it prints
//! its answer as one JSON object in a fence of its own, opened with ```` ```craft-answer ````.
//!
//! The object in the last such block is the answer: an example printed after it, in a `json`
//! fence or bare, is not. The object is found by its balanced braces, strings skipped, so a
//! ```` ``` ```` inside a JSON string closes nothing. Without such a block, the answer is the last object in
//! the output that parses, fenced or bare — so an example printed in a `json` fence before the
//! answer does not win over it. Nothing more is checked here: the binary validates the answer
//! against its schema and hands a bad one back for a retry.

use serde_json::{Map, Value};

/// The fence the answer is printed in.
const OPENER: &str = "```craft-answer";

/// The answer in what pi printed, `None` when there is none.
#[must_use]
pub fn answer_of(out: &str) -> Option<Map<String, Value>> {
    fenced(out).or_else(|| last_object(out))
}

/// The object in the last `craft-answer` block that holds one.
fn fenced(out: &str) -> Option<Map<String, Value>> {
    let mut found = None;
    for (at, _) in out.match_indices(OPENER) {
        let line_start = at == 0 || out.get(..at).is_some_and(|b| b.ends_with('\n'));
        let Some(rest) = out.get(at + OPENER.len()..) else {
            continue;
        };
        // The opener is a line of its own: only blanks may follow it on the line.
        let Some((tail, body)) = rest.split_once('\n') else {
            continue;
        };
        if !line_start || !tail.trim().is_empty() {
            continue;
        }
        let trimmed = body.trim_start();
        if !trimmed.starts_with('{') {
            continue;
        }
        if let Some(end) = close_of(trimmed)
            && let Some(obj) = trimmed.get(..=end).and_then(object_of)
        {
            found = Some(obj);
        }
    }
    found
}

/// The last object in `out` that parses: each `{` tried in turn, and one that parses passed over
/// whole, so an object inside it is not taken for another.
fn last_object(out: &str) -> Option<Map<String, Value>> {
    let mut found = None;
    let mut i = 0;
    while let Some(off) = out.get(i..).and_then(|s| s.find('{')) {
        let start = i + off;
        let from = out.get(start..).unwrap_or_default();
        match close_of(from).and_then(|end| from.get(..=end).and_then(object_of).map(|o| (end, o)))
        {
            Some((end, obj)) => {
                found = Some(obj);
                i = start + end + 1;
            }
            None => i = start + 1,
        }
    }
    found
}

/// Where the balanced `{…}` that opens `s` closes, strings skipped; `None` when it never does.
fn close_of(s: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// The text as a JSON object, `None` when it is not one.
fn object_of(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str(text) {
        Ok(Value::Object(o)) => Some(o),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn got(out: &str) -> Option<Value> {
        answer_of(out).map(Value::Object)
    }

    #[test]
    fn the_craft_answer_block_wins_over_an_example_printed_after_it() {
        let out = "Answer:\n```craft-answer\n{\"findings\": [{\"t\": \"real\"}]}\n```\nFor example:\n```json\n{\"findings\": []}\n```";
        assert_eq!(got(out), Some(json!({"findings": [{"t": "real"}]})));
    }

    #[test]
    fn a_fence_inside_a_json_string_does_not_cut_the_block() {
        // Pretty-printed by the agent, a string holding a fence and an escaped newline.
        let out =
            "```craft-answer\n{\n  \"code\": \"```rust\\nfn a() {}\\n```\",\n  \"k\": 1\n}\n```\n";
        assert_eq!(
            got(out),
            Some(json!({"code": "```rust\nfn a() {}\n```", "k": 1}))
        );
        let out = "In `fn run() {` I saw:\n```json\n{\"a\": \"x ``` y\"}\n```\n";
        assert_eq!(got(out), Some(json!({"a": "x ``` y"})));
    }

    #[test]
    fn a_prior_example_block_does_not_win_over_the_answer_printed_after_it() {
        let out = "The schema looks like:\n```json\n{\"findings\": []}\n```\nMy answer: {\"findings\": [{\"t\": \"real\"}]}";
        assert_eq!(got(out), Some(json!({"findings": [{"t": "real"}]})));
        let out = "First:\n```json\n{\"a\": 1}\n```\nThen:\n```json\n{\"a\": 2, \"s\": \"}{\"}\n```\nDone.";
        assert_eq!(got(out), Some(json!({"a": 2, "s": "}{"})));
    }

    #[test]
    fn without_a_fence_the_last_object_that_parses_braces_in_prose_and_strings_skipped() {
        let out = r#"I saw {the diff}. {"x": "a \" } b", "y": {"z": [1]}} and {broken"#;
        assert_eq!(got(out), Some(json!({"x": "a \" } b", "y": {"z": [1]}})));
        assert_eq!(
            got("fn run() { … and then {\"k\": 1}"),
            Some(json!({"k": 1}))
        );
        assert_eq!(
            got("```json\n[1, 2]\n```\n{\"k\": true}"),
            Some(json!({"k": true}))
        );
    }

    #[test]
    fn an_opener_not_at_a_line_start_or_with_no_object_is_no_block() {
        let out = "say ```craft-answer\n{\"a\": 1}\n```\n```craft-answer\nnone\n```\n{\"b\": 2}";
        assert_eq!(got(out), Some(json!({"b": 2})));
    }

    #[test]
    fn no_object_at_all_is_no_answer() {
        assert_eq!(got("done"), None);
        assert_eq!(got("{\"unclosed\": 1"), None);
    }
}
