//! An agent file's `name` and `description`, read line by line from its YAML frontmatter, and
//! whether they make it a reviewer.

use super::js::{self, Re, compile};

static BLOCK: Re = Re::new(|| compile(r"(?s)^---\r?\n(.*?)\r?\n---"));
static LINE_BREAK: Re = Re::new(|| compile(r"\r?\n"));
static FOLDED: Re = Re::new(|| compile(r"^[>|][+-]?$"));
static CLAUSE_END: Re = Re::new(|| compile(r"[.;][{S}]|[{S}][—–-][{S}]"));
static REVIEW_LEAD: Re = Re::new(|| compile(r"(?i){B}review"));

/// One field: a folded or literal value (`>` or `|`), or an empty one, takes its indented lines;
/// a value in matching quotes loses them; a field the frontmatter lacks is `""`.
fn field(lines: &[&str], key: &str) -> String {
    let prefix = format!("{key}:");
    let Some(at) = lines.iter().position(|l| l.starts_with(&prefix)) else {
        return String::new();
    };
    let mut value = lines
        .get(at)
        .and_then(|l| l.get(prefix.len()..))
        .map_or("", js::trim)
        .to_owned();
    if value.is_empty() || FOLDED.is_match(&value) {
        value = lines
            .iter()
            .skip(at + 1)
            .take_while(|l| l.starts_with(js::is_space))
            .map(|l| js::trim(l))
            .collect::<Vec<_>>()
            .join(" ");
    }
    unquote(value)
}

fn unquote(value: String) -> String {
    let mut chars = value.chars();
    match (chars.next(), chars.next_back()) {
        (Some(open @ ('\'' | '"')), Some(close)) if open == close => chars.as_str().to_owned(),
        _ => value,
    }
}

/// The frontmatter's `name` and `description`.
pub fn read(text: &str) -> (String, String) {
    let body = BLOCK
        .get()
        .and_then(|r| r.captures(text))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str());
    let lines: Vec<&str> = match (body, LINE_BREAK.get()) {
        (Some(b), Some(r)) => r.split(b).collect(),
        _ => Vec::new(),
    };
    (field(&lines, "name"), field(&lines, "description"))
}

/// Whether an agent is a reviewer: its name says review, or the first clause of its description
/// does — up to the first `.`, `;` or dash, so a later "Not for … review" does not make one.
pub fn is_reviewer(name: &str, description: &str) -> bool {
    let lead = CLAUSE_END
        .get()
        .and_then(|r| r.find(description))
        .and_then(|m| description.get(..m.start()))
        .unwrap_or(description);
    name.to_ascii_lowercase().contains("review") || REVIEW_LEAD.is_match(&js::ascii_case(lead))
}
