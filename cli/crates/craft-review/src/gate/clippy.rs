//! clippy as the Rust gate runs it: one run per changed package with the project's own lint
//! levels — a compile error or a lint the project denies is red, a warning on a line the change
//! added a `clippy` seed — and the pedantic and nursery pass, whose warnings there are
//! `clippy-pedantic` seeds; each diagnostic placed from the package it was reported in.

use std::path::Path;

use serde_json::Value;

use super::Status;
use super::check::{Acc, Cx, Seed, last_line};
use super::lock::Lockfiles;

/// A package clippy lints: its manifest, repository-relative, and its name when it is linted alone
/// (`-p`, a run scoped to it).
pub(super) struct Package {
    pub manifest: String,
    pub name: Option<String>,
}

impl Package {
    /// How clippy is pointed at it: `--manifest-path`, and `-p` with its name.
    fn args(&self) -> Vec<&str> {
        let mut args = vec!["--manifest-path", self.manifest.as_str()];
        if let Some(n) = &self.name {
            args.extend(["-p", n.as_str()]);
        }
        args
    }
}

/// At most this many red diagnostics are listed per package.
const ERRORS_MAX: usize = 5;

/// One diagnostic of clippy's JSON output: its level, lint, message and primary place.
struct Diag {
    level: String,
    code: String,
    message: String,
    file: String,
    line: u32,
    /// The manifest of the package it was reported in.
    manifest: String,
}

/// The compiler messages of `out`, each with a primary span.
fn diags(out: &str) -> Vec<Diag> {
    out.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("reason").and_then(Value::as_str) == Some("compiler-message"))
        .filter_map(|v| {
            let m = v.get("message")?;
            let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
            let span = m
                .get("spans")?
                .as_array()?
                .iter()
                .find(|s| s.get("is_primary") == Some(&Value::Bool(true)))?;
            Some(Diag {
                level: s(m, "level"),
                code: m.get("code").map(|c| s(c, "code")).unwrap_or_default(),
                message: s(m, "message"),
                file: s(span, "file_name"),
                manifest: s(&v, "manifest_path"),
                line: span
                    .get("line_start")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .unwrap_or(0),
            })
        })
        .collect()
}

/// The changed file a diagnostic is at. rustc names it from the workspace root, the package's
/// directory or one above it, so each is tried from the package up to the top; without a package
/// named, the path as a changed file's own or its tail.
fn place<'a>(cx: &'a Cx<'_>, d: &Diag) -> Option<&'a str> {
    let package = Path::new(&d.manifest)
        .parent()
        .filter(|_| !d.manifest.is_empty());
    let mut roots = package
        .into_iter()
        .flat_map(Path::ancestors)
        .take_while(|a| a.starts_with(cx.top));
    roots
        .find_map(|root| cx.exact(&root.join(&d.file)))
        .or_else(|| cx.changed(&d.file))
}

/// The extra lint levels of the pedantic pass.
const PEDANTIC: [&str; 5] = ["--", "-W", "clippy::pedantic", "-W", "clippy::nursery"];

/// One clippy run on `manifest`, the pedantic pass when `pedantic`, each warning on a line the
/// change added a seed: what the run's diagnostics are, `None` when it gave none to read.
fn clippy(
    cx: &Cx<'_>,
    acc: &mut Acc,
    package: &Package,
    pedantic: bool,
) -> Option<(bool, Vec<Diag>, String)> {
    let mut args = vec!["clippy"];
    args.extend(package.args());
    args.extend(["--all-targets", "--message-format=json"]);
    if pedantic {
        args.extend(PEDANTIC);
    }
    let label = format!(
        "`cargo clippy {} --all-targets{}`",
        package.args().join(" "),
        if pedantic {
            " -- -W clippy::pedantic -W clippy::nursery"
        } else {
            ""
        }
    );
    let ran = {
        let _kept = Lockfiles::keep(cx.top, &package.manifest);
        cx.runner.run(cx.top, "cargo", &args)
    };
    let (ok, out, err) = acc.exited(&label, "cargo", ran)?;
    if !ok
        && (err.contains("no such command: `clippy`")
            || err.contains("cargo-clippy` is not installed"))
    {
        acc.missing(&label, "clippy");
        return None;
    }
    let all = diags(&out);
    let tool = if pedantic {
        "clippy-pedantic"
    } else {
        "clippy"
    };
    for d in all.iter().filter(|d| d.level == "warning") {
        if let Some(file) = place(cx, d).filter(|f| cx.lines.touches(f, d.line)) {
            acc.seed(
                cx,
                &Seed {
                    tool,
                    rule: &d.code,
                    severity: "Low",
                    title: &d.message,
                    file,
                    line: d.line,
                    rule_id: "",
                },
            );
        }
    }
    Some((ok, all, err))
}

/// The pedantic and nursery pass on `package`, its warnings seeds: whether it ran.
pub(super) fn pedantic(cx: &Cx<'_>, acc: &mut Acc, package: &Package) -> bool {
    clippy(cx, acc, package, true).is_some()
}

/// The gate's clippy run on `package`: red on a compile error or a lint the project denies, its
/// warnings seeds.
pub(super) fn gate_check(cx: &Cx<'_>, acc: &mut Acc, package: &Package) -> Status {
    let label = format!("`cargo clippy {} --all-targets`", package.args().join(" "));
    let manifest = &package.manifest;
    let Some((ok, all, err)) = clippy(cx, acc, package, false) else {
        return Status::Unknown;
    };
    let red: Vec<&Diag> = all.iter().filter(|d| d.level == "error").collect();
    if !red.is_empty() {
        acc.parts.push(format!("{label}: red"));
        for d in red.iter().take(ERRORS_MAX) {
            acc.failed.push(format!(
                "clippy ({manifest}): {} at {}:{}",
                d.message, d.file, d.line
            ));
        }
        let more = red.len().saturating_sub(ERRORS_MAX);
        if more > 0 {
            acc.failed
                .push(format!("clippy ({manifest}): and {more} more error(s)"));
        }
        return Status::Fail;
    }
    if !ok {
        acc.parts.push(format!("{label}: did not finish"));
        acc.notes.push(format!(
            "{label} exited non-zero with no compiler error — the build signal is unknown: {}",
            last_line(&err)
        ));
        return Status::Unknown;
    }
    acc.parts.push(format!("{label}: pass"));
    Status::Pass
}
