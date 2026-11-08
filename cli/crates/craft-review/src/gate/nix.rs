//! The Nix gate (`nixGate` in `lib/review-profiles.mjs`, its deterministic part): `nix flake
//! check` when the repository is a flake — red is a gate failure, unless what stopped it is this
//! machine (no network, flakes off), which leaves the signal unknown — then statix (anti-idioms)
//! and deadnix (dead bindings) on the changed `.nix` files, each diagnostic on a line the change
//! added a seed (`MNT-001`, Low).

use super::Status;
use super::check::{Acc, Cx, last_line};
use super::nix_lint::{STATIX, deadnix, statix};
// The messages below are nix's own, observed with nix 2.35.2 (`nix flake check
// --no-write-lock-file` on a flake with an input its flake.lock did not lock yet — a missing path,
// a commit GitHub answers 404 for, an unresolvable host, a refused port — and with `NIX_REMOTE` at
// a socket that does not exist); `gate/nix_tests.rs` replays them verbatim.

/// What a failed `nix flake check` says when this machine, not the change, stopped it. Each is an
/// error line nix prints itself, not text a failing check could echo from its build log.
const ENVIRONMENT: [&str; 6] = [
    "experimental Nix feature",
    "error: cannot connect to socket at",
    "lock file '/nix/var/nix/db/big-lock'",
    "SQLite database '/nix/var/nix/db/",
    "while setting up the build environment",
    "sandboxing builds is not supported",
];

/// What follows the URL in nix's own `unable to download '<url>': <why>` when the network failed,
/// not the input: curl's error names as nix prints them. Any other cause — `HTTP error 404` for a
/// mistyped rev, a missing path, a broken input — is the change's, as nix fails the same way
/// without `--no-write-lock-file`.
const NETWORK: [&str; 7] = [
    "Could not resolve hostname",
    "Couldn't resolve host",
    "Could not resolve proxy",
    "Could not connect to server",
    "Couldn't connect to server",
    "Timeout was reached",
    "Connection timed out",
];

/// Whether nix's own download line says the network failed.
fn network_fault(err: &str) -> bool {
    err.split("unable to download '").skip(1).any(|rest| {
        rest.split_once("': ")
            .is_some_and(|(_, why)| NETWORK.iter().any(|n| why.starts_with(n)))
    })
}

/// The line that says why nix failed: its last error line, else its last line.
fn nix_why(err: &str) -> String {
    err.lines()
        .map(str::trim)
        .rfind(|l| l.starts_with("error: "))
        .map_or_else(|| last_line(err), |l| l.chars().take(200).collect())
}

/// The Nix gate over `cx`.
pub(super) fn gate(cx: &Cx<'_>, acc: &mut Acc) {
    let s = flake_check(cx, acc);
    acc.check(s);
    let files = cx.present(".nix");
    if files.is_empty() {
        return;
    }
    let mut ran = false;
    for f in &files {
        if !statix(cx, acc, f) {
            break;
        }
        ran = true;
    }
    if ran {
        acc.parts.push(format!("{STATIX}: local"));
    }
    deadnix(cx, acc, &files);
}

/// `nix flake check` at the top level, when there is a `flake.nix`.
fn flake_check(cx: &Cx<'_>, acc: &mut Acc) -> Status {
    if !cx.top.join("flake.nix").is_file() {
        acc.parts.push("nix flake check: no flake.nix".into());
        return Status::Unknown;
    }
    let args = [
        "--extra-experimental-features",
        "nix-command flakes",
        "flake",
        "check",
        // The review reads the branch, it never edits it: a branch that adds an input leaves its
        // flake.lock as it is.
        "--no-write-lock-file",
    ];
    let label = "`nix flake check --no-write-lock-file`";
    let Some((ok, _, err)) = acc.exited(label, "nix", cx.runner.run(cx.top, "nix", &args)) else {
        return Status::Unknown;
    };
    if ok {
        acc.parts.push(format!("{label}: pass"));
        return Status::Pass;
    }
    let why = nix_why(&err);
    if ENVIRONMENT.iter().any(|e| err.contains(e)) || network_fault(&err) {
        acc.parts.push(format!("{label}: could not run here"));
        acc.notes.push(format!(
            "{label} was stopped by this machine or its network (the daemon, the store, flakes off, DNS, a connection), not the change — its signal is unknown: {why}"
        ));
        return Status::Unknown;
    }
    acc.parts.push(format!("{label}: red"));
    acc.failed.push(format!("nix flake check: {why}"));
    Status::Fail
}
