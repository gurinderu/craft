//! Data, not source: a file the general profile takes but no code lens of it reads per file
//! (realm @nick/craft, node #625). JSON, YAML, TOML and other data or markup formats, and any file
//! under a fixtures or test-data directory, are judged by the profile's whole-diff lenses — intent,
//! compat, invariants, negative-space, which read a schema or format change as the contract it
//! is — never sliced or read by correctness, security, errors and the other per-file lenses.
//! Told by the file's kind, not by a repository's layout: craft reviews repositories it never sees.

/// Extensions of data and markup formats.
#[rustfmt::skip]
const DATA_EXT: &[&str] = &[
    "json", "jsonc", "json5", "jsonl", "ndjson", "geojson", "yaml", "yml", "toml", "csv", "tsv",
    "xml", "ini", "cfg", "conf", "properties", "env", "plist", "har",
];
/// Directories whose files are data a test reads, whatever their extension.
const FIXTURE_DIRS: &[&str] = &[
    "fixtures",
    "__fixtures__",
    "testdata",
    "test-data",
    "test_data",
];

/// Whether `f` is data rather than source.
#[must_use]
pub fn is_data(f: &str) -> bool {
    let lower = f.to_ascii_lowercase();
    let mut segs: Vec<&str> = lower.split('/').collect();
    let base = segs.pop().unwrap_or("");
    let ext = base.rsplit_once('.').map_or("", |(_, e)| e);
    DATA_EXT.contains(&ext) || segs.iter().any(|d| FIXTURE_DIRS.contains(d))
}

#[cfg(test)]
mod tests {
    use super::is_data;

    #[test]
    fn data_is_told_by_kind_not_by_path() {
        for f in [
            "content/parity/plan-cases.json",
            "config/app.YAML",
            "deploy/values.yml",
            "settings.toml",
            "data/rows.csv",
            "api/schema.xml",
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
        ] {
            assert!(!is_data(f), "{f}");
        }
    }
}
