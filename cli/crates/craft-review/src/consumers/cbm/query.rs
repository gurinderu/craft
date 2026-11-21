//! The `query_graph` text asking one symbol's callers: those of the function of its name defined
//! in its own file, so callers of same-named functions elsewhere never fill its rows; non-test
//! callers asked apart from test ones, since the query language orders by no expression.
//!
//! A test caller is told apart by its path alone: a caller in an inline `#[cfg(test)]` module of
//! a source file is asked with the non-test ones, since the graph marks no such module.

/// A caller in a test path, as [`crate::consumers::symbols`]'s `is_test_path` reads one: a
/// `tests` or `benches` directory, a `tests.rs`, `*_tests.rs` or `*_test.rs` file.
const TEST_CALLER: &str = "(c.file_path STARTS WITH 'tests/' OR c.file_path STARTS WITH 'benches/' \
     OR c.file_path CONTAINS '/tests/' OR c.file_path CONTAINS '/benches/' \
     OR c.file_path = 'tests.rs' OR c.file_path ENDS WITH '/tests.rs' \
     OR c.file_path ENDS WITH '_tests.rs' OR c.file_path ENDS WITH '_test.rs')";

/// `s` as a string literal of the graph's query language (a backslash escapes, as its parser
/// reads `\'` and `\\`); `None` when it holds a control character.
pub(super) fn quoted(s: &str) -> Option<String> {
    if s.chars().any(char::is_control) {
        return None;
    }
    Some(format!(
        "'{}'",
        s.replace('\\', "\\\\").replace('\'', "\\'")
    ))
}

/// Which callers one query asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Callers {
    /// Those outside test paths.
    NonTest,
    /// Those in test paths.
    Test,
}

/// The query for up to `limit` callers of `name` defined in `file` (an identifier and a quoted
/// path), from test paths or from the rest.
pub(super) fn callers(name: &str, file: &str, which: Callers, limit: usize) -> String {
    let which = match which {
        Callers::Test => "",
        Callers::NonTest => "NOT ",
    };
    format!(
        "MATCH (c)-[r:CALLS]->(f) WHERE f.name = '{name}' AND f.file_path = {file} AND \
         {which}{TEST_CALLER} RETURN f.name, f.file_path, \
         c.file_path, c.start_line, c.end_line, r.line LIMIT {limit}"
    )
}

#[cfg(test)]
mod tests {
    use super::quoted;

    #[test]
    fn a_quote_and_a_backslash_are_escaped_and_a_control_character_refused() {
        assert_eq!(quoted("src/a.rs").as_deref(), Some("'src/a.rs'"));
        assert_eq!(quoted(r"it's\x").as_deref(), Some(r"'it\'s\\x'"));
        assert_eq!(quoted("a\nb"), None);
    }
}
