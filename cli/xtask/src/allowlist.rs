//! The small form the gate's recipes are held to, so that an edit which could hide a step's failure fails
//! `gate-steps` loudly instead of passing quietly. An allowlist, not a sandbox: it reads the justfile as text, and
//! an author set on bypassing it can still edit this file.
//!
//! A gate step's line is exactly one of two forms: `npm run --silent <script>`, a `package.json` script (with
//! ` -- ${1:+--base "$1"}` appended only in a recipe that takes `base`), or `cd cli && cargo xtask <check>`, one of
//! xtask's own checks (`forms::XTASK_CHECKS`); `gate` is exactly `cd cli && cargo xtask gate "$@"`. No other word,
//! flag or quoting. A gate recipe is one line, continued lines joined as just joins them; it depends on no recipe,
//! carries no attribute but `[group('gate')]` and `[doc(…)]`, and takes only parameters that are a bare name,
//! `*name`/`+name` or a name with a literal string default. Besides its recipes the justfile holds only
//! `set positional-arguments` (`TOP_LEVEL`): no other setting, export, assignment, alias, import or module.
//!
//! What a `package.json` script itself runs is outside this check, as it was when the gate ran its steps through
//! npm: a script is judged by its name and by `gate-steps`'s coverage of the checks it names, not by its command.

use crate::justfile::Recipe;

use crate::keys::Keys;

pub mod forms;

/// The top-level lines the justfile may carry besides its recipes, whitespace collapsed.
pub const TOP_LEVEL: [&str; 1] = ["set positional-arguments"];

/// Each `recipe: why` for which `recipe` is outside the form.
pub fn recipe(recipe: &Recipe, keys: &Keys) -> Vec<String> {
    let name = &recipe.name;
    let mut out: Vec<String> = recipe
        .attributes
        .iter()
        .filter(|a| !allowed_attribute(a))
        .map(|a| format!("{name}: the attribute `[{a}]`"))
        .collect();
    for word in recipe.param_words.iter().filter(|w| !allowed_parameter(w)) {
        out.push(format!(
            "{name}: the parameter `{word}` — only a name, `*name`/`+name`, or a literal default"
        ));
    }
    if !recipe.dependencies.is_empty() {
        out.push(format!("{name}: it depends on `{}`", recipe.dependencies));
    }
    match recipe.commands().as_slice() {
        [line] => {
            if let Err(why) = forms::form(recipe, line, keys) {
                out.push(format!("{name}: {} — {why}", line.trim()));
            }
        }
        lines => out.push(format!("{name}: {} lines, not one", lines.len())),
    }
    out
}

/// Each top-level line the justfile may not carry, with why.
pub fn directives(directives: &[String]) -> Vec<String> {
    directives
        .iter()
        .filter(|d| !TOP_LEVEL.contains(&d.as_str()))
        .map(|d| {
            format!(
                "justfile: `{d}` — besides its recipes the justfile holds only `{}`",
                TOP_LEVEL.join("` and `")
            )
        })
        .collect()
}

/// A parameter as written: a bare name, `*name` or `+name`, or a name with a literal string default.
fn allowed_parameter(word: &str) -> bool {
    let (head, default) = word
        .split_once('=')
        .map_or((word, None), |(h, d)| (h, Some(d)));
    let name = head.strip_prefix(['*', '+']).unwrap_or(head);
    let named = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    named && default.is_none_or(literal)
}

/// `"…"` or `'…'` holding no quote, backslash, `$`, backquote or `{`.
fn literal(default: &str) -> bool {
    ['"', '\''].iter().any(|q| {
        default
            .strip_prefix(*q)
            .and_then(|d| d.strip_suffix(*q))
            .is_some_and(|inside| !inside.contains(['"', '\'', '\\', '$', '`', '{']))
    })
}

fn allowed_attribute(attribute: &str) -> bool {
    attribute == "group('gate')" || attribute == "group(\"gate\")" || attribute.starts_with("doc(")
}

#[cfg(test)]
mod tests;
