//! The recipes of the root justfile, read as the gate needs them: name, parameters, `[group(…)]` attributes and
//! body lines, in file order. A reader of the forms this repository writes, not of just's whole grammar:
//! `gate-steps` holds the names it reads to the ones `just --summary --unsorted` lists.

mod syntax;
pub use syntax::ignores_errors;
use syntax::{groups_in, header, names_script};

/// One recipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipe {
    pub name: String,
    pub params: Vec<String>,
    pub groups: Vec<String>,
    /// `[script]`: the body runs as one script, not line by line.
    pub script: bool,
    /// The body's lines, their indentation trimmed.
    pub body: Vec<String>,
}

impl Recipe {
    pub fn in_group(&self, group: &str) -> bool {
        self.groups.iter().any(|g| g == group)
    }

    /// The body's commands, a line ending in `\\` joined to the next as just joins them: the backslash and the
    /// line break dropped, the next line's indentation too, and nothing put in their place
    /// (`echo one\\` then `two` runs `echo onetwo`).
    pub fn commands(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut open = false;
        for line in &self.body {
            let (text, continues) = line
                .strip_suffix('\\')
                .map_or((line.as_str(), false), |t| (t, true));
            match (open, out.last_mut()) {
                (true, Some(last)) => last.push_str(text.trim_start()),
                _ => out.push(text.to_owned()),
            }
            open = continues;
        }
        out
    }

    /// A script recipe: `[script]`, or a body opening with `#!`; just runs it whole, not line by line.
    pub fn is_script(&self) -> bool {
        self.script || self.body.first().is_some_and(|l| l.starts_with("#!"))
    }

    pub fn body_text(&self) -> String {
        self.commands().join("\n")
    }
}

/// The group whose recipes are the gate's steps.
pub const GATE_GROUP: &str = "gate";

/// Every recipe of `text`, in file order.
pub fn recipes(text: &str) -> Vec<Recipe> {
    let mut found: Vec<Recipe> = Vec::new();
    let mut groups: Vec<String> = Vec::new();
    let mut script = false;
    let mut open = false;
    for line in text.lines() {
        if line.starts_with([' ', '\t']) {
            if let (true, Some(recipe)) = (open, found.last_mut()) {
                recipe.body.push(line.trim_start().to_owned());
            }
            continue;
        }
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        open = false;
        if let Some(inner) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            groups.extend(groups_in(inner));
            script |= names_script(inner);
            continue;
        }
        if let Some((name, params)) = header(line) {
            found.push(Recipe {
                name,
                params,
                groups: std::mem::take(&mut groups),
                script: std::mem::take(&mut script),
                body: Vec::new(),
            });
            open = true;
        } else {
            groups.clear();
            script = false;
        }
    }
    found
}

/// The recipes of the gate, in order.
pub fn gate_steps(recipes: &[Recipe]) -> Vec<Recipe> {
    recipes
        .iter()
        .filter(|r| r.in_group(GATE_GROUP))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests;
