use serde_json::json;

use super::support::{Store, row};

#[test]
fn executable_counts_group_and_title_omissions_at_adjacent_boundaries() {
    for count in [19_usize, 20, 21] {
        let s = Store::new();
        let rows: Vec<_> = (0..count)
            .map(|i| row(&format!("f{i:02}"), "same"))
            .collect();
        s.record("a", "a", json!(rows));
        s.record("b", "b", json!(rows));
        s.record("c", "c", json!([row("f18", "same")]));
        let out = s.read(&[]);
        assert_eq!(out["groups"].as_array().unwrap().len(), count.min(20));
        assert_eq!(out["groupsCut"], count.saturating_sub(20));
        assert_eq!(out["groups"][0]["file"], "f18");
        assert_eq!(
            out["note"]
                .as_str()
                .unwrap()
                .contains("1 more recurring group(s) past the bound of 20 not listed"),
            count == 21
        );
    }
    for count in [4_usize, 5, 6] {
        let s = Store::new();
        for i in 0..count {
            s.record(
                &format!("r{i}"),
                &format!("b{i}"),
                json!([row("f", &format!("a b c d e v{i}"))]),
            );
        }
        let out = s.read(&[]);
        let group = &out["groups"][0];
        assert_eq!(group["titles"].as_array().unwrap().len(), count.min(5));
        assert_eq!(group["titlesMore"], count.saturating_sub(5));
        assert_eq!(group["titles"][0], format!("a b c d e v{}", count - 1));
        assert_eq!(group["branches"].as_array().unwrap().len(), count);
    }
}

#[test]
fn newest_filename_order_is_utf16_and_can_change_directional_scope_grouping() {
    let s = Store::new();
    // UTF-16 reads U+E000 before the astral character; UTF-8 byte order would do the reverse.
    s.record("\u{e000}", "a", json!([row("src", "a b c d e")]));
    s.record("😀", "b", json!([row("src/a", "a b c x y")]));
    let out = s.read(&[]);
    assert_eq!(out["groups"].as_array().unwrap().len(), 1);
    assert_eq!(out["groups"][0]["file"], "src");
    assert_eq!(
        out["groups"][0]["runs"],
        json!(["😀.json", "\u{e000}.json"])
    );
    assert_eq!(out["groups"][0]["lastSeen"], "\u{e000}");
}
