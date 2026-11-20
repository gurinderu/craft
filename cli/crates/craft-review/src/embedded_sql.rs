//! The embedded-SQL signal (realm @nick/craft, node #536): a changed line of a profile's files
//! that holds a query string — a query crate's call, or a string literal opening with a SQL
//! statement — admits the `sql-queries` lens to that profile's plan. A line heuristic, not a parser:
//! it reads the lines the change added, in the working tree, and nothing else.

use std::path::Path;

use crate::gate::lines::Lines;
use crate::state::Track;

/// Calls that take a query string, as the Rust query crates spell them.
const CALLS: [&str; 7] = [
    "sqlx::query",
    "sqlx::raw_sql",
    "query!(",
    "query_as!(",
    "query_scalar!(",
    "query_file",
    "sql_query(",
];

/// A statement's opening in upper case, each followed by whitespace.
const UPPER: [&str; 6] = [
    "SELECT",
    "INSERT INTO",
    "UPDATE",
    "DELETE FROM",
    "WITH",
    "MERGE INTO",
];

/// A statement's opening in lower case and a word it must also hold (empty: none), so prose that
/// opens with the same verb ("update the cache") is not read as a query.
const LOWER: [(&str, &str); 5] = [
    ("select ", " from "),
    ("insert into ", ""),
    ("update ", " set "),
    ("delete from ", ""),
    ("with ", " as ("),
];

/// Whether `line` holds a query string: a query call, a string literal opening with a statement,
/// or the line itself opening with an upper-case statement (the body of a multi-line literal).
#[must_use]
pub(crate) fn holds_sql(line: &str) -> bool {
    CALLS.iter().any(|c| line.contains(c))
        || upper(line)
        || line
            .match_indices(['"', '\'', '`'])
            .any(|(at, q)| line.get(at + q.len()..).is_some_and(statement))
}

fn statement(text: &str) -> bool {
    upper(text) || {
        let lower = text.trim_start().to_lowercase();
        LOWER
            .iter()
            .any(|(open, also)| lower.starts_with(open) && lower.contains(also))
    }
}

/// An upper-case opening, then whitespace, then what a statement goes on with — a word, `*` or
/// `(` — so a constant (`UPDATE = 1`) is not read as one.
fn upper(text: &str) -> bool {
    let text = text.trim_start();
    UPPER.iter().any(|kw| {
        text.strip_prefix(kw).is_some_and(|rest| {
            let next = rest.trim_start().chars().next();
            rest.starts_with(char::is_whitespace)
                && next.is_some_and(|c| c.is_alphanumeric() || matches!(c, '*' | '(' | '"'))
        })
    })
}

/// Whether a line `lines` says the change added to one of `files`, read from the working tree at
/// `top`, holds a query string; a file that cannot be read holds none.
#[must_use]
pub(crate) fn in_changed_lines(top: &Path, lines: &Lines, files: &[String]) -> bool {
    lines
        .ranges()
        .filter(|(f, _)| files.iter().any(|x| x == f))
        .any(|(f, ranges)| {
            let Ok(text) = std::fs::read_to_string(top.join(f)) else {
                return false;
            };
            text.lines()
                .zip(1u32..)
                .any(|(l, n)| ranges.iter().any(|&(a, b)| (a..=b).contains(&n)) && holds_sql(l))
        })
}

/// Marks each of `tracks` whose changed lines hold a query string, the change read from the
/// zero-context diff of the checkout `cwd` is in against `merge_base`; a diff that cannot be read
/// marks none.
pub(crate) fn mark(cwd: &Path, merge_base: &str, tracks: &mut [Track]) {
    let (Ok(top), Ok(diff)) = (
        crate::git::toplevel(cwd),
        crate::git::zero_context_diff(cwd, merge_base),
    ) else {
        return;
    };
    let lines = Lines::parse(&diff);
    for t in tracks {
        t.embedded_sql = in_changed_lines(&top, &lines, &t.files);
    }
}

#[cfg(test)]
mod tests;
