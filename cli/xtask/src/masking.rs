//! Whether a recipe line can fail its recipe. just runs each line as `sh -cu <line>` (no `-e`, no pipefail) and
//! stops at the first line that exits non-zero, so a line fails its recipe only when its own status is the failing
//! tool's. A gate line therefore has no `||` fallback at all, no pipe, no `;` sequence, no background `&` and no `!`,
//! outside quotes and before a trailing comment; just's `-` prefix is refused, and so is a script recipe (`#!` or
//! `[script]`), which runs whole without stopping at a failed command.

use crate::justfile::Recipe;

/// Each `recipe: line — why` of a recipe whose failure a line can hide.
pub fn masked(recipe: &Recipe) -> Vec<String> {
    if recipe.is_script() {
        return vec![format!(
            "{}: a script recipe (#! or [script]) runs whole, past a failed command",
            recipe.name
        )];
    }
    recipe
        .commands()
        .iter()
        .filter_map(|line| why(line).map(|w| format!("{}: {} — {w}", recipe.name, line.trim())))
        .collect()
}

/// Why `line` cannot fail its recipe, if it cannot.
pub fn why(line: &str) -> Option<&'static str> {
    let line = line.trim();
    let after_quiet = line.trim_start_matches('@');
    if after_quiet.starts_with('-') {
        return Some("just's `-` prefix ignores its failure");
    }
    operator(after_quiet)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Quote {
    None,
    Single,
    Double,
}

/// The first status-hiding operator outside quotes, before a comment.
fn operator(code: &str) -> Option<&'static str> {
    let chars: Vec<char> = code.chars().collect();
    let mut quote = Quote::None;
    let mut command_start = true;
    let mut i = 0;
    while let Some(&c) = chars.get(i) {
        let next = chars.get(i + 1).copied();
        let prev = i.checked_sub(1).and_then(|p| chars.get(p)).copied();
        i += 1;
        match (quote, c) {
            (Quote::Single, '\'') | (Quote::Double, '"') => quote = Quote::None,
            (Quote::Double | Quote::None, '\\') => i += 1,
            (Quote::None, '\'') => quote = Quote::Single,
            (Quote::None, '"') => quote = Quote::Double,
            (Quote::None, '#') if prev.is_none_or(char::is_whitespace) => return None,
            (Quote::None, '|') if next == Some('|') => {
                return Some("an `||` fallback hides the failure");
            }
            (Quote::None, '|') => {
                return Some("a pipe: sh has no pipefail, the last command's status stands");
            }
            (Quote::None, ';') => {
                return Some("a `;` sequence: only the last command's status stands");
            }
            (Quote::None, '&') if next == Some('&') => {
                i += 1;
                command_start = true;
                continue;
            }
            (Quote::None, '&') if prev == Some('>') || next == Some('>') => {}
            (Quote::None, '&') => return Some("a background `&` exits 0 at once"),
            (Quote::None, '!') if command_start && next.is_none_or(char::is_whitespace) => {
                return Some("a `!` turns the failure into success");
            }
            _ => {}
        }
        if !c.is_whitespace() {
            command_start = false;
        }
    }
    None
}

#[cfg(test)]
mod tests;
