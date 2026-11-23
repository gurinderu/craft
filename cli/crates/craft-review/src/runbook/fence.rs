//! A fenced code block as `CommonMark` opens and closes it: at most three spaces of indent, a run of
//! three or more backticks or tildes; a backtick fence's info string holds no backtick (so a
//! one-line ```` ```code``` ```` opens nothing); the block closes on a run of the same character at
//! least as long, with nothing after it.

/// The info strings of a fenced block that holds shell; an empty one counts too.
const SHELLS: &[&str] = &["sh", "bash", "shell", "console", "zsh", "shell-session"];

/// An open fence: its character, its run's length, and whether its block holds shell.
pub(super) struct Fence {
    ch: char,
    len: usize,
    pub(super) shell: bool,
}

/// `line` with at most three spaces of indent taken off; `None` when it is indented more.
fn unindented(line: &str) -> Option<&str> {
    let spaces = line.len() - line.trim_start_matches(' ').len();
    (spaces <= 3).then(|| line.get(spaces..)).flatten()
}

/// The run of `ch` that opens `t`, and what follows it.
fn run(t: &str, ch: char) -> (usize, &str) {
    let rest = t.trim_start_matches(ch);
    ((t.len() - rest.len()) / ch.len_utf8(), rest)
}

/// The fence `line` opens, if any.
pub(super) fn open(line: &str) -> Option<Fence> {
    let t = unindented(line)?;
    let ch = t.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let (len, info) = run(t, ch);
    if len < 3 || (ch == '`' && info.contains('`')) {
        return None;
    }
    let word = info.trim().split([' ', '{', ',']).next().unwrap_or("");
    let word = word.to_ascii_lowercase();
    Some(Fence {
        ch,
        len,
        shell: word.is_empty() || SHELLS.contains(&word.as_str()),
    })
}

impl Fence {
    /// Whether `line` closes this fence.
    pub(super) fn closes(&self, line: &str) -> bool {
        unindented(line).is_some_and(|t| {
            let (len, rest) = run(t, self.ch);
            len >= self.len && rest.trim().is_empty()
        })
    }
}
