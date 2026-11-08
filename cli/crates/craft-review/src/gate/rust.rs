//! The Rust gate (`rustGate` in `lib/review-profiles.mjs`, its deterministic part): clippy on each
//! changed package with the project's own lint levels — a compile error or a lint the project
//! denies is red, a warning on a line the change added a `clippy` seed — then a pedantic and
//! nursery pass whose new warnings there are `clippy-pedantic` seeds, then semgrep with the
//! repository's own rules over the changed files, each result a `semgrep` seed.

use std::path::Path;

use super::Status;
use super::check::{Acc, Cx};
use super::clippy::{gate_check, pedantic};
use super::semgrep::semgrep;

/// At most this many packages are linted; the rest are named.
const PACKAGES_MAX: usize = 6;

/// The Rust gate over `cx`.
pub(super) fn gate(cx: &Cx<'_>, acc: &mut Acc) {
    let manifests = manifests(cx);
    if manifests.is_empty() {
        acc.parts
            .push("clippy: no Cargo package holds the changed files".into());
    }
    if manifests.len() > PACKAGES_MAX {
        let rest: Vec<&str> = manifests
            .iter()
            .skip(PACKAGES_MAX)
            .map(String::as_str)
            .collect();
        acc.notes.push(format!(
            "clippy ran on the first {PACKAGES_MAX} of {} changed packages; not on: {}",
            manifests.len(),
            rest.join(", ")
        ));
    }
    let manifests: Vec<&String> = manifests.iter().take(PACKAGES_MAX).collect();
    for m in &manifests {
        let s = gate_check(cx, acc, m);
        acc.check(s);
    }
    // Seeds only, on what built: a pass the budget cuts short is named and skipped.
    if acc.status == Some(Status::Pass) {
        let before = acc.seeds.len();
        let ran = manifests.iter().filter(|m| pedantic(cx, acc, m)).count();
        acc.parts.push(format!(
            "the pedantic and nursery pass (`-- -W clippy::pedantic -W clippy::nursery`) on {ran} package(s): {} seed(s)",
            acc.seeds.len() - before
        ));
    }
    semgrep(cx, acc);
}

/// The manifest of each package holding a changed file: its nearest `Cargo.toml` below the top.
fn manifests(cx: &Cx<'_>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in cx.files {
        let found = Path::new(f).ancestors().skip(1).find_map(|d| {
            let m = d.join("Cargo.toml");
            cx.top.join(&m).is_file().then(|| m.display().to_string())
        });
        if let Some(m) = found.filter(|m| !out.contains(m)) {
            out.push(m);
        }
    }
    out
}
