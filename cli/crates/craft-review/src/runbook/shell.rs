//! What a shell line leaves open past its end, so the lines that follow are read as part of the
//! command that opened them (realm @nick/craft, node #620): a quoted argument spanning lines
//! (`ssh host '…'`), and the here-documents it opened (`psql <<EOF`, `kubectl apply -f - <<'EOF'`),
//! whose bodies run through that command. Read as the shell reads them, without parsing further:
//! quotes and `\` escapes, a `#` comment opening a word, a `<<` or `<<-` with its delimiter word,
//! a `<<<` here-string and an arithmetic `<<` (inside `((…))`, or on a `let` line) opening nothing.

/// A here-document a line opened: its delimiter word, and whether it was opened by `<<-`, whose
/// body and closing line have their leading tabs stripped.
#[derive(Debug, PartialEq, Eq, Clone)]
pub(super) struct Heredoc {
    pub delimiter: String,
    pub strip_tabs: bool,
}

impl Heredoc {
    /// Whether body line `line` closes this here-document: it is the delimiter exactly, after
    /// its leading tabs only for `<<-`.
    pub fn closed_by(&self, line: &str) -> bool {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let line = if self.strip_tabs {
            line.trim_start_matches('\t')
        } else {
            line
        };
        line == self.delimiter
    }
}

/// What one line left open: the quote still open at its end, and the here-documents it opened, in
/// order.
#[derive(Debug, PartialEq, Eq, Default)]
pub(super) struct Opened {
    pub quote: Option<char>,
    pub heredocs: Vec<Heredoc>,
}

/// Whether `c` ends an unquoted word.
fn ends_word(c: char) -> bool {
    c.is_whitespace() || matches!(c, ';' | '|' | '&' | '<' | '>' | '(' | ')')
}

/// The here-document whose `<<` `chars` stood just past: its delimiter word with the blanks
/// before it and its quotes taken off, and whether a `-` opened it; `None` when no word follows.
fn heredoc(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<Heredoc> {
    let strip_tabs = chars.next_if_eq(&'-').is_some();
    while chars.next_if(|c| *c == ' ' || *c == '\t').is_some() {}
    let mut word = String::new();
    let mut quote = None;
    while let Some(c) = chars.next_if(|c| quote.is_some() || !ends_word(*c)) {
        match (quote, c) {
            (None, '\'' | '"') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '\\') => word.extend(chars.next()),
            _ => word.push(c),
        }
    }
    (!word.is_empty()).then_some(Heredoc {
        delimiter: word,
        strip_tabs,
    })
}

/// Reads `line`, begun inside `quote` (the quote a former line left open, if any).
pub(super) fn scan(line: &str, quote: Option<char>) -> Opened {
    let mut out = Opened {
        quote,
        heredocs: Vec::new(),
    };
    // `let` evaluates its words as arithmetic, where `<<` is a shift.
    let arithmetic_line = quote.is_none() && line.split_whitespace().next() == Some("let");
    let mut arithmetic = 0usize;
    let mut chars = line.chars().peekable();
    let mut word_start = true;
    while let Some(c) = chars.next() {
        match (out.quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => out.quote = None,
            (Some('"') | None, '\\') => {
                chars.next();
            }
            (None, '\'' | '"') => out.quote = Some(c),
            (None, '#') if word_start => break,
            (None, '(') if chars.next_if_eq(&'(').is_some() => arithmetic += 1,
            (None, ')') if arithmetic > 0 && chars.next_if_eq(&')').is_some() => arithmetic -= 1,
            // `<<` opens a here-document — `<<<`, a here-string, and an arithmetic shift none.
            (None, '<')
                if chars.next_if_eq(&'<').is_some()
                    && chars.next_if_eq(&'<').is_none()
                    && arithmetic == 0
                    && !arithmetic_line =>
            {
                out.heredocs.extend(heredoc(&mut chars));
            }
            _ => {}
        }
        word_start = out.quote.is_none() && ends_word(c);
    }
    out
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;
