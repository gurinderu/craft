//! The Nix gate (`nixGate` in `lib/review-profiles.mjs`, its deterministic part): `nix flake
//! check` when the repository is a flake — red is a gate failure, unless what stopped it is this
//! machine (no network, flakes off), which leaves the signal unknown — then statix (anti-idioms)
//! and deadnix (dead bindings) on the changed `.nix` files, each diagnostic on a line the change
//! added a seed (`MNT-001`, Low).

use super::Status;
use super::check::{Acc, Cx, last_line};
use super::nix_lint::{STATIX, deadnix, statix};

/// What a failed `nix flake check` says when this machine, not the change, stopped it.
const ENVIRONMENT: [&str; 9] = [
    "unable to download",
    "Could not resolve host",
    "Couldn't resolve host",
    "experimental Nix feature",
    "cannot connect to socket",
    "lock file '/nix/var/nix/db/big-lock'",
    "SQLite database '/nix/var/nix/db/",
    "while setting up the build environment",
    "sandboxing builds is not supported",
];

/// What `nix flake check --no-write-lock-file` says when the branch's `flake.lock` lacks an entry
/// its inputs need: a failure then is the unwritten lock's, not established as the change's.
const UNLOCKED: [&str; 3] = [
    "not writing modified lock file",
    "cannot write modified lock file",
    "entry in the lock file",
];

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
    let why = last_line(&err);
    if ENVIRONMENT.iter().any(|e| err.contains(e)) {
        acc.parts.push(format!("{label}: could not run here"));
        acc.notes.push(format!(
            "{label} was stopped by this machine, not the change — its signal is unknown: {why}"
        ));
        return Status::Unknown;
    }
    if UNLOCKED.iter().any(|e| err.contains(e)) {
        acc.parts.push(format!("{label}: not established"));
        acc.notes.push(format!(
            "{label} failed with the branch's flake.lock not locking every input, which the gate does not write — its signal is unknown: {why}"
        ));
        return Status::Unknown;
    }
    acc.parts.push(format!("{label}: red"));
    acc.failed.push(format!("nix flake check: {why}"));
    Status::Fail
}
