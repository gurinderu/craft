//! Why a tool failed, read from the end of its stderr: cargo's root cause, or the final `error:`
//! line a tool printed, before its last line.

use super::check::last_line;

/// The final `error:` line of a tool's stderr, its indent trimmed; `None` when it printed none.
pub(super) fn final_error(err: &str) -> Option<&str> {
    err.lines()
        .map(str::trim)
        .rfind(|l| l.starts_with("error: "))
}

/// Why cargo failed: the first line of its last `Caused by:` block — the root of its error chain —
/// else its final `error:` line, else its last line. A cause cargo wraps onto a continuation line
/// keeps its first line, which names the cause; the continuation alone does not.
pub(super) fn cargo_why(err: &str) -> String {
    let lines: Vec<&str> = err.lines().map(str::trim).collect();
    let cause = lines
        .iter()
        .rposition(|l| *l == "Caused by:")
        .and_then(|i| lines.get(i + 1..)?.iter().find(|l| !l.is_empty()).copied());
    cause
        .or_else(|| final_error(err))
        .map_or_else(|| last_line(err), |l| l.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A registry without a token, as cargo 1.94 printed it for a dependency of a private registry.
    const NO_TOKEN: &str = "    Updating `fluence` index
error: failed to get `crd-api-contracts` as a dependency of package `vodopad v0.17.0 (/w/vodopad)`

Caused by:
  failed to load source for dependency `crd-api-contracts`

Caused by:
  unable to update registry `fluence`

Caused by:
  no token found for `fluence`, please run `cargo login --registry fluence`
  or use environment variable CARGO_REGISTRIES_FLUENCE_TOKEN
";

    #[test]
    fn cargo_names_the_root_of_its_error_chain_not_its_continuation_line() {
        assert_eq!(
            cargo_why(NO_TOKEN),
            "no token found for `fluence`, please run `cargo login --registry fluence`"
        );
    }

    #[test]
    fn without_a_cause_the_final_error_then_the_last_line() {
        assert_eq!(
            cargo_why("   Compiling a\nerror: could not compile `a`\nnote: see above\n"),
            "error: could not compile `a`"
        );
        assert_eq!(cargo_why("warning: x\nsignal 9\n"), "signal 9");
        assert_eq!(cargo_why(""), "no message");
    }
}
