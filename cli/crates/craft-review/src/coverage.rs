//! The coverage exits a run takes before any lens, as `resolveCoverage` and the exits of
//! `lib/review-coverage-phase.mjs` decide them from the changed files alone: an empty diff and a
//! diff whose reviewable files no profile takes (project configuration alone, once the general
//! profile takes every other file carrying code) are INCOMPLETE, never an Approve; a diff of
//! nothing but prose, assets, lockfiles and generated output is an honest green.

use serde::{Deserialize, Serialize};

use crate::git::Diff;

mod assign;
mod gap;

pub use assign::{assign, supported};
pub use gap::{gap, is_ancillary, is_project_config, note, uncovered};

/// A run that ended before any lens ran: its verdict, the line under it, and the files it lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exit {
    pub verdict: String,
    /// The verdict line as the report shows it.
    pub line: String,
    /// What a not-run entry says, when the exit is a gap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_run: Option<String>,
    /// The heading of the changed files the report lists, when it lists them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listed: Option<String>,
}

#[rustfmt::skip]
const INERT_EXT: &[&str] = &[
    "md", "markdown", "rst", "adoc", "svg", "png", "jpg", "jpeg", "gif", "ico", "webp", "pdf",
    "woff", "woff2", "ttf", "otf",
];
#[rustfmt::skip]
/// Inert by name, `.txt` ones included only by name, and lockfiles by the names they have.
const INERT_NAMES: &[&str] = &[
    "license", "licence", "notice", "codeowners", ".gitignore", ".gitattributes", "license.txt",
    "licence.txt", "notice.txt", "copying.txt", "authors.txt", "contributors.txt", "changelog.txt",
    "changes.txt", "readme.txt", "robots.txt", "humans.txt", "todo.txt", "notes.txt",
    "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
    "bun.lock", "cargo.lock", "flake.lock", "poetry.lock", "pdm.lock", "uv.lock", "pipfile.lock",
    "gemfile.lock", "composer.lock", "go.sum", "deno.lock", "mix.lock", "pubspec.lock",
    "podfile.lock", "packages.lock.json", "gradle.lockfile", "cabal.project.freeze", "conan.lock",
    "herd.lock",
];
const GENERATED_DIRS: &[&str] = &["__generated__", "generated", "node_modules", "vendor"];
#[rustfmt::skip]
const GENERATED_SUFFIXES: &[&str] = &[
    ".snap", ".min.js", ".min.css", ".min.mjs", ".min.cjs", ".pb.go", ".pb.cc", ".pb.h", ".pb.rs",
    ".pb.ts", "_pb2.py", "_pb2_grpc.py", ".gen.go", ".gen.rs", ".gen.ts", ".g.dart",
];

/// Whether a changed file carries nothing to review, as `isInertUncovered`: prose and asset
/// extensions, inert names and lockfiles, and generated output whose path says so. In doubt, a
/// file is material.
#[must_use]
pub fn is_inert(f: &str) -> bool {
    let lower = f.to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or("");
    let ext = base.rsplit_once('.').map_or("", |(_, e)| e);
    let dirs: Vec<&str> = lower.split('/').collect();
    let in_generated = dirs
        .split_last()
        .is_some_and(|(_, d)| d.iter().any(|s| GENERATED_DIRS.contains(s)));
    let generated_file =
        GENERATED_SUFFIXES.iter().any(|s| base.ends_with(s)) || generated_infix(base);
    INERT_EXT.contains(&ext) || INERT_NAMES.contains(&base) || in_generated || generated_file
}

/// `*.generated.<ext>`: a generator's own stamp.
fn generated_infix(base: &str) -> bool {
    base.rsplit_once('.').is_some_and(|(stem, ext)| {
        stem.ends_with(".generated")
            && !ext.is_empty()
            && ext.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// Whether two shas name the same commit, as `baseIsHead`.
fn same_commit(a: &str, b: &str) -> bool {
    let hex = |s: &str| (7..=40).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_hexdigit());
    let (a, b) = (a.trim().to_lowercase(), b.trim().to_lowercase());
    hex(&a) && hex(&b) && (a.starts_with(&b) || b.starts_with(&a))
}

const NO_CHANGED_FILES: &str = "NOTHING WAS REVIEWED — the diff came back EMPTY: no changed file was detected against the resolved base. Either there is genuinely nothing to review here (an already-merged branch, or a `path` scope that matches nothing) or the base/scope is wrong and detection failed. No lens ran, so this is not an approval — check the base and re-run.";
const ON_TRUNK: &str = "NOTHING WAS REVIEWED — HEAD IS the resolved base: this checkout has no commit of its own beyond the trunk (the review ran on the trunk itself, or on a branch not yet ahead of it), so the diff against the trunk is empty by construction. Re-run it from the branch's own checkout or worktree, or pass `base` naming what to compare against. No lens ran, so this is not an approval.";

/// The exit `diff` takes when no profile covers any of its files, `None` when one covers one.
/// `lang` names what the profiles review ([`supported`]). `explicit_base`: the caller named the
/// base, so HEAD at it is their choice, not a launch on the trunk.
#[must_use]
pub fn exit(diff: &Diff, covered: usize, lang: &str, explicit_base: bool) -> Option<Exit> {
    if covered > 0 {
        return None;
    }
    let files = &diff.files;
    if files.is_empty() {
        let on_trunk = !explicit_base && same_commit(&diff.merge_base, &diff.head);
        let msg = if on_trunk { ON_TRUNK } else { NO_CHANGED_FILES };
        return Some(Exit {
            verdict: "INCOMPLETE (empty diff)".into(),
            line: format!("⚠️ INCOMPLETE — {msg}"),
            not_run: Some(msg.into()),
            listed: None,
        });
    }
    let material = files.iter().filter(|f| !is_inert(f)).count();
    if material == 0 {
        let msg = format!(
            "NOTHING NEEDED REVIEWING — all {} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.",
            files.len()
        );
        return Some(Exit {
            verdict: "Approve (nothing to review)".into(),
            line: format!("✅ Approve (NOTHING TO REVIEW) — {msg}"),
            not_run: None,
            listed: Some("Not reviewed (nothing reviewable in them)".into()),
        });
    }
    let msg = format!(
        "NOTHING WAS REVIEWED — none of the {} changed file(s) match a supported language profile (this engine reviews {lang}), and {material} of them carry reviewable content that therefore went unreviewed. This is not an approval: no lens ran and no finding could have been produced.",
        files.len()
    );
    Some(Exit {
        verdict: "INCOMPLETE (no language profile)".into(),
        line: format!("⚠️ INCOMPLETE — {msg}"),
        not_run: Some(msg),
        listed: Some("Not reviewed (no language profile)".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::is_inert;

    #[test]
    fn inert_files_are_named_narrowly() {
        for f in [
            "README.md",
            "docs/a.PNG",
            "Cargo.lock",
            "LICENSE",
            "src/notes.txt",
            "vendor/x/y.rs",
            "a/generated/b.rs",
            "x.pb.rs",
            "web/app.min.js",
            "api.generated.ts",
            "fonts/a.otf",
        ] {
            assert!(is_inert(f), "{f}");
        }
        for f in [
            "src/lib.rs",
            "CMakeLists.txt",
            "requirements.txt",
            "src/lock.rs",
            "generated.rs",
            "main.py",
        ] {
            assert!(!is_inert(f), "{f}");
        }
    }
}
