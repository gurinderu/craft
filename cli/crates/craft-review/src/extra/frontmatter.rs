//! The fields discovery reads from an agent definition's YAML frontmatter: `name`, `description`,
//! `tools` and `disallowedTools`, each as plain text. Only the shapes agent definitions use are
//! read — a plain or quoted scalar, a folded or literal block, a flow `[a, b]` or block `- a` list
//! (joined with spaces) — never a full YAML document.

use std::path::Path;

/// One agent definition as discovery reads it; a field it lacks is empty, a name it lacks its file's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Definition {
    pub name: String,
    pub description: String,
    pub tools: String,
    pub disallowed: String,
}

/// The definitions of the `*.md` files directly in `dir`, by file name; none when it is unreadable.
pub(super) fn read_definitions(dir: &Path) -> Vec<Definition> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|p| {
            let text = std::fs::read_to_string(p).ok()?;
            let stem = p.file_stem()?.to_string_lossy();
            Some(parse_definition(&text, &stem))
        })
        .collect()
}

/// The definition in `text`, named `stem` when its frontmatter names none.
#[must_use]
pub fn parse_definition(text: &str, stem: &str) -> Definition {
    let mut d = Definition::default();
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        d.name = stem.to_owned();
        return d;
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim_end() != "---").collect();
    let mut i = 0;
    while let Some(line) = body.get(i) {
        i += 1;
        if line.starts_with([' ', '\t', '-', '#']) {
            continue;
        }
        let Some((key, raw)) = line.split_once(':') else {
            continue;
        };
        let (value, used) = value(raw.trim(), body.get(i..).unwrap_or_default());
        i += used;
        match key.trim() {
            "name" => d.name = value,
            "description" => d.description = value,
            "tools" => d.tools = value,
            "disallowedTools" => d.disallowed = value,
            _ => {}
        }
    }
    if d.name.trim().is_empty() {
        d.name = stem.to_owned();
    }
    d.name = d.name.trim().to_owned();
    d
}

/// A key's value from what follows its colon and the lines after it, and how many of those it used.
fn value(raw: &str, after: &[&str]) -> (String, usize) {
    let indented = after
        .iter()
        .take_while(|l| l.trim().is_empty() || l.starts_with([' ', '\t']))
        .count();
    let block: Vec<&str> = after
        .iter()
        .take(indented)
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if raw.starts_with(['>', '|']) {
        let sep = if raw.starts_with('>') { " " } else { "\n" };
        return (block.join(sep), indented);
    }
    if raw.is_empty() {
        let items: Vec<String> = block
            .iter()
            .map(|l| unquote(l.strip_prefix('-').unwrap_or(l).trim()))
            .collect();
        return (items.join(" "), indented);
    }
    if let Some(list) = raw.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        let items: Vec<String> = list.split(',').map(|x| unquote(x.trim())).collect();
        return (items.join(" "), 0);
    }
    (unquote(raw), 0)
}

/// `s` without the quotes around it, a doubled single quote read as one.
fn unquote(s: &str) -> String {
    if let Some(inner) = s.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        return inner.replace("\\\"", "\"");
    }
    if let Some(inner) = s.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
        return inner.replace("''", "'");
    }
    s.to_owned()
}
