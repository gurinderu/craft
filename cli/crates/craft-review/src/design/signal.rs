//! The structure signal that admits the `design` lens by itself (realm @nick/craft, node #534):
//! the change adds a module, a crate, a public type or a format. A path and line heuristic over
//! what the diff added, not a parser.

use std::sync::LazyLock;

use regex::Regex;

use crate::gate::lines::header_path;
use crate::paths::is_test_path;

/// A format's own file by its extension: an interface or schema language.
const FORMAT_EXT: [&str; 10] = [
    "proto", "avsc", "avdl", "thrift", "fbs", "capnp", "graphql", "gql", "xsd", "jtd",
];
/// The data extensions a schema is written in when its name or directory says it is one.
const SCHEMA_DATA: [&str; 3] = ["json", "yaml", "yml"];
/// The name prefixes of an API description file.
const API_DESCRIPTIONS: [&str; 3] = ["openapi", "asyncapi", "swagger"];

/// A public type's declaration, in the languages whose spelling says it is public: Rust `pub`,
/// an ES/TS `export`, `public` in the JVM and .NET languages and Swift, Go's capital, a
/// top-level Python class.
static PUBLIC_TYPE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^\s*pub\s+(?:struct|enum|trait|type|union)\s+([A-Za-z_]\w*)",
        r"|^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)",
        r"|^\s*public\s+(?:(?:static|final|abstract|sealed|partial)\s+)*(?:class|interface|record|enum|struct|protocol)\s+([A-Za-z_]\w*)",
        r"|^type\s+([A-Z]\w*)\s+(?:struct|interface)\b",
        r"|^class\s+([A-Za-z]\w*)",
    ))
    .ok()
});

/// An inline Rust module, `mod name {`: the one module no new file carries.
static INLINE_MOD: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{").ok());

/// The files the zero-context `diff` creates (`new file mode`), by their new path; a rename or a
/// copy is not one.
pub(super) fn added_files(diff: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut new = false;
    for l in diff.lines() {
        if l.starts_with("diff --git ") {
            new = false;
        } else if l.starts_with("new file mode ") {
            new = true;
        } else if let Some(rest) = l.strip_prefix("+++ ").filter(|_| new) {
            out.extend(header_path(rest, "b/"));
            new = false;
        }
    }
    out
}

fn base(f: &str) -> &str {
    f.rsplit('/').next().unwrap_or(f)
}

fn ext(f: &str) -> String {
    base(f)
        .rsplit_once('.')
        .map_or(String::new(), |(_, e)| e.to_ascii_lowercase())
}

/// The directory of `f`, `.` at the top.
pub(super) fn dir_of(f: &str) -> &str {
    f.rsplit_once('/').map_or(".", |(d, _)| d)
}

/// Whether `f` is a format's file: an interface or schema language, a `*.schema.<json|yaml>`, a
/// data file under a `schema(s)` directory, or an API description.
pub(super) fn is_format(f: &str) -> bool {
    let (name, ext) = (base(f).to_ascii_lowercase(), ext(f));
    let data = SCHEMA_DATA.contains(&ext.as_str());
    let in_schemas = f
        .split('/')
        .rev()
        .skip(1)
        .any(|d| matches!(d.to_ascii_lowercase().as_str(), "schema" | "schemas"));
    FORMAT_EXT.contains(&ext.as_str())
        || (data
            && (name.contains(".schema.")
                || in_schemas
                || API_DESCRIPTIONS.iter().any(|p| name.starts_with(p))))
}

/// The public type `line` declares, if it declares one.
pub(super) fn public_type(line: &str) -> Option<String> {
    let caps = PUBLIC_TYPE.as_ref()?.captures(line)?;
    caps.iter()
        .skip(1)
        .flatten()
        .next()
        .map(|m| m.as_str().to_owned())
}

/// The inline Rust module `line` opens, a test module aside.
pub(super) fn inline_module(line: &str) -> Option<String> {
    let name = INLINE_MOD.as_ref()?.captures(line)?.get(1)?.as_str();
    let test =
        name == "test" || name == "tests" || name.ends_with("_test") || name.ends_with("_tests");
    (!test).then(|| name.to_owned())
}

/// One profile's part of the change as the signal reads it.
pub(super) struct Part<'a> {
    /// Whether it is the Rust profile's: a new `.rs` file is a new module there; elsewhere a new
    /// source file counts only in a directory the base did not have.
    pub rust: bool,
    pub files: &'a [String],
    /// The files the change creates.
    pub added: &'a [String],
}

/// Why `part` admits the design lens, one line per thing it adds: a crate (`Cargo.toml`), a
/// format, a module, a public type. `added_lines` gives a file's added lines with their numbers;
/// `new_dir` says a directory did not exist at the base. Empty: no signal.
pub(super) fn reasons(
    part: &Part<'_>,
    added_lines: impl Fn(&str) -> Vec<(u32, String)>,
    new_dir: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut out = Vec::new();
    for f in part.files.iter().filter(|f| !is_test_path(f)) {
        let added = part.added.contains(f);
        if added && base(f) == "Cargo.toml" {
            out.push(format!("new crate: {f}"));
        } else if added && is_format(f) {
            out.push(format!("new format: {f}"));
        } else if added && part.rust && ext(f) == "rs" {
            out.push(format!("new module: {f}"));
        } else if added && !part.rust && new_dir(dir_of(f)) {
            out.push(format!(
                "new module: {f}, in the new directory {}",
                dir_of(f)
            ));
        }
        for (n, l) in added_lines(f) {
            if let Some(t) = public_type(&l) {
                out.push(format!("new public type: {t} at {f}:{n}"));
            } else if let Some(m) = inline_module(&l).filter(|_| part.rust) {
                out.push(format!("new module: mod {m} at {f}:{n}"));
            }
        }
    }
    out
}
