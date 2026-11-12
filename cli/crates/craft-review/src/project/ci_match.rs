//! Whether a shell line runs a CI map entry's command (realm @nick/craft, node #482), so that no
//! line that cannot fail on the signal is read as coverage: one of the line's commands is the
//! entry's, whitespace aside, or extends it with further arguments; its program is `cargo`, past
//! `env` and `VAR=x` assignments (so `echo "cargo clippy"` is not one); its quotes are balanced (a
//! split inside a quoted string is no command); no argument stops it from exercising the signal
//! (`--no-run`, `--help`, `--version`) or drops its exit status (a trailing `&`, a pipe); and no
//! `||` stands beside it, before (it runs only when the other fails) or after (`|| true` swallows
//! its failure), unless what follows is `exit <non-zero>` or `false`.

/// The arguments a command line that exercises its signal never carries.
const REFUSED: [&str; 5] = ["--no-run", "--help", "-h", "--version", "-V"];

/// The commands of `line` with the operator before and after each: split at `&&`, `||`, `;`.
fn split(line: &str) -> Vec<(&str, &str, &str)> {
    let mut out = Vec::new();
    let (mut rest, mut before) = (line, "");
    loop {
        let next = ["&&", "||", ";"]
            .iter()
            .filter_map(|op| rest.find(op).map(|i| (i, *op)))
            .min();
        let Some((head, tail)) = next.and_then(|(i, _)| rest.split_at_checked(i)) else {
            out.push((rest.trim(), before, ""));
            return out;
        };
        let op = next.map_or("", |(_, op)| op);
        out.push((head.trim(), before, op));
        (rest, before) = (tail.strip_prefix(op).unwrap_or(tail), op);
    }
}

/// Whether a command failing still fails the line when `||` hands over to `then`.
fn fails_through(then: &str) -> bool {
    let w: Vec<&str> = then.split_whitespace().collect();
    matches!(w.as_slice(), ["false"]) || matches!(w.as_slice(), ["exit", n] if *n != "0")
}

/// The commands of `line` whose failure fails it.
fn failing(line: &str) -> Vec<&str> {
    let parts = split(line);
    parts
        .iter()
        .enumerate()
        .filter(|(i, (_, before, after))| {
            *before != "||"
                && (*after != "||" || parts.get(i + 1).is_some_and(|n| fails_through(n.0)))
        })
        .map(|(_, (c, _, _))| *c)
        .collect()
}

/// Whether the words' program, past `env` and `VAR=x` assignments, is `cargo`.
fn runs_cargo(words: &[&str]) -> bool {
    words
        .iter()
        .find(|w| **w != "env" && (!w.contains('=') || w.starts_with('-')))
        .is_some_and(|w| *w == "cargo")
}

/// Whether a quote opened in `c` is left unclosed: `c` is a piece of a quoted string.
fn unbalanced(c: &str) -> bool {
    ['"', '\''].iter().any(|q| c.matches(*q).count() % 2 == 1)
}

/// Whether the command `c` is `want` or `want` with further arguments, exercising its signal.
fn runs(c: &str, want: &[&str]) -> bool {
    if unbalanced(c) {
        return false;
    }
    let mut words: Vec<&str> = c.split_whitespace().collect();
    if let Some(first) = words.first_mut() {
        *first = first.strip_prefix('@').unwrap_or(first);
    }
    words.starts_with(want)
        && runs_cargo(&words)
        && !words
            .iter()
            .any(|w| REFUSED.contains(w) || w.ends_with('&') || w.contains('|'))
}

/// Whether one of `line`'s commands whose failure fails it runs the command `want`.
pub(super) fn runs_in(line: &str, want: &str) -> bool {
    let want: Vec<&str> = want.split_whitespace().collect();
    !want.is_empty() && failing(line).iter().any(|c| runs(c, &want))
}
