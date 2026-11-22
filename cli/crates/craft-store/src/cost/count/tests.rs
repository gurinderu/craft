use super::*;

fn line(id: Option<&str>, out: f64) -> String {
    let id = id.map_or(String::new(), |i| format!("\"id\":\"{i}\","));
    format!(
        "{{\"type\":\"assistant\",\"message\":{{{id}\"usage\":{{\"input_tokens\":2,\"output_tokens\":{out},\"cache_creation_input_tokens\":10,\"cache_read_input_tokens\":1000}}}}}}"
    )
}

fn sums(t: Tokens) -> [f64; 4] {
    [t.output, t.input, t.cache_read, t.cache_write]
}

#[test]
fn the_lines_of_one_message_count_once_at_their_largest() {
    let text = [
        line(Some("a"), 1.0),
        line(Some("b"), 3.0),
        line(Some("a"), 7.0),
    ]
    .join("\n");
    let (t, unkeyed) = count_usage(&text);
    assert_eq!(sums(t), [10.0, 4.0, 2000.0, 20.0]);
    assert_eq!(unkeyed, 0);
}

#[test]
fn a_line_with_no_message_id_counts_alone() {
    let text = [line(None, 1.0), line(None, 1.0)].join("\n");
    let (t, unkeyed) = count_usage(&text);
    assert_eq!(sums(t), [2.0, 4.0, 2000.0, 20.0]);
    assert_eq!(unkeyed, 2);
}
