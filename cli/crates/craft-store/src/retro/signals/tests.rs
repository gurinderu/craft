use super::*;
use crate::js::parse;

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn savings_harm_cap_and_uncovered_files_are_counted_once_per_run() {
    let mut s = Signals::default();
    s.add(&rec(r#"{"savedByFloor":["a","a"],"savedByFloorPremiseHeld":false,"harmCap":{"lowered":3},"uncoveredFiles":["x","x","",1]}"#)).unwrap();
    s.add(&rec(
        r#"{"savedByFloorPremiseHeld":true,"harmCap":{},"uncoveredFiles":[]}"#,
    ))
    .unwrap();
    assert_eq!(s.saved.get("a"), Some(&2));
    assert_eq!((s.revoked_runs, s.harm_runs, s.harm_lowered), (1, 1, 3.0));
    assert_eq!(s.uncovered_runs, 1);
    assert_eq!(
        (s.uncovered.get("x"), s.uncovered.get("1")),
        (Some(&1), Some(&1))
    );
}

#[test]
fn an_unavailable_agent_reads_from_either_shape_the_engines_wrote() {
    let mut s = Signals::default();
    s.add(&rec(r#"{"agentUnavailable":["a","a"],"agentFallbacks":{"a":2,"b":0,"c":"3"},"reviewerAgentUnavailable":["x"]}"#)).unwrap();
    s.add(&rec(
        r#"{"reviewerAgentUnavailable":["nix"],"reviewerAgentFallbacks":{"nix":4}}"#,
    ))
    .unwrap();
    s.add(&rec(
        r#"{"agentFallbacks":null,"reviewerAgentUnavailable":["y"]}"#,
    ))
    .unwrap();
    assert_eq!(s.unavailable.get("a"), Some(&1));
    assert_eq!(s.unavailable.get("craft:nix-reviewer"), Some(&1));
    assert!(
        !s.unavailable.contains_key("craft:x-reviewer")
            && !s.unavailable.contains_key("craft:y-reviewer")
    );
    assert_eq!(s.fallbacks.get("a"), Some(&(2.0, 1)));
    assert_eq!(s.fallbacks.get("craft:nix-reviewer"), Some(&(4.0, 1)));
    assert!(!s.fallbacks.contains_key("b") && !s.fallbacks.contains_key("c"));
}
