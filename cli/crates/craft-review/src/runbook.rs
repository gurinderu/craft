//! The runbook signal (realm @nick/craft, node #620): a changed Markdown file whose changed lines
//! touch an operator step — a command line inside a shell fence, or a numbered step holding one,
//! that acts on a system outside the checkout — goes to the `runbook` profile and its lens instead
//! of being left out as prose. A line heuristic, not a Markdown parser: it reads the file as the
//! working tree holds it ([`changed`]), the fences by `CommonMark`'s rule ([`fence`]) and a command
//! line by its words ([`command`]).

mod changed;
mod command;
mod fence;

pub(crate) use changed::taken;

use command::runs_command;
use fence::Fence;

/// One logical command of a shell block: its physical lines (joined by a trailing `\`) and text.
#[derive(Default)]
struct Pending {
    lines: Vec<u32>,
    text: String,
}

impl Pending {
    /// Takes line `n` of a shell block into the command; once it ends (no trailing `\`), its lines
    /// join `out` when it runs a command. A comment line that opens no command is skipped.
    fn take(&mut self, line: &str, n: u32, out: &mut Vec<u32>) {
        let t = line.trim();
        if self.lines.is_empty() && (t.is_empty() || t.starts_with('#')) {
            return;
        }
        self.lines.push(n);
        let (body, continued) = t.strip_suffix('\\').map_or((t, false), |b| (b, true));
        self.text.push_str(body);
        self.text.push(' ');
        if continued {
            return;
        }
        if runs_command(&self.text) {
            out.append(&mut self.lines);
        }
        self.lines.clear();
        self.text.clear();
    }
}

/// Whether `line` is a numbered step (`1.`, `2)`) holding an inline code span that runs a command.
fn numbered_step(line: &str) -> bool {
    let t = line.trim_start();
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    let rest = t.get(digits..).unwrap_or("");
    if digits == 0 || !(rest.starts_with(". ") || rest.starts_with(") ")) {
        return false;
    }
    rest.split('`').skip(1).step_by(2).any(runs_command)
}

/// The 1-based lines of Markdown `text` that are steps: each line of a command a shell fence runs
/// (a fence whose info string is a shell or empty), and each numbered step whose inline code runs
/// one.
#[must_use]
pub(crate) fn step_lines(text: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let mut open: Option<Fence> = None;
    let mut pending = Pending::default();
    for (line, n) in text.lines().zip(1u32..) {
        match open.as_ref().map(|f| (f.closes(line), f.shell)) {
            Some((true, _)) => {
                open = None;
                pending = Pending::default();
            }
            Some((false, true)) => pending.take(line, n, &mut out),
            Some((false, false)) => {}
            None if numbered_step(line) => out.push(n),
            None => open = fence::open(line),
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
