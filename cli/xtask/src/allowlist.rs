//! The small form the gate's recipes are held to, so that an edit which could hide a step's failure fails
//! `gate-steps` loudly instead of passing quietly. An allowlist, not a sandbox: it reads the justfile as text, and
//! an author set on bypassing it can still edit this file.
//!
//! A gate recipe (each step, and `gate` itself) is one line, continued lines joined as just joins them; it depends
//! on no recipe and carries no attribute but `[group('gate')]` and `[doc(…)]`. Its line is commands joined by `&&`,
//! each a run of words — letters, digits and `_ . / : = , + @ * -` — and quoted strings, with the redirections
//! `2>&1`, `>&2` and `>file`. A double-quoted string holds no `$`, backquote or backslash, except `"$@"` and `"$1"`;
//! `${1:+--base "$1"}` is the one expansion outside quotes; both only in a recipe that takes a parameter. No `{{`,
//! no just `-` or `@` prefix, and no command that is just or another shell (`just`, `sh -c`, `bash -c`, `eval`, …).
//! Anything else — `|`, `;`, `&`, `!`, `(`, `{`, `?`, `<`, `#`, `$(`, a backquote — refuses the recipe, naming it.
//! The justfile itself sets nothing but `set positional-arguments` and imports nothing.

use crate::justfile::Recipe;

mod line;
use line::check_line;

/// The settings the justfile may carry.
pub const SETTINGS: [&str; 1] = ["set positional-arguments"];

/// Each `recipe: why` for which `recipe` is outside the form.
pub fn recipe(recipe: &Recipe) -> Vec<String> {
    let name = &recipe.name;
    let mut out: Vec<String> = recipe
        .attributes
        .iter()
        .filter(|a| !allowed_attribute(a))
        .map(|a| format!("{name}: the attribute `[{a}]`"))
        .collect();
    if !recipe.dependencies.is_empty() {
        out.push(format!("{name}: it depends on `{}`", recipe.dependencies));
    }
    match recipe.commands().as_slice() {
        [line] => {
            if let Err(why) = check_line(line, !recipe.params.is_empty()) {
                out.push(format!("{name}: {} — {why}", line.trim()));
            }
        }
        lines => out.push(format!("{name}: {} lines, not one", lines.len())),
    }
    out
}

/// Each directive the justfile may not carry, with why.
pub fn directives(directives: &[String]) -> Vec<String> {
    directives
        .iter()
        .filter(|d| !SETTINGS.contains(&d.as_str()))
        .map(|d| {
            if d.starts_with("set ") {
                format!(
                    "justfile: `{d}` — the gate's justfile sets only {}",
                    SETTINGS.join(", ")
                )
            } else {
                format!(
                    "justfile: `{d}` — it brings in recipes or settings gate-steps does not read"
                )
            }
        })
        .collect()
}

fn allowed_attribute(attribute: &str) -> bool {
    attribute == "group('gate')" || attribute == "group(\"gate\")" || attribute.starts_with("doc(")
}

#[cfg(test)]
mod tests;
