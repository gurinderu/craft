//! Whether a failed `nix flake check` was stopped by this machine or its network rather than the
//! change, read from nix's final `error:` line alone: a warning nix retried past, or a check's
//! build log echoing curl, says nothing about why the check failed.
//!
//! The forms are nix's own, observed with nix 2.35.2 (`nix flake check --no-write-lock-file` on a
//! flake with an input its flake.lock did not lock yet — a missing path, a commit GitHub answers
//! 404 for, an unresolvable host, a refused port — and with `NIX_REMOTE` at a socket that does not
//! exist); `gate/nix_tests.rs` replays them. The transfer, TLS and HTTP 5xx/429/403 forms are built
//! on the observed `unable to download '<url>': <why>` shape from curl's and nix's wording.

use super::cause::final_error;
use super::check::last_line;

/// What nix's final error says when this machine, not the change, stopped it.
const MACHINE: [&str; 6] = [
    "experimental Nix feature",
    "error: cannot connect to socket at",
    "lock file '/nix/var/nix/db/big-lock'",
    "SQLite database '/nix/var/nix/db/",
    "while setting up the build environment",
    "sandboxing builds is not supported",
];

/// What follows the URL in nix's `unable to download '<url>': <why>` when the network failed, not
/// the input: curl's error names as nix prints them, transfer and TLS failures included. Any other
/// cause — a missing path, a broken input, `HTTP error 404`, a 403 from anywhere but GitHub's API —
/// is the change's, as nix fails the same way without `--no-write-lock-file`.
const NETWORK: [&str; 13] = [
    "Could not resolve hostname",
    "Couldn't resolve host",
    "Could not resolve proxy",
    "Could not connect to server",
    "Couldn't connect to server",
    "Timeout was reached",
    "Connection timed out",
    "Failure when receiving data from the peer",
    "SSL connect error",
    "Server returned nothing",
    "Recv failure",
    "Send failure",
    "HTTP error 429",
];

/// The line that says why nix failed: its final error line, else its last line.
pub(super) fn nix_why(err: &str) -> String {
    final_error(err).map_or_else(|| last_line(err), |l| l.chars().take(200).collect())
}

/// Whether the network failed the download nix's final error names: a curl failure, a server
/// error, rate limiting (429, or a 403 from GitHub's API).
fn network(line: &str) -> bool {
    let Some((url, why)) = line
        .split_once("unable to download '")
        .and_then(|(_, rest)| rest.split_once("': "))
    else {
        return false;
    };
    let rate_limited = why.starts_with("HTTP error 403") && url.contains("://api.github.com/");
    NETWORK.iter().any(|n| why.starts_with(n)) || why.starts_with("HTTP error 5") || rate_limited
}

/// Whether nix's final error says this machine or its network stopped the check.
pub(super) fn machine_fault(err: &str) -> bool {
    final_error(err).is_some_and(|l| MACHINE.iter().any(|m| l.contains(m)) || network(l))
}
