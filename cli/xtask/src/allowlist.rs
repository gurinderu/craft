//! The small form the gate's recipes are held to, so that an edit which could hide a step's failure fails
//! `gate-steps` loudly instead of passing quietly. An allowlist, not a sandbox: it reads the justfile as text, and
//! an author set on bypassing it can still edit this file.
//!
//! A gate recipe (each step, and `gate` itself) is one line, continued lines joined as just joins them; it depends
//! on no recipe, carries no attribute but `[group('gate')]` and `[doc(…)]`, and takes only parameters that are a
//! bare name, `*name`/`+name` or a name with a literal string default — never `$`-exported, never a backquote or
//! a function call. Its line is commands joined by `&&`. A command is one of exactly the commands the justfile
//! runs today (`commands::COMMANDS`) — never an environment assignment, another shell, `just` or a wrapper — and
//! `node` may not take `-e`/`--eval`/`-p`/`--print`/`-r`/`--require`/`--import`, `python3` may not take `-c`, and
//! `npm`/`npx` may not take `-c`/`--call`. Its arguments are words — letters, digits and `_ . / : = , + @ * -` —
//! and quoted strings, with the redirections `2>&1`, `>&2` and `>file`; a double-quoted string holds no `$`,
//! backquote or backslash, except `"$@"` and `"$1"`, and `${1:+--base "$1"}` is the one expansion outside quotes,
//! both only in a recipe that takes a parameter. No `{{`, no just `-` or `@` prefix. Anything else — `|`, `;`,
//! `&`, `!`, `(`, `{`, `?`, `<`, `#`, `$(`, a backquote — refuses the recipe, naming it. Besides its recipes the
//! justfile holds only `set positional-arguments` and the one `export PATH` (`TOP_LEVEL`): no other setting,
//! export, assignment, alias, import or module.

use crate::justfile::Recipe;

mod commands;
mod line;
use line::check_line;

/// The top-level lines the justfile may carry besides its recipes, whitespace collapsed: its one setting and the
/// one export that puts `node_modules/.bin` on PATH.
pub const TOP_LEVEL: [&str; 2] = [
    "set positional-arguments",
    "export PATH := justfile_directory() + \"/node_modules/.bin:\" + env_var('PATH')",
];

/// Each `recipe: why` for which `recipe` is outside the form.
pub fn recipe(recipe: &Recipe) -> Vec<String> {
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
            if let Err(why) = check_line(line, !recipe.params.is_empty()) {
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
