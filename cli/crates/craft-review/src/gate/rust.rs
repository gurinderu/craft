//! The Rust gate (`rustGate` in `lib/review-profiles.mjs`, its deterministic part): clippy on each
//! changed package with the project's own lint levels — a compile error or a lint the project
//! denies is red, a warning on a line the change added a `clippy` seed — then a pedantic and
//! nursery pass whose new warnings there are `clippy-pedantic` seeds, then semgrep with the
//! repository's own rules over the changed files, each result a `semgrep` seed. A run scoped to a
//! package's directory (`path`) lints that package alone, by name: per-crate runs of one workspace
//! (rust-audit's) then do not lint each other's packages.

use std::path::Path;

use super::Status;
use super::check::{Acc, Cx};
use super::ci;
use super::clippy::{Package, gate_check, pedantic};
use super::semgrep::semgrep;

/// At most this many packages are linted; the rest are named.
const PACKAGES_MAX: usize = 6;

/// The Rust gate over `cx`.
pub(super) fn gate(cx: &Cx<'_>, acc: &mut Acc) {
    let manifests = packages(cx);
    if manifests.is_empty() {
        acc.parts
            .push("clippy: no Cargo package holds the changed files".into());
        acc.check(Status::Nothing);
    }
    if manifests.len() > PACKAGES_MAX {
        let rest: Vec<&str> = manifests
            .iter()
            .skip(PACKAGES_MAX)
            .map(|p| p.manifest.as_str())
            .collect();
        acc.notes.push(format!(
            "clippy ran on the first {PACKAGES_MAX} of {} changed packages; not on: {}",
            manifests.len(),
            rest.join(", ")
        ));
    }
    let manifests: Vec<&Package> = manifests.iter().take(PACKAGES_MAX).collect();
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
    // After the pedantic pass, which a build CI stands for does not run (realm @nick/craft,
    // node #482).
    if acc.unbuilt && acc.status == Some(Status::Unknown) {
        ci::from_ci(cx, acc);
    }
    semgrep(cx, acc);
}

/// The packages clippy lints: the scope's own when the run is scoped to a package's directory or
/// one inside it, else each package holding a changed file.
fn packages(cx: &Cx<'_>) -> Vec<Package> {
    if let Some(p) = cx.scope.and_then(|s| scoped(cx.top, s)) {
        return vec![p];
    }
    manifests(cx)
        .into_iter()
        .map(|manifest| Package {
            manifest,
            name: None,
        })
        .collect()
}

/// The package holding `scope`: the nearest `Cargo.toml` at or above it, below the top, when it
/// declares a package; `None` when there is none, or when that manifest is a workspace's root
/// (virtual or a package too): the scope may then hold member crates its `-p` would leave unlinted,
/// so each changed package is linted by its manifest instead.
fn scoped(top: &Path, scope: &str) -> Option<Package> {
    let at = top.join(scope);
    let start = if at.is_file() { at.parent()? } else { &at };
    let dir = start
        .ancestors()
        .take_while(|d| d.starts_with(top))
        .find(|d| d.join("Cargo.toml").is_file())?;
    let manifest = dir.join("Cargo.toml");
    let table: toml::Table = toml::from_str(&std::fs::read_to_string(&manifest).ok()?).ok()?;
    if table.contains_key("workspace") {
        return None;
    }
    let name = table.get("package")?.get("name")?.as_str()?.to_owned();
    Some(Package {
        manifest: manifest.strip_prefix(top).ok()?.display().to_string(),
        name: Some(name),
    })
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
