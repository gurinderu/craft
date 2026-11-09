//! A workflow's `run:` lines read as shell (realm @nick/craft, node #483): the commands of one
//! line, the cargo subcommand a command runs, whether it calls a recipe whose content the
//! workflow does not show, and the signals a recipe's words hint at.

use super::signal::Signal;

/// The commands of one shell line: split at `&&`, `||` and `;`.
pub(super) fn commands(line: &str) -> impl Iterator<Item = &str> {
    line.split("&&")
        .flat_map(|s| s.split("||"))
        .flat_map(|s| s.split(';'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The subcommand of the first `cargo` a command runs, past a `+toolchain`.
pub(super) fn cargo_sub(command: &str) -> Option<&str> {
    let mut words = command.split_whitespace();
    words.by_ref().find(|w| *w == "cargo")?;
    words.find(|w| !w.starts_with('+'))
}

/// Each signal `line` runs a cargo command for, in its order.
#[must_use]
pub(super) fn signals_in(line: &str) -> Vec<Signal> {
    commands(line)
        .filter_map(|c| cargo_sub(c).and_then(Signal::of_cargo))
        .collect()
}

/// Whether a command calls a recipe whose content the workflow does not show.
pub(super) fn recipe(command: &str) -> bool {
    let program = command
        .split_whitespace()
        .find(|w| !w.contains('=') || w.starts_with('-'))
        .unwrap_or("");
    matches!(cargo_sub(command), Some("xtask" | "make"))
        || matches!(program, "just" | "make" | "cargo-make" | "bash" | "sh")
        || program.starts_with("./")
        || program.ends_with(".sh")
}

/// The signals `text`'s words hint at; `ci` hints at all.
pub(super) fn hints(text: &str) -> Vec<Signal> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has = |ks: &[&str]| words.iter().any(|w| ks.contains(w));
    Signal::ALL
        .into_iter()
        .filter(|s| {
            has(&["ci"])
                || match s {
                    Signal::Clippy => has(&["clippy", "lint"]),
                    Signal::Test => has(&["test", "tests"]),
                    Signal::Fmt => has(&["fmt", "format"]),
                    Signal::Build => has(&["build"]),
                }
        })
        .collect()
}

/// A literal block's lines, each ending in `\` joined with the next.
pub(super) fn joined(block: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut open = false;
    for b in block {
        let (text, more) = b
            .strip_suffix('\\')
            .map_or((*b, false), |t| (t.trim_end(), true));
        match (open, out.last_mut()) {
            (true, Some(last)) => {
                last.push(' ');
                last.push_str(text);
            }
            _ => out.push(text.to_owned()),
        }
        open = more;
    }
    out
}
