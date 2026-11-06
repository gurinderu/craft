use super::*;
use serde_json::{Value, json};

const REAL: &str = include_str!("../../tests/fixtures/reply-success.json");

fn real_with(edit: impl FnOnce(&mut serde_json::Map<String, Value>)) -> String {
    let mut v: Value = serde_json::from_str(REAL).unwrap();
    edit(v.as_object_mut().unwrap());
    v.to_string()
}

#[test]
fn real_reply_yields_the_shaped_answer_text_usage_and_cost() {
    let r = parse(REAL, true).unwrap();
    assert_eq!(r.structured, Some(json!({"ok": true, "note": "Done."})));
    assert_eq!(r.text.as_deref(), Some(r#"{"ok":true,"note":"Done."}"#));
    assert_eq!(
        r.usage,
        Usage {
            input: 2,
            output: 75,
            cache_read: 0,
            cache_write: 18093
        }
    );
    assert!((r.cost_usd - 0.003_656_3).abs() < 1e-9);
    assert!(r.denials.is_empty());
}

#[test]
fn usage_sums_every_model_over_the_session_usage() {
    let s = real_with(|o| {
        o.insert(
            "modelUsage".into(),
            json!({
                "a": {"inputTokens": 2, "outputTokens": 10, "cacheReadInputTokens": 100, "cacheCreationInputTokens": 50},
                "b": {"inputTokens": 1, "outputTokens": 5}
            }),
        );
    });
    assert_eq!(
        parse(&s, false).unwrap().usage,
        Usage {
            input: 3,
            output: 15,
            cache_read: 100,
            cache_write: 50
        }
    );
}

#[test]
fn session_usage_when_no_model_is_listed() {
    let s = real_with(|o| {
        o.remove("modelUsage");
    });
    assert_eq!(
        parse(&s, false).unwrap().usage,
        Usage {
            input: 2,
            output: 75,
            cache_read: 0,
            cache_write: 18093
        }
    );
}

#[test]
fn a_failed_turn_is_an_error_with_its_subtype() {
    let s = real_with(|o| {
        o.insert("subtype".into(), json!("error_max_turns"));
    });
    assert!(
        matches!(parse(&s, false), Err(AgentError::Failed { subtype }) if subtype == "error_max_turns")
    );
    let s = real_with(|o| {
        o.insert("is_error".into(), json!(true));
    });
    assert!(matches!(parse(&s, false), Err(AgentError::Failed { .. })));
}

#[test]
fn a_schema_without_an_object_answer_is_an_error_but_text_alone_is_fine() {
    let s = real_with(|o| {
        o.insert("structured_output".into(), json!("x"));
    });
    assert!(matches!(
        parse(&s, true),
        Err(AgentError::NoStructuredOutput)
    ));
    assert_eq!(parse(&s, false).unwrap().structured, None);
}

#[test]
fn unreadable_replies_are_errors() {
    for s in ["not json", "null", "[]", ""] {
        assert!(
            matches!(
                parse(s, false),
                Err(AgentError::Unreadable(_) | AgentError::NotAnObject)
            ),
            "{s}"
        );
    }
}

#[test]
fn denials_read_as_tool_and_squashed_detail_cut_short() {
    let long = "x".repeat(200);
    let s = real_with(|o| {
        o.insert(
            "permission_denials".into(),
            json!([
                {"tool_name": "Bash", "tool_input": {"command": "rtk   git\nstatus"}},
                {"tool_name": "Write", "tool_input": {"file_path": "/x"}},
                {"tool_name": "Bash", "tool_input": {"command": long}},
                {}
            ]),
        );
    });
    let d = parse(&s, false).unwrap().denials;
    assert_eq!(d[0], "Bash(rtk git status)");
    assert_eq!(d[1], "Write(/x)");
    assert_eq!(d[2].len(), "Bash()".len() + DENIAL_DETAIL);
    assert_eq!(d[3], "?()");
}
