//! The recipes of the root justfile, read as the gate needs them: name, parameters, `[group(…)]` attributes and
//! body lines, in file order. A reader of the forms this repository writes, not of just's whole grammar:
//! `gate-steps` holds the names it reads to the ones `just --summary --unsorted` lists.

/// One recipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipe {
    pub name: String,
    pub params: Vec<String>,
    pub groups: Vec<String>,
    /// The body's lines, their indentation trimmed.
    pub body: Vec<String>,
}

impl Recipe {
    pub fn in_group(&self, group: &str) -> bool {
        self.groups.iter().any(|g| g == group)
    }

    /// The body's commands: a line ending in `\\` joined to the next, as just joins them.
    pub fn commands(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut open = false;
        for line in &self.body {
            let (text, continues) = line
                .strip_suffix('\\')
                .map_or((line.as_str(), false), |t| (t, true));
            match (open, out.last_mut()) {
                (true, Some(last)) => {
                    last.push(' ');
                    last.push_str(text.trim());
                }
                _ => out.push(text.trim().to_owned()),
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
    let mut open = false;
    for line in text.lines() {
        if line.starts_with([' ', '\t']) {
            if let (true, Some(recipe)) = (open, found.last_mut()) {
                recipe.body.push(line.trim().to_owned());
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
            continue;
        }
        if let Some((name, params)) = header(line) {
            found.push(Recipe {
                name,
                params,
                groups: std::mem::take(&mut groups),
                body: Vec::new(),
            });
            open = true;
        } else {
            groups.clear();
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

/// The names in `group('…')` / `group("…")` of an attribute line's inside.
fn groups_in(inner: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = inner;
    while let Some(at) = rest.find("group(") {
        let (_, after) = rest.split_at(at + "group(".len());
        let quoted = after.trim_start();
        let Some(quote) = quoted.chars().next().filter(|c| *c == '\'' || *c == '"') else {
            break;
        };
        let (_, value) = quoted.split_at(quote.len_utf8());
        let Some(end) = value.find(quote) else { break };
        let (name, tail) = value.split_at(end);
        out.push(name.to_owned());
        rest = tail;
    }
    out
}

/// `name params…:` — a recipe header; `None` for a setting, an assignment or anything else.
fn header(line: &str) -> Option<(String, Vec<String>)> {
    const KEYWORDS: [&str; 5] = ["set ", "export ", "alias ", "import ", "mod "];
    if KEYWORDS.iter().any(|k| line.starts_with(k)) {
        return None;
    }
    let colon = line.find(':')?;
    let (head, tail) = line.split_at(colon);
    if tail.starts_with(":=") {
        return None;
    }
    let mut words = head.trim_start_matches('@').split_whitespace();
    let name = words.next()?;
    let valid = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return None;
    }
    let params = words
        .map(|w| w.trim_start_matches(['*', '+']).trim_start_matches('$'))
        .map(|w| w.split('=').next().unwrap_or(w).to_owned())
        .collect();
    Some((name.to_owned(), params))
}

#[cfg(test)]
mod tests;
