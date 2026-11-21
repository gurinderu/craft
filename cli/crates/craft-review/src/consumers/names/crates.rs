//! The packages of the workspace at a checkout's top, each with the crates its own `Cargo.toml`
//! depends on, as the structural search's [`Workspace`]: a path is external only to a crate that
//! depends on its root (realm @nick/craft, #564).

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

use super::super::source;
use super::Hit;
use super::stream::{Ended, Format, stream_as};
use super::unit::{Package, Workspace};
use crate::cancel::Cancel;

/// How many manifests are read.
const MANIFESTS_MAX: usize = 500;

/// The dependency tables a manifest names crates in.
const TABLES: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];

/// The packages of the workspace at `top`; a manifest that cannot be read or parsed adds none, so
/// its files are read as of no package then; when the manifests cannot be listed (past
/// [`MANIFESTS_MAX`], a failed listing, the deadline or a stop) the workspace is unread, saying why.
pub(in crate::consumers) fn workspace(
    top: &Path,
    (deadline, cancel): (Instant, &Cancel),
) -> Workspace {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(top).args([
        "ls-files",
        "-z",
        "--full-name",
        "--",
        ":(glob)**/Cargo.toml",
    ]);
    let paths = Format {
        sep: 0,
        parse: |p| {
            (!p.is_empty()).then(|| Hit {
                file: p.to_owned(),
                line: 0,
                text: String::new(),
            })
        },
        max: MANIFESTS_MAX,
    };
    let files = match stream_as(cmd, paths, deadline, cancel) {
        Ok(Ended::Exited(Some(0), hits, _)) => hits,
        Ok(Ended::Capped) => {
            return Workspace::not_read(format!("over {MANIFESTS_MAX} manifests, none read"));
        }
        Ok(Ended::Exited(_, _, err)) => {
            return Workspace::not_read(format!("the manifests not listed: {}", err.trim()));
        }
        Err(why) => return Workspace::not_read(format!("the manifests not listed: {why}")),
    };
    let mut packages = Vec::new();
    for f in files {
        let Ok(Some(text)) = source::read_within(top, &f.file) else {
            continue;
        };
        let Ok(doc) = text.parse::<toml::Table>() else {
            continue;
        };
        let dir = f.file.strip_suffix("Cargo.toml").unwrap_or_default();
        let dir = dir.trim_end_matches('/');
        packages.extend(read(&doc, dir).map(|mut p| {
            p.has_lib |= top.join(dir).join("src/lib.rs").is_file();
            p
        }));
    }
    Workspace::of(packages)
}

/// The package `doc`, the manifest in `dir`, declares: its library's name (a library target when
/// it names `[lib]`) and the crates its own
/// tables and each `[target.*]`'s depend on, each as code spells it; `None` for a manifest with
/// no `[package]` (a virtual workspace's).
fn read(doc: &toml::Table, dir: &str) -> Option<Package> {
    let name = doc.get("package")?.get("name")?.as_str()?;
    let lib = doc
        .get("lib")
        .and_then(|l| l.get("name"))
        .and_then(toml::Value::as_str)
        .unwrap_or(name);
    let targets = doc.get("target").and_then(toml::Value::as_table);
    let scopes = std::iter::once(Some(doc))
        .chain(
            targets
                .into_iter()
                .flat_map(|t| t.values().map(toml::Value::as_table)),
        )
        .flatten();
    let mut deps = BTreeSet::new();
    for scope in scopes {
        for table in TABLES.iter().filter_map(|t| scope.get(*t)?.as_table()) {
            deps.extend(table.keys().map(|k| k.replace('-', "_")));
        }
    }
    Some(Package {
        dir: dir.to_owned(),
        lib: lib.replace('-', "_"),
        has_lib: doc.contains_key("lib"),
        deps,
    })
}

#[cfg(test)]
mod tests {
    use super::read;

    fn doc(text: &str) -> toml::Table {
        text.parse().unwrap()
    }

    #[test]
    fn a_manifest_s_own_dependencies_and_its_library_are_read() {
        let my = doc(
            "[package]\nname = \"my-lib\"\n[dependencies]\nserde-json = \"1\"\nmy_core = { path = \"../core\" }\n[target.'cfg(unix)'.dev-dependencies]\nnix = \"0.31\"\n[workspace.dependencies]\ntokio = \"1\"\n",
        );
        let p = read(&my, "crates/my").unwrap();
        assert_eq!(
            p.deps.into_iter().collect::<Vec<_>>(),
            ["my_core", "nix", "serde_json"]
        );
        assert_eq!((p.dir.as_str(), p.lib.as_str()), ("crates/my", "my_lib"));
        let renamed = doc("[package]\nname = \"a\"\n[lib]\nname = \"b_c\"\n");
        assert_eq!(read(&renamed, "").unwrap().lib, "b_c");
        assert!(read(&doc("[workspace]\nmembers = [\"a\"]\n"), "").is_none());
    }
}
