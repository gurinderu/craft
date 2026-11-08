//! The extra lenses a run is asked for, as `parseExtraLenses` in `lib/review-extra-lenses.mjs`
//! reads `extraLenses`.

use super::{Extra, Failed, How};

/// An agent type as a harness names one: `reviewer`, `code-critic`, `team.security-v2`.
#[must_use]
pub fn agent_type_form(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().count() <= 80
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// The request: absent, discovered on a light pass and off otherwise; `off`, `none`, `false` or
/// nothing, off; else the names, each once, separated by commas or spaces, a malformed one refused
/// as a failed lens.
#[must_use]
pub fn request(raw: Option<&str>, light: bool) -> Extra {
    let Some(raw) = raw else {
        let how = if light { How::Discovered } else { How::Off };
        return Extra {
            how,
            ..Extra::default()
        };
    };
    let names: Vec<&str> = raw
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() || matches!(raw.trim(), "off" | "none" | "false") {
        return Extra::default();
    }
    let mut extra = Extra {
        how: How::Named,
        ..Extra::default()
    };
    for n in names {
        if !agent_type_form(n) {
            extra.failed.push(Failed {
                agent: n.chars().take(40).collect(),
                why: "not an agent type name".into(),
            });
        } else if !extra.agents.iter().any(|a| a == n) {
            extra.agents.push(n.to_owned());
        }
    }
    extra
}
