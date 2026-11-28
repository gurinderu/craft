//! The commands a gate line may run, and the arguments that would turn one into a runner of inline code.

/// Exactly the commands the justfile's recipes run today, each as it is spelled there. The tools reached
/// through `node_modules/.bin` (the justfile puts it on PATH): prettier, eslint, vitest, depcruise and knip.
pub const COMMANDS: [&str; 12] = [
    "cd",
    "cargo",
    "node",
    "npm",
    "npx",
    "python3",
    "prettier",
    "eslint",
    "vitest",
    "depcruise",
    "knip",
    "integrations/opencode/plugin/node_modules/.bin/tsc",
];

/// The command a word names, if the gate may run it.
pub fn command(word: &str, plain: bool) -> Result<&'static str, String> {
    if !plain {
        return Err(format!("the quoted or expanded command `{word}`"));
    }
    if is_assignment(word) {
        return Err(format!(
            "the environment assignment `{word}` where a command goes"
        ));
    }
    COMMANDS
        .iter()
        .find(|c| **c == word)
        .copied()
        .ok_or_else(|| {
            format!(
                "`{word}` is not one of the gate's commands ({})",
                COMMANDS.join(", ")
            )
        })
}

/// An argument of `command` that would make it run code written in the line, or another command line.
pub fn argument(command: &str, word: &str) -> Result<(), String> {
    let refused = match command {
        "node" => is_flag(
            word,
            &[
                "-e",
                "--eval",
                "-p",
                "--print",
                "-r",
                "--require",
                "--import",
            ],
            "epr",
        ),
        "python3" => is_flag(word, &["-c"], "c"),
        "npm" | "npx" => is_flag(word, &["-c", "--call"], "c"),
        _ => false,
    };
    if refused {
        return Err(format!("`{command} {word}` runs code written in the line"));
    }
    Ok(())
}

/// `NAME=value`: a word that sets an environment variable when it stands where a command goes.
fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        name.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// One of `long` (also as `--flag=value`), or a cluster of short flags holding one of `short`.
fn is_flag(word: &str, long: &[&str], short: &str) -> bool {
    let flag = word.split_once('=').map_or(word, |(f, _)| f);
    if long.contains(&flag) {
        return true;
    }
    word.strip_prefix('-')
        .filter(|rest| !rest.starts_with('-'))
        .is_some_and(|cluster| {
            cluster.chars().all(|c| c.is_ascii_alphabetic())
                && cluster.contains(|c| short.contains(c))
        })
}

#[cfg(test)]
mod tests;
