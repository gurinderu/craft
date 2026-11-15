//! A workflow's triggers, as the CI map needs them (realm @nick/craft, node #482): whether its one
//! trigger is `workflow_call`, so that it runs only when another workflow calls it. Read from its
//! `on:` — an event name, a `[…]` list, or a block of events — by the line reader `workflow` is.

use super::workflow::{indent, meaningful, unquote};

const CALL: &str = "workflow_call";

/// The value after a top-level `on:` key (quoted or not), when `l` is one.
fn on_key(l: &str) -> Option<&str> {
    if indent(l) > 0 {
        return None;
    }
    ["on:", "\"on\":", "'on':"]
        .iter()
        .find_map(|k| l.strip_prefix(k))
}

/// An event name: past a list item's `- `, before a `:`, unquoted.
fn event(t: &str) -> String {
    let t = t.trim();
    let t = t.strip_prefix("- ").map_or(t, str::trim_start);
    unquote(t.split_once(':').map_or(t, |(k, _)| k).trim()).to_owned()
}

/// The events of a workflow's `on:`: an inline name or `[…]` list, or the keys (or items) of its
/// block.
fn triggers(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let Some((i, value)) = lines
        .iter()
        .enumerate()
        .find_map(|(i, l)| on_key(l).map(|v| (i, v)))
    else {
        return Vec::new();
    };
    let v = value.split(" #").next().unwrap_or(value).trim();
    if !v.is_empty() {
        let v = v
            .strip_prefix('[')
            .and_then(|r| r.strip_suffix(']'))
            .unwrap_or(v);
        return v.split(',').map(event).filter(|e| !e.is_empty()).collect();
    }
    let body: Vec<&str> = lines
        .iter()
        .skip(i + 1)
        .filter(|l| meaningful(l))
        .take_while(|l| indent(l) > 0)
        .copied()
        .collect();
    let at = body.first().map_or(0, |l| indent(l));
    body.iter()
        .filter(|l| indent(l) == at)
        .map(|l| event(l))
        .collect()
}

/// Whether the workflow `text` runs only when another workflow calls it.
pub(super) fn called_only(text: &str) -> bool {
    let t = triggers(text);
    !t.is_empty() && t.iter().all(|e| e == CALL)
}
