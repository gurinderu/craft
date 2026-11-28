//! The two forms a gate step's line may take, and the one form of `gate`; nothing is parsed beyond them.

use crate::gate::takes_base;
use crate::justfile::Recipe;
use crate::keys::Keys;

/// What a gate line runs.
#[derive(Debug, PartialEq, Eq)]
pub enum Form<'a> {
    /// `npm run --silent <script>`, a `package.json` script.
    Script(&'a str),
    /// `cd cli && cargo xtask <check>`, one of xtask's own checks.
    Xtask(&'a str),
    /// `cd cli && cargo xtask gate "$@"`, the gate's runner.
    Gate,
}

/// The recipe `just gate` runs.
pub const ENTRY: &str = "gate";

/// xtask's own checks a gate step may run.
pub const XTASK_CHECKS: [&str; 1] = ["gate-steps"];

const SCRIPT: &str = "npm run --silent ";
const XTASK: &str = "cd cli && cargo xtask ";
/// The base, handed to the script when the gate gives one.
const BASE: &str = " -- ${1:+--base \"$1\"}";
const GATE: &str = "cd cli && cargo xtask gate \"$@\"";

/// The form of `recipe`'s one line: `gate`'s own for the recipe `gate`, else one of the two a step may take.
pub fn form<'a>(recipe: &Recipe, line: &'a str, keys: &Keys) -> Result<Form<'a>, String> {
    let line = line.trim();
    if recipe.name == ENTRY {
        let variadic = recipe.param_words.iter().any(|w| w.starts_with(['*', '+']));
        return (line == GATE && variadic)
            .then_some(Form::Gate)
            .ok_or_else(|| format!("`gate` is exactly `{GATE}`, in a recipe taking `*args`"));
    }
    if let Some(script) = line.strip_prefix(SCRIPT) {
        let (script, base) = script
            .strip_suffix(BASE)
            .map_or((script, false), |s| (s, true));
        if base && !takes_base(recipe) {
            return Err("the base form in a recipe that takes no `base`".to_owned());
        }
        if keys.has_script(script) {
            return Ok(Form::Script(script));
        }
    }
    if let Some(check) = line
        .strip_prefix(XTASK)
        .filter(|c| XTASK_CHECKS.contains(c))
    {
        return Ok(Form::Xtask(check));
    }
    Err(format!(
        "not one of the two forms: `{SCRIPT}<package.json script>` (with `{}` to take the base) or `{XTASK}<{}>`",
        BASE.trim(),
        XTASK_CHECKS.join("|")
    ))
}

#[cfg(test)]
mod tests;
