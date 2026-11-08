//! The Rust gate (`rustGate` in `lib/review-profiles.mjs`, its deterministic part): clippy on each
//! changed package with the project's own lint levels — a compile error or a lint the project
//! denies is red, a warning on a line the change added a `clippy` seed — then a pedantic and
//! nursery pass whose new warnings there are `clippy-pedantic` seeds, then semgrep with the
//! repository's own rules over the changed files, each result a `semgrep` seed.

use std::path::Path;

use serde_json::Value;

use super::Status;
use super::check::{Acc, Cx, Seed, last_line};

/// At most this many packages are linted; the rest are named.
const PACKAGES_MAX: usize = 6;
/// At most this many red diagnostics are listed per package.
const ERRORS_MAX: usize = 5;
/// The repository rule directories semgrep reads, as the engine's `./semgrep/` and craft's own.
const SEMGREP_DIRS: [&str; 2] = ["semgrep", ".semgrep"];

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
        let ran = manifests
            .iter()
            .filter(|m| clippy(cx, acc, m, true).is_some())
            .count();
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

/// One diagnostic of clippy's JSON output: its level, lint, message and primary place.
struct Diag {
    level: String,
    code: String,
    message: String,
    file: String,
    line: u32,
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
                line: span
                    .get("line_start")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .unwrap_or(0),
            })
        })
        .collect()
}

/// The extra lint levels of the pedantic pass.
const PEDANTIC: [&str; 5] = ["--", "-W", "clippy::pedantic", "-W", "clippy::nursery"];

/// One clippy run on `manifest`, the pedantic pass when `pedantic`, each warning on a line the
/// change added a seed: what the run's diagnostics are, `None` when it gave none to read.
fn clippy(
    cx: &Cx<'_>,
    acc: &mut Acc,
    manifest: &str,
    pedantic: bool,
) -> Option<(bool, Vec<Diag>, String)> {
    let mut args = vec![
        "clippy",
        "--manifest-path",
        manifest,
        "--all-targets",
        "--message-format=json",
        "--locked",
    ];
    if pedantic {
        args.extend(PEDANTIC);
    }
    let label = format!(
        "`cargo clippy --manifest-path {manifest} --all-targets{}`",
        if pedantic {
            " -- -W clippy::pedantic -W clippy::nursery"
        } else {
            ""
        }
    );
    let (ok, out, err) = acc.exited(&label, "cargo", cx.runner.run(cx.top, "cargo", &args))?;
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
        if let Some(file) = cx.changed(&d.file).filter(|f| cx.lines.touches(f, d.line)) {
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

/// The gate's clippy run on `manifest`: red on a compile error or a lint the project denies, its
/// warnings seeds.
fn gate_check(cx: &Cx<'_>, acc: &mut Acc, manifest: &str) -> Status {
    let label = format!("`cargo clippy --manifest-path {manifest} --all-targets`");
    let Some((ok, all, err)) = clippy(cx, acc, manifest, false) else {
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

/// semgrep with the repository's own rules over the changed Rust files, when it keeps any.
fn semgrep(cx: &Cx<'_>, acc: &mut Acc) {
    let dirs: Vec<&str> = SEMGREP_DIRS
        .into_iter()
        .filter(|d| cx.top.join(d).is_dir())
        .collect();
    let files = cx.present(".rs");
    if dirs.is_empty() || files.is_empty() {
        acc.notes.push("semgrep: no repository rules (semgrep/ or .semgrep/) or no changed Rust file — skipped".into());
        return;
    }
    let mut args = vec!["scan", "--json", "--metrics=off", "--quiet"];
    for d in &dirs {
        args.extend(["--config", d]);
    }
    let label = format!("`semgrep {}`", args.join(" "));
    args.extend(files);
    let Some((_, out, err)) =
        acc.exited(&label, "semgrep", cx.runner.run(cx.top, "semgrep", &args))
    else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&out) else {
        acc.parts.push(format!("{label}: unreadable output"));
        acc.notes
            .push(format!("{label} printed no JSON: {}", last_line(&err)));
        return;
    };
    let results = v
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in &results {
        let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_owned();
        let extra = r.get("extra");
        let severity = match s(extra.and_then(|e| e.get("severity"))).as_str() {
            "ERROR" => "High",
            "WARNING" => "Medium",
            _ => "Low",
        };
        let line = r
            .pointer("/start/line")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0);
        let (path, rule, message) = (
            s(r.get("path")),
            s(r.get("check_id")),
            s(extra.and_then(|e| e.get("message"))),
        );
        if let Some(file) = cx.changed(&path) {
            acc.seed(
                cx,
                &Seed {
                    tool: "semgrep",
                    rule: &rule,
                    severity,
                    title: &message,
                    file,
                    line,
                    rule_id: "",
                },
            );
        }
    }
    acc.parts
        .push(format!("{label}: {} result(s)", results.len()));
}
