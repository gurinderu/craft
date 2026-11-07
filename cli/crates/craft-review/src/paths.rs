//! What a changed path is, as the planner reads it: a test (`lib/test-paths.mjs`) or a contract
//! another version deploys or calls against (`lib/contract-paths.mjs`).

/// Directories whose files are tests or fixtures, never production code or a contract.
const NON_CONTRACT_DIRS: [&str; 7] = [
    "test",
    "tests",
    "__tests__",
    "testdata",
    "fixtures",
    "__fixtures__",
    "__snapshots__",
];

const PROSE_EXT: [&str; 6] = ["md", "mdx", "markdown", "rst", "adoc", "txt"];

/// `p` split on `/` and `\`, with empty and `.` segments dropped and `..` applied, as `pathSegments`.
fn segments(p: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for s in p.split(['/', '\\']) {
        if s.is_empty() || s == "." {
            continue;
        }
        if s == ".." && out.last().is_some_and(|l| *l != "..") {
            out.pop();
            continue;
        }
        out.push(s);
    }
    out
}

fn in_test_dir(dirs: &[&str]) -> bool {
    dirs.iter()
        .any(|s| NON_CONTRACT_DIRS.contains(&s.to_lowercase().as_str()))
}

fn ext(base: &str) -> &str {
    base.rsplit_once('.').map_or("", |(_, e)| e)
}

/// Whether `f` is a test: under a test or fixture directory, or named `*_test.*`, `*.test.*`,
/// `test.*`, `tests.*` or `test_*`.
#[must_use]
pub fn is_test_path(f: &str) -> bool {
    let mut segs = segments(f);
    let base = segs.pop().unwrap_or("").to_lowercase();
    if in_test_dir(&segs) {
        return true;
    }
    let stem = base.rsplit_once('.').map(|(s, _)| s);
    let named = stem.is_some_and(|s| {
        let last = s.rsplit(['.', '_', '-']).next().unwrap_or(s);
        // `(^|[._-])tests?\.[^.]+$`: the last dotted part is the extension alone.
        (last == "test" || last == "tests") && !ext(&base).is_empty()
    });
    named || base.starts_with("test_")
}

/// Whether `files` change production (non-test) code the profile's `globs` cover.
#[must_use]
pub fn changes_production_code(files: &[String], globs: &[String]) -> bool {
    let globs: Vec<&str> = globs
        .iter()
        .map(|g| g.trim_start_matches('\'').trim_end_matches('\''))
        .collect();
    files.iter().any(|f| {
        let base = segments(f).pop().unwrap_or("");
        !is_test_path(f)
            && globs.iter().any(|g| match g.strip_prefix('*') {
                Some(suffix) => base.ends_with(suffix),
                None => base == *g,
            })
    })
}

fn chart_dir(d: &str) -> bool {
    matches!(d.to_lowercase().as_str(), "chart" | "charts" | "helm")
}

fn has_ext(base: &str, exts: &[&str]) -> bool {
    exts.contains(&ext(base).to_lowercase().as_str())
}

/// Whether `dirs`/`base` is one of the contract classes `CONTRACT_PATH_CLASSES` names.
fn contract_class(dirs: &[&str], base: &str) -> bool {
    let lower = base.to_lowercase();
    let yaml_json = has_ext(base, &["yaml", "yml", "json"]);
    let crd_token = lower.split(['.', '_', '-']).any(|t| {
        matches!(
            t,
            "crd" | "crds" | "customresourcedefinition" | "customresourcedefinitions"
        )
    });
    let values = lower
        .strip_prefix("values")
        .is_some_and(|rest| rest.starts_with(['.', '_', '-']))
        && has_ext(base, &["yaml", "yml"]);
    let template = dirs.iter().enumerate().any(|(i, s)| {
        *s == "templates"
            && dirs
                .get(..i)
                .is_some_and(|ds| ds.iter().any(|d| chart_dir(d)))
    });
    dirs.windows(2).any(
        |w| matches!(w, ["crates", next] if *next == "contracts" || next.ends_with("-contracts")),
    ) || dirs.contains(&"crds")
        || (yaml_json && crd_token)
        || matches!(base, "Chart.yaml" | "Chart.yml")
        || (values && (dirs.is_empty() || dirs.iter().any(|d| chart_dir(d))))
        || (has_ext(base, &["yaml", "yml", "tpl"]) && template)
        || ((lower.contains("openapi") || lower.contains("swagger")) && yaml_json)
        || has_ext(
            base,
            &[
                "proto", "graphql", "graphqls", "gql", "avsc", "avdl", "avpr",
            ],
        )
        || lower == "schema.json"
        || lower.ends_with(".schema.json")
        || has_ext(base, &["jsonschema"])
        || dirs.iter().any(|s| {
            matches!(
                s.to_lowercase().as_str(),
                "migration" | "migrations" | "migrate" | "alembic"
            )
        })
        || (dirs.last() == Some(&".claude-plugin") && has_ext(base, &["json"]))
}

/// Whether `f` is a contract or schema path: a chart, CRD, IDL, migration or plugin manifest that
/// other versions are deployed or called against.
#[must_use]
pub fn is_contract_path(f: &str) -> bool {
    let mut segs = segments(f);
    let Some(base) = segs.pop() else {
        return false;
    };
    if has_ext(base, &PROSE_EXT) || in_test_dir(&segs) {
        return false;
    }
    contract_class(&segs, base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tests_are_told_from_production_code() {
        for t in [
            "tests/a.rs",
            "src/a_test.rs",
            "src/a.test.rs",
            "test_a.rs",
            "src/tests.rs",
            "x/fixtures/a.rs",
        ] {
            assert!(is_test_path(t), "{t}");
        }
        for p in ["src/lib.rs", "src/latest.rs", "src/contest.rs"] {
            assert!(!is_test_path(p), "{p}");
        }
        let globs = vec!["'*.rs'".to_owned()];
        assert!(changes_production_code(&["src/lib.rs".into()], &globs));
        assert!(!changes_production_code(
            &["tests/a.rs".into(), "README.md".into()],
            &globs
        ));
    }

    #[test]
    fn contract_paths_are_named() {
        for c in [
            "charts/x/values.yaml",
            "values.yaml",
            "charts/x/templates/d.yaml",
            "Chart.yaml",
            "deploy/crds/a.yaml",
            "api/openapi.yaml",
            "p/a.proto",
            "migrations/1.sql",
            ".claude-plugin/plugin.json",
            "crates/contracts/src/lib.rs",
            "a/foo.schema.json",
            "k/my-crd.yaml",
            "schema.json",
        ] {
            assert!(is_contract_path(c), "{c}");
        }
        for n in [
            "src/lib.rs",
            "docs/openapi.md",
            "tests/migrations/1.sql",
            "values.txt",
            "config/values.yaml",
            "a/myschema.json",
        ] {
            assert!(!is_contract_path(n), "{n}");
        }
    }
}
