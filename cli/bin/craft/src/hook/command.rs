//! Whether a shell command opens a pull request: one of its simple commands is `gh pr create`,
//! reached through `env`, `NAME=value` assignments and `rtk` as the repository's own `PreToolUse`
//! Bash hooks reach `git push` and `gh pr merge`, and not asking for `-h`/`--help`. The command is
//! split the way the shell would — quotes and backslashes keep a separator or a space in a word —
//! so `gh pr create` inside a quoted argument is text, not a command that runs. The `cd`s before
//! it in the chain move the directory the pull request is opened from.

use std::path::{Path, PathBuf};

/// The directory `gh pr create` runs in when `command` runs it from `cwd`; `None` when it does not.
pub fn pr_create_dir(command: &str, cwd: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let mut dir = cwd.to_path_buf();
    for words in simple_commands(command) {
        let run = after_prefixes(&words);
        if is_pr_create(run) {
            return Some(dir);
        }
        if let Some(to) = cd_target(run, home) {
            dir = dir.join(to);
        }
    }
    None
}

/// `command` as its simple commands, each as its words with the quoting taken off.
fn simple_commands(command: &str) -> Vec<Vec<String>> {
    let mut split = Split::default();
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        split.take(c, &mut chars);
    }
    split.finish()
}

#[derive(Default)]
struct Split {
    commands: Vec<Vec<String>>,
    words: Vec<String>,
    word: Option<String>,
}

impl Split {
    fn take(&mut self, c: char, rest: &mut std::str::Chars<'_>) {
        match c {
            '\'' => self.quoted(rest, |c| c == '\'', false),
            '"' => self.quoted(rest, |c| c == '"', true),
            '\\' => {
                if let Some(next) = rest.next() {
                    self.push(next);
                }
            }
            ';' | '&' | '|' | '\n' | '(' | ')' => self.end_command(),
            c if c.is_whitespace() => self.end_word(),
            c => self.push(c),
        }
    }

    /// A quoted run up to its closing quote; inside double quotes a backslash still escapes.
    fn quoted(&mut self, rest: &mut std::str::Chars<'_>, closes: fn(char) -> bool, escapes: bool) {
        self.word.get_or_insert_with(String::new);
        while let Some(c) = rest.next() {
            if closes(c) {
                return;
            }
            let c = if escapes && c == '\\' {
                rest.next().unwrap_or(c)
            } else {
                c
            };
            self.push(c);
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
            self.commands.push(std::mem::take(&mut self.words));
        }
    }

    fn finish(mut self) -> Vec<Vec<String>> {
        self.end_command();
        self.commands
    }
}

/// The words from the command itself on: `env`, `NAME=value` and `rtk` before it passed over.
fn after_prefixes(words: &[String]) -> &[String] {
    let skip = words
        .iter()
        .take_while(|w| *w == "env" || *w == "rtk" || is_assignment(w))
        .count();
    words.get(skip..).unwrap_or_default()
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        name.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn is_pr_create(words: &[String]) -> bool {
    matches!(words, [gh, pr, create, ..] if gh == "gh" && pr == "pr" && create == "create")
        && !words.iter().any(|w| w == "-h" || w == "--help")
}

/// Where a `cd` goes: its one argument, `~` read as `home`, or `home` for a bare `cd`.
fn cd_target(words: &[String], home: Option<&Path>) -> Option<PathBuf> {
    match words {
        [cd] if cd == "cd" => home.map(Path::to_path_buf),
        [cd, to] if cd == "cd" => match (to.strip_prefix('~'), home) {
            (Some(rest), Some(home)) => Some(home.join(rest.trim_start_matches('/'))),
            _ => Some(PathBuf::from(to)),
        },
        _ => None,
    }
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
