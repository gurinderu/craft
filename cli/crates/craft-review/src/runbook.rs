//! The runbook signal (realm @nick/craft, node #620): a changed Markdown file whose change touches
//! an operator step, on either side of the diff — a command line of a shell block, a shell block's
//! opening fence, or a numbered step holding one, that acts on a system outside the checkout —
//! goes to the `runbook` profile and its lens instead of being left out as prose. The blocks and
//! steps are found as `CommonMark` reads the file ([`markdown`]), a command line by its words
//! ([`command`]), both versions of the file as [`changed`] reads them.

mod changed;
mod command;
mod markdown;
mod renamed;
mod shell;

pub(crate) use changed::{Taken, taken};

use std::collections::BTreeSet;

use command::runs_command;
use markdown::ShellBlock;

/// One logical command of a shell block: its physical lines and text — lines joined by a trailing
/// `\`, by a quote left open, and the bodies of the here-documents it opened ([`shell`]).
#[derive(Default)]
struct Pending {
    lines: Vec<u32>,
    text: String,
    /// What a line left open: a quote, the parentheses and arithmetic a `\` carries on.
    open: shell::Open,
    /// The delimiters of the here-documents opened and not yet closed, the next body's first.
    heredocs: std::collections::VecDeque<shell::Heredoc>,
    /// Whether the command line ended and its here-document bodies are being read.
    in_body: bool,
}

impl Pending {
    /// Takes line `n` of a shell block into the command; once it ends (no trailing `\`, no quote
    /// left open, every here-document closed), its lines join `out` when it runs a command. A `#`
    /// line is a comment, except `# ` in a session block (`console`, `shell-session`), where it is
    /// a root prompt.
    fn take(&mut self, line: &str, (n, root_prompt): (u32, bool), out: &mut BTreeSet<u32>) {
        if self.in_body {
            self.body(line, n, out);
            return;
        }
        let mut t = line.trim();
        if self.lines.is_empty() {
            match t.strip_prefix("# ") {
                Some(rest) if root_prompt => t = rest,
                _ if t.is_empty() || t.starts_with('#') => return,
                _ => {}
            }
        }
        self.lines.push(n);
        self.heredocs.extend(shell::read(t, &mut self.open));
        let escaped = self.open.quote.is_none() && t.ends_with('\\');
        let body = if escaped {
            t.strip_suffix('\\').unwrap_or(t)
        } else {
            t
        };
        self.text.push_str(body);
        self.text.push(' ');
        if escaped || self.open.quote.is_some() {
            return;
        }
        if self.heredocs.is_empty() {
            self.finish(out);
        } else {
            self.in_body = true;
        }
    }

    /// Takes line `n` of a here-document body; its delimiter line closes it — the delimiter exactly,
    /// its leading tabs stripped only after `<<-` — and the last one closed ends the command.
    fn body(&mut self, line: &str, n: u32, out: &mut BTreeSet<u32>) {
        self.lines.push(n);
        self.text.push_str(line);
        self.text.push(' ');
        if self.heredocs.front().is_some_and(|d| d.closed_by(line)) {
            self.heredocs.pop_front();
            if self.heredocs.is_empty() {
                self.finish(out);
            }
        }
    }

    /// Ends the command — at its last line, or at the block's end while it is still open — its
    /// lines joining `out` when it runs a command.
    fn finish(&mut self, out: &mut BTreeSet<u32>) {
        if runs_command(&self.text) {
            out.extend(self.lines.drain(..));
        }
        *self = Self::default();
    }
}

/// The step lines of shell block `b`; with any, its opening fence's line too, so a change to the
/// info string touches the block.
fn block_steps(b: &ShellBlock, out: &mut BTreeSet<u32>) {
    let before = out.len();
    let mut pending = Pending::default();
    for (line, n) in b.text.lines().zip(b.first..) {
        pending.take(line, (n, b.root_prompt), out);
    }
    pending.finish(out);
    if out.len() > before {
        out.insert(b.opener);
    }
}

/// The 1-based lines of Markdown `text` that are steps: each line of a command a shell block runs
/// with that block's opening fence, and each numbered step whose inline code runs one.
#[must_use]
pub(crate) fn step_lines(text: &str) -> BTreeSet<u32> {
    let walked = markdown::walk(text);
    let mut out = BTreeSet::new();
    for b in &walked.blocks {
        block_steps(b, &mut out);
    }
    for (line, code) in &walked.codes {
        if runs_command(code) {
            out.insert(*line);
        }
    }
    out
}

/// Whether Markdown `text` carries any step ([`step_lines`]).
#[cfg(test)]
pub(crate) fn carries_steps(text: &str) -> bool {
    !step_lines(text).is_empty()
}

#[cfg(test)]
mod tests;
