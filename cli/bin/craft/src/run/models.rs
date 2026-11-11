//! What a task's model token means to a host CLI (realm @nick/craft, node #465): the binary names
//! Claude tiers; the host runs its own configured model unless a table maps a tier to one of its
//! models — one name for every tier, or `tier=model` pairs joined by commas.

use std::collections::BTreeMap;

use regex::Regex;

/// The tiers a task may name (`craft_review::agent::Model`).
const TIERS: [&str; 3] = ["opus", "sonnet", "haiku"];

/// A host model for each tier mapped; a tier not in it runs on the host's own.
pub(crate) type ModelTable = BTreeMap<String, String>;

/// The table from its text, "" none; or why it cannot be used. `name` is a model name the host
/// takes.
pub(crate) fn model_table(text: &str, name: &Regex) -> Result<ModelTable, String> {
    let spec = text.trim();
    if spec.is_empty() {
        return Ok(ModelTable::new());
    }
    if !spec.contains('=') {
        return if name.is_match(spec) {
            Ok(TIERS
                .iter()
                .map(|t| ((*t).to_owned(), spec.to_owned()))
                .collect())
        } else {
            Err(format!("--models {text:?} is not a model name"))
        };
    }
    spec.split(',')
        .map(|pair| match pair.split_once('=') {
            Some((tier, model)) if TIERS.contains(&tier.trim()) && name.is_match(model.trim()) => {
                Ok((tier.trim().to_owned(), model.trim().to_owned()))
            }
            _ => Err(format!(
                "--models {text:?}: {pair:?} is not <opus|sonnet|haiku>=<model>"
            )),
        })
        .collect()
}

#[cfg(test)]
mod tests {
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
    fn a_bad_table_is_refused() {
        model_table("bad name", &name()).unwrap_err();
        model_table("giant=x", &name()).unwrap_err();
        model_table("opus=", &name()).unwrap_err();
    }
}
