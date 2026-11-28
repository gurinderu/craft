//! The recipes of the root justfile, read as the gate needs them: name, parameters, dependencies, attributes and
//! body lines, in file order, and its top-level directives (`set`, `import`, `mod`). A reader of the forms this repository writes, not of just's whole grammar:
//! `gate-steps` holds the names it reads to the ones `just --summary --unsorted` lists.

mod syntax;
pub use syntax::directives;
use syntax::{attributes_in, groups_in, header};

/// One recipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipe {
    pub name: String,
    pub params: Vec<String>,
    /// The parameters as written (`*args`, `base=""`).
    pub param_words: Vec<String>,
    pub groups: Vec<String>,
    /// Each attribute as written, its inner whitespace dropped (`group('gate')`, `script:'sh'`).
    pub attributes: Vec<String>,
    /// What follows the header's `:` — the recipes it depends on — trimmed; empty for none.
    pub dependencies: String,
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
    let mut attributes: Vec<String> = Vec::new();
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
            attributes.extend(attributes_in(inner));
            continue;
        }
        if let Some(h) = header(line) {
            found.push(Recipe {
                name: h.name,
                params: h.params,
                param_words: h.param_words,
                groups: std::mem::take(&mut groups),
                attributes: std::mem::take(&mut attributes),
                dependencies: h.dependencies,
                body: Vec::new(),
            });
            open = true;
        } else {
            groups.clear();
            attributes.clear();
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
