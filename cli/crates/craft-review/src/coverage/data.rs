//! Data, not source: a file the general profile takes but its per-file lenses do not read (realm
//! @nick/craft, node #625). Pure data only — JSON and its kin, CSV, lockfiles, snapshots, and any
//! file under a fixtures or test-data directory — is judged by the profile's whole-diff lenses
//! (intent, compat, invariants, negative-space, which read a format change as the contract it is)
//! and by its security lens, never sliced or read by correctness, errors and the other per-file
//! lenses. Configuration (YAML, TOML, INI, env, XML, properties) is no data: it carries behaviour,
//! and every lens reads it. Told by the file's kind, not by a repository's layout: craft reviews
//! repositories it never sees.

/// Extensions of pure data.
#[rustfmt::skip]
const DATA_EXT: &[&str] = &[
    "json", "jsonc", "json5", "jsonl", "ndjson", "geojson", "har", "csv", "tsv", "lock", "snap",
];
/// Lockfiles whose extension says nothing of it.
const LOCK_NAMES: &[&str] = &["pnpm-lock.yaml", "go.sum", "go.work.sum"];
/// Directories whose files are data a test reads, whatever their extension.
const FIXTURE_DIRS: &[&str] = &[
    "fixtures",
    "__fixtures__",
    "testdata",
    "test-data",
    "test_data",
    "__snapshots__",
];

/// Whether `f` is data rather than source.
#[must_use]
pub fn is_data(f: &str) -> bool {
    let lower = f.to_ascii_lowercase();
    let mut segs: Vec<&str> = lower.split('/').collect();
    let base = segs.pop().unwrap_or("");
    let ext = base.rsplit_once('.').map_or("", |(_, e)| e);
    DATA_EXT.contains(&ext)
        || LOCK_NAMES.contains(&base)
        || segs.iter().any(|d| FIXTURE_DIRS.contains(d))
}

#[cfg(test)]
mod tests {
    use super::is_data;

    #[test]
    fn pure_data_is_told_by_kind_not_by_path_and_configuration_is_no_data() {
        for f in [
            "content/parity/plan-cases.json",
            "data/rows.csv",
            "Cargo.lock",
            "web/pnpm-lock.yaml",
            "yarn.lock",
            "package-lock.json",
            "go.sum",
            "go.work.sum",
            "web/__snapshots__/app.test.ts.snap",
            "tests/fixtures/bad.js",
            "pkg/testdata/input.go",
            "x/__fixtures__/a.ts",
        ] {
            assert!(is_data(f), "{f}");
        }
        for f in [
            "src/main.py",
            "web/app.ts",
            "lib/json.rs",
            "yaml/parse.go",
            "src/fixture.rs",
            "Makefile",
            "fixtures.py",
            "config/app.YAML",
            "pnpm-workspace.yaml",
            "go.mod",
            ".github/workflows/ci.yml",
            "settings.toml",
            ".env",
            "api/schema.xml",
            "app.properties",
        ] {
            assert!(!is_data(f), "{f}");
        }
    }
}
