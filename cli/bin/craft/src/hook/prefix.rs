//! The words before a simple command's own that run it: the shell's keywords, `!` and `{`,
//! `NAME=value` assignments, and the prefix commands `env`, `sudo`, `time`, `command`, `nohup` and
//! `rtk`, each with its options.

/// Words that run the command after them: the shell's keywords, `!`, `{`, and prefix commands.
const PREFIXES: &[&str] = &[
    "rtk", "then", "do", "else", "elif", "if", "while", "until", "{", "!", "command", "nohup",
];

/// The words from the command itself on, the prefixes before it and their options passed over.
pub fn after_prefixes(words: &[String]) -> &[String] {
    let mut i = 0;
    while let Some(w) = words.get(i) {
        let rest = words.get(i + 1..).unwrap_or_default();
        i += 1 + match w.as_str() {
            "env" => options(
                rest,
                &["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
            ),
            "sudo" => options(
                rest,
                &["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"],
            ),
            "time" => options(rest, &[]),
            w if PREFIXES.contains(&w) || is_assignment(w) => 0,
            _ => return words.get(i..).unwrap_or_default(),
        };
    }
    words.get(i..).unwrap_or_default()
}

/// How many of `rest`'s leading words are options (`with_arg` ones taking the next word too),
/// a `--` included.
pub fn options(rest: &[String], with_arg: &[&str]) -> usize {
    let mut n = 0;
    while let Some(w) = rest.get(n) {
        if w == "--" {
            return n + 1;
        }
        if !w.starts_with('-') || w == "-" {
            break;
        }
        n += if with_arg.contains(&w.as_str()) { 2 } else { 1 };
    }
    n.min(rest.len())
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        name.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}
