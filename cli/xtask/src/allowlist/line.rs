//! One gate line held to the form `crate::allowlist` describes.

/// The one expansion allowed outside quotes: the mutation floor's base, when given.
const FLOOR_BASE: &str = "${1:+--base \"$1\"}";

/// Commands that would run another shell or recipe, out of this reading's sight.
const SHELLS: [&str; 13] = [
    "just", "sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "exec", "source", ".", "env",
    "command",
];

/// Whether `line` is commands joined by `&&`, each words and allowed redirections.
pub(super) fn check_line(line: &str, takes_params: bool) -> Result<(), String> {
    if line.contains("{{") {
        return Err("a just interpolation `{{`".to_owned());
    }
    let line = line.trim();
    if line.starts_with(['-', '@']) {
        return Err("a just `-` or `@` prefix".to_owned());
    }
    let mut rest = line;
    let mut command_next = true;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        if let Some(after) = rest.strip_prefix("&&") {
            if command_next {
                return Err("an empty command beside `&&`".to_owned());
            }
            command_next = true;
            rest = after;
        } else if let Some(after) = redirection(rest) {
            rest = after?;
        } else {
            let (word, plain, after) = shell_word(rest, takes_params)?;
            if word.is_empty() {
                // A lone `&` (or what `redirection` did not take) opens no word.
                return Err(format!("`{}`", rest.chars().next().unwrap_or(' ')));
            }
            if command_next {
                command_word(word, plain)?;
                command_next = false;
            }
            rest = after;
        }
    }
    if command_next {
        return Err("an empty command".to_owned());
    }
    Ok(())
}

/// A command must be a plain word, and not just or another shell.
fn command_word(word: &str, plain: bool) -> Result<(), String> {
    if !plain {
        return Err(format!("the quoted or expanded command `{word}`"));
    }
    let base = word.rsplit('/').next().unwrap_or(word);
    if SHELLS.contains(&base) {
        return Err(format!("`{word}` runs another shell or recipe"));
    }
    Ok(())
}

/// `2>&1`, `>&2` or `>file` at the start of `rest`: what follows it; `None` when `rest` opens no redirection.
fn redirection(rest: &str) -> Option<Result<&str, String>> {
    for fixed in ["2>&1", ">&2"] {
        if let Some(after) = rest
            .strip_prefix(fixed)
            .filter(|a| a.is_empty() || a.starts_with(char::is_whitespace))
        {
            return Some(Ok(after));
        }
    }
    let after = rest.strip_prefix('>')?;
    if after.starts_with(['>', '&', '|']) {
        return Some(Err(
            "a redirection other than `2>&1`, `>&2` and `>file`".to_owned()
        ));
    }
    Some(match shell_word(after.trim_start(), false) {
        Ok((_, true, after)) => Ok(after),
        Ok((file, false, _)) => Err(format!("a redirection to `{file}`, not a plain file name")),
        Err(why) => Err(why),
    })
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_./:=,+@*-".contains(c)
}

/// One shell word at the start of `rest`: `(word, plain, rest after it)`; plain when it has no quote or expansion.
fn shell_word(rest: &str, takes_params: bool) -> Result<(&str, bool, &str), String> {
    let mut end = 0;
    let mut plain = true;
    while let Some(c) = rest.get(end..).and_then(|t| t.chars().next()) {
        let tail = rest.get(end..).unwrap_or_default();
        if c.is_whitespace() || c == '&' || c == '>' {
            break;
        }
        if is_word_char(c) {
            end += c.len_utf8();
            continue;
        }
        plain = false;
        end += match c {
            '\'' => quoted(tail, '\'', |_| Ok(()))?,
            '"' => quoted(tail, '"', |inner| double_quoted(inner, takes_params))?,
            '$' if takes_params && tail.starts_with(FLOOR_BASE) => FLOOR_BASE.len(),
            '$' => return Err(format!("`$` outside `\"$@\"`, `\"$1\"` and `{FLOOR_BASE}`")),
            other => return Err(format!("`{other}`")),
        };
    }
    let (word, after) = rest.split_at(end);
    Ok((word, plain, after))
}

/// The length of the quoted string `tail` opens with `quote`, its inside held to `check`.
fn quoted(
    tail: &str,
    quote: char,
    check: impl Fn(&str) -> Result<(), String>,
) -> Result<usize, String> {
    let inner = tail.get(1..).unwrap_or_default();
    let close = inner
        .find(quote)
        .ok_or_else(|| format!("an unclosed `{quote}`"))?;
    let (inside, _) = inner.split_at(close);
    check(inside)?;
    Ok(inside.len() + 2)
}

fn double_quoted(inside: &str, takes_params: bool) -> Result<(), String> {
    if inside.contains(['`', '\\']) {
        return Err(format!("a backquote or backslash in \"{inside}\""));
    }
    if inside.contains('$') && !(takes_params && (inside == "$@" || inside == "$1")) {
        return Err(format!(
            "`$` in \"{inside}\": only \"$@\" and \"$1\", in a recipe that takes a parameter"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
