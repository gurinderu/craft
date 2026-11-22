//! craft's own index of its records in the harness's project memory directory, and the move of
//! the per-record lines earlier releases wrote into the harness's `MEMORY.md` (the craft:memory
//! skill's `backends.md`). The harness loads `MEMORY.md` into every session and truncates it past
//! its load limit, so one line per record there silently drops records once a project has
//! enough; craft's lines live in `craft-memory.md` instead, and `MEMORY.md` keeps one pointer.
//! Pure text in, text out: the files are read and written by the caller.

use std::collections::BTreeMap;

/// craft's index file, beside `MEMORY.md`.
pub const INDEX_FILE: &str = "craft-memory.md";
/// The harness's own index.
pub const HARNESS_FILE: &str = "MEMORY.md";
/// The one line `MEMORY.md` keeps for craft.
pub const POINTER: &str = "- [craft memory index](craft-memory.md) — craft's decisions, rules, lessons and questions; read on recall";
/// The longest index line; a longer title is shortened with `…`.
const LINE_MAX: usize = 150;
const KINDS: [&str; 5] = ["decision", "rule", "lesson", "question", "external"];

/// One record file's frontmatter, as far as the index reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub scope: String,
    pub active: bool,
}

/// Whether `name` is a record file's name: `<kind>-<10 hex>.md`.
#[must_use]
pub fn is_record_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    stem.split_once('-').is_some_and(|(k, h)| {
        KINDS.contains(&k)
            && h.len() == 10
            && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// A frontmatter value without its YAML quotes, or, unquoted, without a trailing ` # comment`.
fn unquote(v: &str) -> String {
    let v = v.trim();
    if let Some(s) = v.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return s.replace("\\\"", "\"").replace("\\\\", "\\");
    }
    if let Some(s) = v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        return s.replace("''", "'");
    }
    v.split(" #").next().unwrap_or("").trim_end().to_owned()
}

/// The frontmatter's `key: value` pairs, nesting ignored.
fn frontmatter(text: &str) -> BTreeMap<String, String> {
    let mut lines = text.lines();
    let mut out = BTreeMap::new();
    if lines.next().map(str::trim_end) != Some("---") {
        return out;
    }
    for line in lines.take_while(|l| l.trim_end() != "---") {
        if let Some((k, v)) = line.trim().split_once(':') {
            out.entry(k.trim().to_owned()).or_insert_with(|| unquote(v));
        }
    }
    out
}

/// The record file `name` with its `text` read, `None` when it is not one of craft's (no
/// `craft_kind`, or a name not of the record form).
#[must_use]
pub fn entry(name: &str, text: &str) -> Option<Entry> {
    if !is_record_name(name) {
        return None;
    }
    let fm = frontmatter(text);
    let kind = fm.get("craft_kind").filter(|k| !k.is_empty())?.clone();
    let description = fm.get("description").cloned().unwrap_or_default();
    let title = description
        .strip_prefix(&format!("{kind}: "))
        .unwrap_or(&description)
        .to_owned();
    let scope = fm.get("craft_scope").cloned().unwrap_or_default();
    let status = fm.get("craft_status").map_or("active", String::as_str);
    Some(Entry {
        id: name.trim_end_matches(".md").to_owned(),
        kind,
        title,
        scope: if scope.is_empty() { ".".into() } else { scope },
        active: status.eq_ignore_ascii_case("active"),
    })
}

/// One index line, its title shortened past [`LINE_MAX`] characters.
fn line_of(e: &Entry) -> String {
    let make = |t: &str| format!("- [{}: {t}]({}.md)", e.kind, e.id);
    let full = make(&e.title);
    let over = full.chars().count().saturating_sub(LINE_MAX);
    if over == 0 {
        return full;
    }
    let keep = e.title.chars().count().saturating_sub(over + 1);
    let short: String = e.title.chars().take(keep).collect();
    make(&format!("{}…", short.trim_end()))
}

/// craft's index of the active `entries`: one heading per scope (sorted, `.` last), one line per
/// record under it (by kind, then id).
#[must_use]
pub fn render(entries: &[Entry]) -> String {
    let mut by_scope: BTreeMap<(bool, &str), Vec<&Entry>> = BTreeMap::new();
    for e in entries.iter().filter(|e| e.active) {
        by_scope
            .entry((e.scope == ".", &e.scope))
            .or_default()
            .push(e);
    }
    let mut out = String::from(
        "# craft memory index\n\nOne line per active craft record, by scope. Rebuilt from the record files by `craft memory reindex`; edits here are overwritten.\n",
    );
    for ((_, scope), mut list) in by_scope {
        list.sort_by_key(|e| (KINDS.iter().position(|k| *k == e.kind), e.id.clone()));
        out.push_str(&format!("\n## {scope}\n\n"));
        for e in list {
            out.push_str(&line_of(e));
            out.push('\n');
        }
    }
    out
}

/// The record file a Markdown list line links to, when it is a line of that shape.
fn link_target(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix("- [")?;
    let (_, after) = rest.split_once("](")?;
    let (target, _) = after.split_once(')')?;
    Some(target.trim())
}

/// Whether `MEMORY.md` forbids writes into its directory: a line that is, or starts with, "do not
/// write here" (trimmed, its Markdown list, heading or quote marker aside, any case) — the marker
/// the craft:memory skill honours as a refused write. craft's own old-layout index lines never
/// count, whatever their title says.
#[must_use]
pub fn forbids_writes(harness: &str) -> bool {
    harness.lines().any(|l| {
        let own = link_target(l).is_some_and(is_record_name);
        let text = l.trim().trim_start_matches(['#', '-', '*', '>', ' ', '\t']);
        !own && text.to_lowercase().starts_with("do not write here")
    })
}

/// `MEMORY.md` with every line that indexes one of craft's records (`craft`, the record file
/// names known to be craft's) moved out and the pointer present once; every other line kept as
/// it is, in its place, its line ending too (a CRLF file gets a CRLF pointer). Returns the text
/// and how many lines left it.
#[must_use]
pub fn migrate(harness: &str, craft: &dyn Fn(&str) -> bool) -> (String, usize) {
    let eol = if harness.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut moved = 0;
    let mut kept: Vec<&str> = Vec::new();
    for line in harness.split_inclusive('\n') {
        if link_target(line.trim_end()).is_some_and(|t| is_record_name(t) && craft(t)) {
            moved += 1;
        } else {
            kept.push(line);
        }
    }
    if kept.iter().any(|l| l.trim_end() == POINTER) {
        return (kept.concat(), moved);
    }
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.concat();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(eol);
    }
    out.push_str(POINTER);
    out.push_str(eol);
    (out, moved)
}
