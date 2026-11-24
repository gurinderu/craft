//! What a shell line leaves open past its end, so the lines that follow are read as part of the
//! command that opened them (realm @nick/craft, node #620): a quoted argument spanning lines
//! (`ssh host '…'`), and the here-documents it opened (`psql <<EOF`, `kubectl apply -f - <<'EOF'`),
//! whose bodies run through that command. Read as the shell reads them, without parsing further:
//! quotes and `\` escapes, a `#` comment opening a word, a `<<` or `<<-` with its delimiter word,
//! a `<<<` here-string and an arithmetic `<<` (inside `((…))` or `$((…))`, its parentheses counted
//! one by one) opening nothing. An unquoted `let x=y<<1` does open one: the shell reads redirections
//! before `let` runs.

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

/// What a command's lines leave open from one to the next: a quote, and the parentheses and
/// arithmetic `((` a `\` continuation carries on.
#[derive(Debug, PartialEq, Eq, Default)]
pub(super) struct Open {
    pub quote: Option<char>,
    /// The parentheses open.
    depth: usize,
    /// The depth each open arithmetic `((` was opened at.
    arithmetic: Vec<usize>,
}

/// What one line left open: the quote still open at its end, and the here-documents it opened, in
/// order.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq, Default)]
pub(super) struct Opened {
    pub quote: Option<char>,
    pub heredocs: Vec<Heredoc>,
}

/// [`read`] of one line begun inside `quote`, nothing else open.
#[cfg(test)]
pub(super) fn scan(line: &str, quote: Option<char>) -> Opened {
    let mut open = Open {
        quote,
        ..Open::default()
    };
    let heredocs = read(line, &mut open);
    Opened {
        quote: open.quote,
        heredocs,
    }
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

/// Reads `line` of a command, begun with what its former lines left `open`, which it updates: the
/// here-documents it opens, in order.
pub(super) fn read(line: &str, open: &mut Open) -> Vec<Heredoc> {
    let mut heredocs = Vec::new();
    let Open {
        quote,
        depth,
        arithmetic,
    } = open;
    let mut chars = line.chars().peekable();
    let mut word_start = true;
    while let Some(c) = chars.next() {
        match (*quote, c) {
            (Some('\''), '\'') | (Some('"'), '"') => *quote = None,
            (Some('"') | None, '\\') => {
                chars.next();
            }
            (None, '\'' | '"') => *quote = Some(c),
            (None, '#') if word_start => break,
            (None, '(') => {
                if chars.next_if_eq(&'(').is_some() {
                    arithmetic.push(*depth);
                    *depth += 1;
                }
                *depth += 1;
            }
            (None, ')') => {
                *depth = depth.saturating_sub(1);
                if arithmetic.last().is_some_and(|at| *depth <= *at) {
                    arithmetic.pop();
                }
            }
            // `<<` opens a here-document — `<<<`, a here-string, and an arithmetic shift none.
            (None, '<')
                if chars.next_if_eq(&'<').is_some()
                    && chars.next_if_eq(&'<').is_none()
                    && arithmetic.is_empty() =>
            {
                heredocs.extend(heredoc(&mut chars));
            }
            _ => {}
        }
        word_start = quote.is_none() && ends_word(c);
    }
    heredocs
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;
