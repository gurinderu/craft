//! What a task's model token means to a host CLI (realm @nick/craft, node #465): the binary names
//! Claude tiers; the host runs its own configured model unless a table maps a tier to one of its
//! models — one name for every tier, or `tier=model` pairs joined by commas. pi's thinking level
//! is a table of the same shape, with a default for each tier (realm `@nick/craft`, node #518).

use std::collections::BTreeMap;

use regex::Regex;

/// The tiers a task may name (`craft_review::agent::Model`).
const TIERS: [&str; 3] = ["opus", "sonnet", "haiku"];

/// pi's thinking levels (observed `pi --help`).
const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// The thinking level a pi task runs at by its tier, unless the run names others (realm
/// `@nick/craft`, node #518).
const THINKING: [(&str, &str); 3] = [("opus", "high"), ("sonnet", "medium"), ("haiku", "low")];

/// A host model for each tier mapped; a tier not in it runs on the host's own.
pub(crate) type ModelTable = BTreeMap<String, String>;

/// pi's thinking level for each tier.
pub(crate) type ThinkingTable = BTreeMap<String, String>;

/// The table from its text, "" none; or why it cannot be used. `name` is a model name the host
/// takes.
pub(crate) fn model_table(text: &str, name: &Regex) -> Result<ModelTable, String> {
    tier_table(text, ("--models", "a model name", "model"), &|m| {
        name.is_match(m)
    })
}

/// The thinking level of each tier: craft's default for a tier `text` does not name — one level
/// for every tier, or `tier=level` pairs joined by commas; or why it cannot be used.
pub(crate) fn thinking_table(text: &str) -> Result<ThinkingTable, String> {
    let mut table: ThinkingTable = THINKING
        .iter()
        .map(|(t, l)| ((*t).to_owned(), (*l).to_owned()))
        .collect();
    let what = format!("a thinking level ({})", LEVELS.join(", "));
    table.extend(tier_table(text, ("--thinking", &what, "level"), &|l| {
        LEVELS.contains(&l)
    })?);
    Ok(table)
}

/// Whether `model` names its own thinking level, as pi's `<model>:<level>`.
pub(crate) fn carries_level(model: &str) -> bool {
    model
        .rsplit_once(':')
        .is_some_and(|(_, level)| LEVELS.contains(&level))
}

/// A value for each tier from `text`, "" none: one value for every tier, or `tier=value` pairs
/// joined by commas; `flag`, the value's noun and its placeholder name it in a refusal.
fn tier_table(
    text: &str,
    (flag, noun, slot): (&str, &str, &str),
    valid: &dyn Fn(&str) -> bool,
) -> Result<BTreeMap<String, String>, String> {
    let spec = text.trim();
    if spec.is_empty() {
        return Ok(BTreeMap::new());
    }
    if !spec.contains('=') {
        return if valid(spec) {
            Ok(TIERS
                .iter()
                .map(|t| ((*t).to_owned(), spec.to_owned()))
                .collect())
        } else {
            Err(format!("{flag} {text:?} is not {noun}"))
        };
    }
    spec.split(',')
        .map(|pair| match pair.split_once('=') {
            Some((tier, value)) if TIERS.contains(&tier.trim()) && valid(value.trim()) => {
                Ok((tier.trim().to_owned(), value.trim().to_owned()))
            }
            _ => Err(format!(
                "{flag} {text:?}: {pair:?} is not <opus|sonnet|haiku>=<{slot}>"
            )),
        })
        .collect()
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;
