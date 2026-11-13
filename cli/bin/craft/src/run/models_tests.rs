use super::*;

fn name() -> Regex {
    Regex::new(r"^[\w.:/@*-]{1,120}$").unwrap()
}

#[test]
fn one_name_maps_every_tier_and_pairs_map_theirs() {
    assert!(model_table("", &name()).unwrap().is_empty());
    let all = model_table("openai-codex/gpt-6-luna", &name()).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all["haiku"], "openai-codex/gpt-6-luna");
    let some = model_table("opus=big, haiku=small", &name()).unwrap();
    assert_eq!(
        some.into_iter().collect::<Vec<_>>(),
        [
            ("haiku".into(), "small".into()),
            ("opus".into(), "big".into())
        ]
    );
}

#[test]
fn thinking_follows_the_tier_unless_a_level_or_pairs_override_it() {
    let default = thinking_table("").unwrap();
    assert_eq!(
        default.into_iter().collect::<Vec<_>>(),
        [
            ("haiku".into(), "low".into()),
            ("opus".into(), "high".into()),
            ("sonnet".into(), "medium".into())
        ]
    );
    let all = thinking_table("xhigh").unwrap();
    assert!(all.values().all(|l| l == "xhigh"));
    let some = thinking_table("haiku=off, sonnet=max").unwrap();
    assert_eq!(some["opus"], "high", "a tier not named keeps its default");
    assert_eq!(some["sonnet"], "max");
    assert_eq!(some["haiku"], "off");
}

#[test]
fn an_unknown_thinking_level_is_refused() {
    let why = thinking_table("huge").unwrap_err();
    assert!(why.contains("--thinking \"huge\""), "{why}");
    thinking_table("opus=huge").unwrap_err();
    thinking_table("giant=high").unwrap_err();
    thinking_table("opus=").unwrap_err();
}

#[test]
fn a_model_carries_a_level_only_when_its_suffix_is_one() {
    assert!(carries_level("anthropic/claude-x:high"));
    assert!(!carries_level("ollama/llama3:8b"));
    assert!(!carries_level("openai-codex/gpt-6-luna"));
}

#[test]
fn a_bad_table_is_refused() {
    model_table("bad name", &name()).unwrap_err();
    model_table("giant=x", &name()).unwrap_err();
    model_table("opus=", &name()).unwrap_err();
}
