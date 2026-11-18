//! A shell command split the way the shell would read it, as far as finding the commands it runs
//! needs: quotes and backslashes keep a separator or a space in a word, a backslash-newline joins
//! two lines, `$(…)` and backticks stay inside their word, a `#` comment and a heredoc's body are
//! text, and `(`/`)` open and close a subshell.

#[path = "heredoc.rs"]
mod heredoc;

use std::iter::Peekable;
use std::str::Chars;

/// One piece of a command: a simple command's words with the quoting taken off, or a subshell's
/// opening or closing parenthesis.
#[derive(Debug, PartialEq, Eq)]
pub enum Piece {
    Words(Vec<String>),
    Open,
    Close,
}

/// `command` as its pieces, in order.
pub fn pieces(command: &str) -> Vec<Piece> {
    let mut split = Split {
        chars: command.chars().peekable(),
        pieces: Vec::new(),
        words: Vec::new(),
        word: None,
        heredocs: Vec::new(),
    };
    while let Some(c) = split.chars.next() {
        split.take(c);
    }
    split.end_command();
    split.pieces
}

struct Split<'a> {
    chars: Peekable<Chars<'a>>,
    pieces: Vec<Piece>,
    words: Vec<String>,
    word: Option<String>,
    /// The heredocs opened on the current line: each delimiter, and whether `<<-` strips tabs.
    heredocs: Vec<(String, bool)>,
}

impl Split<'_> {
    fn take(&mut self, c: char) {
        match c {
            '\'' => self.quoted('\'', false),
            '"' => self.quoted('"', true),
            '\\' => self.escaped(),
            '$' if self.chars.peek() == Some(&'(') => self.substitution(),
            '`' => self.backticks(),
            '#' if self.word.is_none() => self.comment(),
            '<' if self.chars.peek() == Some(&'<') => self.heredoc(),
            '\n' => {
                self.end_command();
                self.heredoc_bodies();
            }
            ';' | '&' | '|' => self.end_command(),
            '(' | ')' => {
                self.end_command();
                self.pieces
                    .push(if c == '(' { Piece::Open } else { Piece::Close });
            }
            c if c.is_whitespace() => self.end_word(),
            c => self.push(c),
        }
    }

    /// A quoted run up to its closing quote; inside double quotes a backslash still escapes, and a
    /// backslash-newline is dropped.
    fn quoted(&mut self, closes: char, escapes: bool) {
        self.word.get_or_insert_with(String::new);
        while let Some(c) = self.chars.next() {
            if c == closes {
                return;
            }
            if escapes && c == '\\' {
                match self.chars.next() {
                    Some('\n') | None => {}
                    Some(n) => self.push(n),
                }
                continue;
            }
            self.push(c);
        }
    }

    /// A backslash keeps the next character in the word; before a newline it joins the lines.
    fn escaped(&mut self) {
        match self.chars.next() {
            Some('\n') | None => {}
            Some(n) => self.push(n),
        }
    }

    /// `$(…)`, nested ones included, kept whole in the word: what it runs is not this command's.
    fn substitution(&mut self) {
        self.push('$');
        let mut depth = 0_usize;
        while let Some(c) = self.chars.next() {
            self.push(c);
            match c {
                '(' => depth += 1,
                ')' if depth <= 1 => return,
                ')' => depth -= 1,
                _ => {}
            }
        }
    }

    fn backticks(&mut self) {
        self.push('`');
        for c in self.chars.by_ref() {
            self.word.get_or_insert_with(String::new).push(c);
            if c == '`' {
                return;
            }
        }
    }

    /// A comment runs to the end of the line, which is left to end the command.
    fn comment(&mut self) {
        while self.chars.next_if(|c| *c != '\n').is_some() {}
    }

    /// `<<` or `<<-` and its delimiter word, its body read at the end of the line; `<<<` is a
    /// here-string, whose word is an ordinary one.
    fn heredoc(&mut self) {
        self.chars.next();
        if self.chars.next_if_eq(&'<').is_some() {
            return;
        }
        self.end_word();
        if let Some(opened) = heredoc::opened(&mut self.chars) {
            self.heredocs.push(opened);
        }
    }

    /// The bodies of the heredocs the line opened, each up to its delimiter line, passed over.
    fn heredoc_bodies(&mut self) {
        for (delimiter, strip) in std::mem::take(&mut self.heredocs) {
            heredoc::pass_body(&mut self.chars, &delimiter, strip);
        }
    }

    fn push(&mut self, c: char) {
        self.word.get_or_insert_with(String::new).push(c);
    }

    fn end_word(&mut self) {
        if let Some(w) = self.word.take() {
            self.words.push(w);
        }
    }

    fn end_command(&mut self) {
        self.end_word();
        if !self.words.is_empty() {
            self.pieces
                .push(Piece::Words(std::mem::take(&mut self.words)));
        }
    }
}
