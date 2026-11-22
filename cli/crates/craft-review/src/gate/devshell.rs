//! Where the Rust gate's cargo runs (realm @nick/craft, node #472; the question it answers, #597):
//! a checkout whose `flake.nix` defines `devShells.<this system>.default` builds inside that dev
//! shell, as its developers do (`nix develop . -c cargo …`, run at the top level) — a build script
//! that needs the shell's native libraries (openssl-sys) fails outside it, and the track would read
//! unknown on every run. Without a flake, without nix, or with no such dev shell, cargo runs as it
//! always did; only a flake's dev shell is entered, never `.envrc` or `shell.nix` alone. The dev
//! shell runs the flake's own `shellHook` too: one more piece of the branch's code the gate runs,
//! so `--no-gate` skips it with the rest. It is probed once per gate, over the one head the gate
//! reviews, and entered only when its clippy is its rustc's (`gate/devshell_toolchain.rs`).

use std::time::Duration;

use super::check::{Acc, Cx};
use super::devshell_toolchain::{Fault, toolchain};
use super::nix_fault::nix_why;
use super::runner::Ran;

/// The flags every nix call of the gate passes, so a nix with flakes off still answers.
const FLAGS: [&str; 2] = ["--extra-experimental-features", "nix-command flakes"];

/// The nix command that runs a program inside the dev shell, as a label spells it.
const DEVELOP: &str =
    "nix --extra-experimental-features 'nix-command flakes' develop --no-write-lock-file . -c ";

/// How long the probe for a dev shell may take: an evaluation of the flake's outputs, not a build.
const PROBE_MAX: Duration = Duration::from_secs(60);

/// Whether the flake's outputs give this system a default dev shell: `true` or `false` on stdout.
const HAS_DEFAULT: &str = "s: builtins.hasAttr builtins.currentSystem s && builtins.hasAttr \"default\" s.${builtins.currentSystem}";

/// What nix says of a flake with no `devShells` output.
const NO_OUTPUT: &str = "does not provide attribute";

/// What, beside no flake, says the project builds in a Nix environment the gate does not enter.
const NOT_ENTERED: [&str; 2] = [".envrc", "shell.nix"];

/// Where cargo runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Shell {
    /// As it always did: no dev shell to enter.
    Outside,
    /// Inside the flake's default dev shell.
    Inside,
    /// The dev shell is there and did not enter, or its clippy is not its rustc's: cargo does not
    /// run, the signal is unknown.
    Broken,
}

impl Shell {
    /// The program and arguments that run `cargo args` here.
    pub(super) fn command<'a>(self, args: &[&'a str]) -> (&'static str, Vec<&'a str>) {
        if self == Self::Outside {
            return ("cargo", args.to_vec());
        }
        ("nix", inside("cargo", args))
    }

    /// What a run's label puts before `cargo`: the exact command it ran by.
    pub(super) fn prefix(self) -> &'static str {
        if self == Self::Outside { "" } else { DEVELOP }
    }
}

/// The arguments of the nix call that runs `program args` inside the dev shell.
pub(super) fn inside<'a>(program: &'a str, args: &[&'a str]) -> Vec<&'a str> {
    let mut all = FLAGS.to_vec();
    all.extend(["develop", "--no-write-lock-file", ".", "-c", program]);
    all.extend(args);
    all
}

/// How the command that runs `program args` in the dev shell is named.
pub(super) fn named(program: &str, args: &[&str]) -> String {
    format!("`{DEVELOP}{program} {}`", args.join(" "))
}

/// Where cargo runs over `cx`: inside the flake's default dev shell when it has one for this
/// system, it enters and its clippy is its rustc's; named when it does not.
pub(super) fn shell(cx: &Cx<'_>, acc: &mut Acc) -> Shell {
    if !cx.top.join("flake.nix").is_file() {
        not_entered(cx, acc);
        return Shell::Outside;
    }
    if !probe(cx, acc) {
        return Shell::Outside;
    }
    let Err(fault) = toolchain(cx) else {
        acc.parts.push(format!(
            "clippy inside the flake's dev shell (`{}`, its shellHook, if any, ran)",
            DEVELOP.trim_end()
        ));
        return Shell::Inside;
    };
    let (part, why) = match fault {
        Fault::Ran {
            cmd,
            ran: Ran::TimedOut(d),
        } => (
            format!("{cmd}: timed out"),
            format!("{cmd} timed out after {}s entering it", d.as_secs()),
        ),
        Fault::Ran { cmd, ran } => (
            format!("{cmd}: did not enter"),
            format!("{cmd} failed: {}", why(&ran)),
        ),
        Fault::NoClippy(seen) => (
            "the flake's dev shell: no clippy matching its rustc".to_owned(),
            format!(
                "it has no clippy matching its rustc ({seen}): a clippy-driver of another toolchain fails the workspace's crates (E0514)"
            ),
        ),
    };
    acc.parts.push(part);
    acc.notes.push(format!(
        "the checkout's flake defines a dev shell for this system and {why} — clippy did not run, the Rust signal is unknown, not a failure"
    ));
    Shell::Broken
}

/// Notes the Nix environment a checkout with no flake names, which the gate does not enter.
fn not_entered(cx: &Cx<'_>, acc: &mut Acc) {
    let found: Vec<&str> = NOT_ENTERED
        .into_iter()
        .filter(|f| cx.top.join(f).is_file())
        .collect();
    if !found.is_empty() {
        acc.notes.push(format!(
            "the checkout has {} and no flake.nix: the gate enters only a flake's dev shell, so clippy ran outside it",
            found.join(" and ")
        ));
    }
}

/// Whether the flake gives this system a default dev shell; a probe that could not tell is noted
/// and read as none.
fn probe(cx: &Cx<'_>, acc: &mut Acc) -> bool {
    let mut args = FLAGS.to_vec();
    args.extend([
        "eval",
        "--json",
        // `builtins.currentSystem`, which a pure evaluation does not have.
        "--impure",
        "--no-write-lock-file",
        ".#devShells",
        "--apply",
        HAS_DEFAULT,
    ]);
    let ran = cx.runner.run_within(cx.top, "nix", &args, PROBE_MAX);
    match &ran {
        Ran::Exited { ok: true, out, .. } => return out.trim() == "true",
        Ran::Exited { err, .. } if err.contains(NO_OUTPUT) => return false,
        Ran::Missing => acc.notes.push(
            "the checkout has a flake.nix and nix is not installed: clippy ran outside its dev shell".into(),
        ),
        Ran::Exited { .. } | Ran::TimedOut(_) | Ran::Broken(_) => acc.notes.push(format!(
            "whether the checkout's flake defines a dev shell could not be read (`nix eval .#devShells`): {} — clippy ran outside it",
            why(&ran)
        )),
    }
    false
}

/// Why a nix call came to nothing, in one line.
fn why(ran: &Ran) -> String {
    match ran {
        Ran::Exited { code, err, .. } => format!(
            "exit {}, {}",
            code.map_or_else(|| "by a signal".into(), |c| c.to_string()),
            nix_why(err)
        ),
        Ran::Missing => "nix is not installed".into(),
        Ran::TimedOut(d) => format!("timed out after {}s", d.as_secs()),
        Ran::Broken(e) => e.clone(),
    }
}
