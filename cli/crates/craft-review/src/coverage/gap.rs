//! What a run that did review code still left out, as `materialUncovered`, `coverageGapFiles`,
//! `isAncillaryConfig` and `uncoveredNotRunNote` in `lib/review-coverage.mjs`: the changed files no
//! profile covers that carry something to review, and of them the ones that void a green verdict —
//! all but project configuration and build recipes, which no lens ever claimed to read.

use super::is_inert;

#[rustfmt::skip]
const ANCILLARY_NAMES: &[&str] = &[
    "dockerfile", "containerfile", "justfile", "makefile", "gnumakefile", "procfile", "vagrantfile",
    "deny.toml", "rustfmt.toml", "clippy.toml", "rust-toolchain.toml", "rust-toolchain",
    ".editorconfig", ".dockerignore", ".npmrc", ".nvmrc", ".prettierrc", ".eslintrc",
    "codecov.yml", "renovate.json", "dependabot.yml", ".pre-commit-config.yaml",
];
const ANCILLARY_DIRS: &[&str] = &[
    ".github",
    ".gitlab",
    ".circleci",
    ".woodpecker",
    ".buildkite",
];
/// How many files the note names before it counts the rest.
const SHOWN: usize = 5;

/// Whether a changed file is project configuration or a build recipe: reported as not reviewed,
/// but no hole in the review of the code.
#[must_use]
pub fn is_ancillary(f: &str) -> bool {
    let lower = f.to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or("");
    let dirs: Vec<&str> = lower.split('/').collect();
    let in_ci_dir = dirs
        .split_last()
        .is_some_and(|(_, d)| d.iter().any(|s| ANCILLARY_DIRS.contains(s)));
    ANCILLARY_NAMES.contains(&base) || in_ci_dir || base.ends_with(".dockerfile")
}

/// The changed files `covers` leaves out that carry something to review, in diff order.
pub fn uncovered(files: &[String], covers: impl Fn(&str) -> bool) -> Vec<String> {
    files
        .iter()
        .filter(|f| !covers(f) && !is_inert(f))
        .cloned()
        .collect()
}

/// Of the uncovered files, those whose absence voids a green verdict.
#[must_use]
pub fn gap(uncovered: &[String]) -> Vec<String> {
    uncovered
        .iter()
        .filter(|f| !is_ancillary(f))
        .cloned()
        .collect()
}

/// What the verdict says of a gap: how many files went unreviewed, the first few by name.
#[must_use]
pub fn note(gap: &[String]) -> String {
    let shown = gap
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let more = gap
        .len()
        .checked_sub(SHOWN)
        .filter(|n| *n > 0)
        .map_or_else(String::new, |n| format!(", +{n} more"));
    format!(
        "{} changed file(s) matched no language profile and were NOT reviewed ({shown}{more})",
        gap.len()
    )
}

#[cfg(test)]
mod tests {
    use super::{gap, is_ancillary, note, uncovered};

    fn owned(files: &[&str]) -> Vec<String> {
        files.iter().map(|f| (*f).to_owned()).collect()
    }

    #[test]
    fn configuration_is_named_narrowly() {
        for f in [
            ".github/workflows/ci.yml",
            "Dockerfile",
            "build/app.dockerfile",
            "clippy.toml",
            "sub/.GitLab/x.yml",
        ] {
            assert!(is_ancillary(f), "{f}");
        }
        for f in [
            "src/main.py",
            "github/x.yml",
            "scripts/build.sh",
            "Makefile.in",
        ] {
            assert!(!is_ancillary(f), "{f}");
        }
    }

    #[test]
    fn uncovered_files_leave_out_the_covered_and_the_inert_and_the_gap_leaves_out_config() {
        let files = owned(&[
            "src/lib.rs",
            "README.md",
            "app.py",
            "Cargo.lock",
            "Makefile",
        ]);
        let left = uncovered(&files, |f| f.ends_with(".rs"));
        assert_eq!(left, owned(&["app.py", "Makefile"]));
        assert_eq!(gap(&left), owned(&["app.py"]));
    }

    #[test]
    fn the_note_names_five_files_and_counts_the_rest() {
        assert_eq!(
            note(&owned(&["a.py"])),
            "1 changed file(s) matched no language profile and were NOT reviewed (a.py)"
        );
        let seven = owned(&["a", "b", "c", "d", "e", "f", "g"]);
        assert_eq!(
            note(&seven),
            "7 changed file(s) matched no language profile and were NOT reviewed (a, b, c, d, e, +2 more)"
        );
    }
}
