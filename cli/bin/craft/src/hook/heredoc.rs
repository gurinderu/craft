//! A heredoc as the splitter passes over it: the delimiter after `<<`/`<<-`, and the body lines up
//! to it.

use std::iter::Peekable;
use std::str::Chars;

/// The delimiter after `<<` (the second `<` read) and whether `<<-` strips leading tabs; its
/// quotes and backslashes taken off. `None` when no word follows.
pub fn opened(chars: &mut Peekable<Chars<'_>>) -> Option<(String, bool)> {
    let strip = chars.next_if_eq(&'-').is_some();
    while chars.next_if(|c| *c == ' ' || *c == '\t').is_some() {}
    let mut delimiter = String::new();
    while let Some(c) = chars.next_if(|c| !c.is_whitespace() && !";&|<>()".contains(*c)) {
        if !matches!(c, '\'' | '"' | '\\') {
            delimiter.push(c);
        }
    }
    (!delimiter.is_empty()).then_some((delimiter, strip))
}

/// Passes over the body lines up to and with the line `delimiter` (its leading tabs stripped when
/// `strip`), or to the end of the command.
pub fn pass_body(chars: &mut Peekable<Chars<'_>>, delimiter: &str, strip: bool) {
    loop {
        let mut line = String::new();
        while let Some(c) = chars.next_if(|c| *c != '\n') {
            line.push(c);
        }
        let ended = chars.next().is_none();
        let line = if strip {
            line.trim_start_matches('\t')
        } else {
            &line
        };
        if line == delimiter || ended {
            return;
        }
    }
}
