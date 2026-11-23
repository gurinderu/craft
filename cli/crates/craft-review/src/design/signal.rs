//! The structure signal that admits the `design` lens by itself (realm @nick/craft, node #534):
//! the change adds a module, a crate, a public type or a format. A path and line heuristic over
//! what the diff added, not a parser.

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

/// Data extensions: a new file of one is never a new module.
const DATA_EXT: [&str; 9] = [
    "txt", "json", "yaml", "yml", "toml", "csv", "ini", "lock", "xml",
];
/// Extensions whose every file is a module of its own, wherever it lands.
const MODULE_EXT: [&str; 2] = ["py", "nix"];

/// One profile's part of the change as the signal reads it.
pub(super) struct Part<'a> {
    /// Whether it is the Rust profile's: a new `.rs` file is a new module there.
    pub rust: bool,
    pub files: &'a [String],
    /// The files the change creates.
    pub added: &'a [String],
}

/// What the signal asks of the change and its base.
pub(super) struct Lookups<'a> {
    /// A file's added lines with their numbers.
    pub added_lines: &'a dyn Fn(&str) -> Vec<(u32, String)>,
    /// Whether a directory did not exist at the base.
    pub new_dir: &'a dyn Fn(&str) -> bool,
    /// Whether the base declares a type of this name anywhere: an edited, moved or re-indented
    /// declaration is no new type.
    pub declared: &'a dyn Fn(&str) -> bool,
}

/// Whether the new file `f` of a part that is not Rust's is a module: a `.py` or `.nix` file
/// anywhere, another source file in a directory the base lacked; never a data file.
fn new_module(f: &str, new_dir: &dyn Fn(&str) -> bool) -> bool {
    let e = ext(f);
    !DATA_EXT.contains(&e.as_str()) && (MODULE_EXT.contains(&e.as_str()) || new_dir(dir_of(f)))
}

/// What the new file `f` adds, if it adds structure by itself.
fn added_file(rust: bool, f: &str, new_dir: &dyn Fn(&str) -> bool) -> Option<String> {
    if base(f) == "Cargo.toml" {
        Some(format!("new crate: {f}"))
    } else if is_format(f) {
        Some(format!("new format: {f}"))
    } else if (rust && ext(f) == "rs") || (!rust && new_module(f, new_dir)) {
        Some(format!("new module: {f}"))
    } else {
        None
    }
}

/// Why `part` admits the design lens, one line per thing it adds: a crate (`Cargo.toml`), a
/// format, a module, a public type the base does not declare. Empty: no signal.
pub(super) fn reasons(part: &Part<'_>, ask: &Lookups<'_>) -> Vec<String> {
    let mut out = Vec::new();
    for f in part.files.iter().filter(|f| !is_test_path(f)) {
        if part.added.contains(f) {
            out.extend(added_file(part.rust, f, ask.new_dir));
        }
        let lines = (ask.added_lines)(f);
        for (n, t) in super::types::declared(&ext(f), &lines) {
            if !(ask.declared)(&t) {
                out.push(format!("new public type: {t} at {f}:{n}"));
            }
        }
        for (n, l) in lines.iter().filter(|_| part.rust) {
            if let Some(m) = super::types::inline_module(l) {
                out.push(format!("new module: mod {m} at {f}:{n}"));
            }
        }
    }
    out
}
