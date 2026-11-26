//! The `[mutants]` section `craft init` shows and writes as the reviewer confirmed it (realm
//! @nick/craft, nodes #645, #647). Whether cargo-mutants is installed it does not ask: the gate's
//! environment is the review's to know, and its report says whether the mutants ran and why not.

use std::path::Path;

use anyhow::{Result, anyhow};
use craft_review::project::mutants::{self, MutantsSection};
use serde_json::{Value, json};

/// Whether the mutants run on the project, as `--mutants` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Switch {
    On,
    Off,
}

/// What `--propose` says of the section: what the profile holds, the flags a write takes it back
/// by, the default budget a section without one runs for, or why it could not be read.
pub fn proposed(profile: &Path) -> Value {
    let (held, unread) = match mutants::of(profile) {
        Ok(s) => (s, None),
        Err(e) => (MutantsSection::default(), Some(e.to_string())),
    };
    json!({
        "off": held.off,
        "budgetSecs": held.budget_secs,
        "defaultBudgetSecs": craft_review::gate::mutants::BUDGET.as_secs(),
        "flags": flags(&held),
        "unread": unread,
    })
}

/// The section `--mutants` and `--mutants-budget` name; neither names the defaults.
pub fn confirmed(switch: Option<Switch>, budget: Option<u64>) -> Result<MutantsSection> {
    let off = switch == Some(Switch::Off);
    if off && budget.is_some() {
        return Err(anyhow!(
            "--mutants-budget: a budget for mutants turned off (`--mutants off`) — name one or the other"
        ));
    }
    Ok(MutantsSection {
        off,
        budget_secs: budget,
    })
}

/// The flags that write `s` again, as a review reads it: a budget beside `off`, or of no seconds,
/// runs nothing and is left out — a write would refuse it.
fn flags(s: &MutantsSection) -> Vec<String> {
    if s.off {
        return vec!["--mutants".to_owned(), "off".to_owned()];
    }
    s.budget_secs
        .filter(|b| *b > 0)
        .map(|b| vec!["--mutants-budget".to_owned(), b.to_string()])
        .unwrap_or_default()
}
