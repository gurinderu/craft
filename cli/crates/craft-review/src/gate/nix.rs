//! The Nix gate (`nixGate` in `lib/review-profiles.mjs`, its deterministic part): `nix flake
//! check` when the repository is a flake — red is a gate failure, unless what stopped it is this
//! machine (no network, flakes off), which leaves the signal unknown — then statix (anti-idioms)
//! and deadnix (dead bindings) on the changed `.nix` files, each diagnostic on a line the change
//! added a seed (`MNT-001`, Low). With no flake the linters are the gate and must run: give a
//! well-formed answer (`gate/nix_answer.rs`).

use super::Status;
use super::check::{Acc, Cx};
use super::nix_fault::{machine_fault, nix_why};
use super::nix_lint::{STATIX, deadnix, statix};

/// The Nix gate over `cx`. With no `flake.nix` its linters are the whole gate: both run clean is
/// nothing to gate, one that did not run or broke leaves the signal unknown (realm @nick/craft,
/// node #487). With a flake, `nix flake check` alone sets it.
pub(super) fn gate(cx: &Cx<'_>, acc: &mut Acc) {
    let flake = cx.top.join("flake.nix").is_file();
    let s = flake_check(cx, acc, flake);
    acc.check(s);
    let files = cx.present(".nix");
    if files.is_empty() {
        return;
    }
    let not_run = lint(cx, acc, &files);
    if !flake && !not_run.is_empty() {
        acc.notes.push(format!(
            "with no flake.nix the linters are the Nix gate, and {} gave no well-formed answer here — its signal is unknown, not a pass",
            not_run.join(" and ")
        ));
        acc.check(Status::Unknown);
    }
}

/// statix and deadnix on `files`; the linters that gave no well-formed answer on all of them.
/// statix is local in the provenance only when it ran on every file: what stopped it on one has
/// already named its own state, which wins.
fn lint(cx: &Cx<'_>, acc: &mut Acc, files: &[&str]) -> Vec<&'static str> {
    let mut not_run = Vec::new();
    if files.iter().all(|f| statix(cx, acc, f)) {
        acc.parts.push(format!("{STATIX}: local"));
    } else {
        not_run.push("statix");
    }
    if !deadnix(cx, acc, files) {
        not_run.push("deadnix");
    }
    not_run
}

/// `nix flake check` at the top level, when there is a `flake.nix`.
fn flake_check(cx: &Cx<'_>, acc: &mut Acc, flake: bool) -> Status {
    if !flake {
        acc.parts.push("nix flake check: no flake.nix".into());
        return Status::Nothing;
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
    if machine_fault(&err) {
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
