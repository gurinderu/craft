//! The crates outside the workspace at a checkout's top: every dependency its `Cargo.toml` files
//! name that is not one of its own packages, as the structural search's [`Externals`].

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

use super::super::source;
use super::Hit;
use super::paths::Externals;
use super::stream::{Ended, Format, stream_as};
use crate::cancel::Cancel;

/// How many manifests are read.
const MANIFESTS_MAX: usize = 500;

/// The dependency tables a manifest names crates in.
const TABLES: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];

/// The external crates of the workspace at `top`; a manifest that cannot be read or parsed adds
/// none, so only the standard crates are known then.
pub(in crate::consumers) fn externals(
    top: &Path,
    (deadline, cancel): (Instant, &Cancel),
) -> Externals {
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
        Ok(_) | Err(_) => Vec::new(),
    };
    let (mut deps, mut own) = (BTreeSet::new(), BTreeSet::new());
    for f in files {
        let Ok(Some(text)) = source::read_within(top, &f.file) else {
            continue;
        };
        let Ok(doc) = text.parse::<toml::Table>() else {
            continue;
        };
        read(&doc, &mut deps, &mut own);
    }
    Externals::of(deps.difference(&own).cloned().collect::<Vec<_>>())
}

/// The dependencies `doc` names (its own tables, `[workspace]`'s and each `[target.*]`'s) and the
/// package it is, each as code spells it.
fn read(doc: &toml::Table, deps: &mut BTreeSet<String>, own: &mut BTreeSet<String>) {
    let name = doc
        .get("package")
        .and_then(|p| p.get("name"))
        .and_then(toml::Value::as_str);
    own.extend(name.map(|n| n.replace('-', "_")));
    let targets = doc.get("target").and_then(toml::Value::as_table);
    let scopes = std::iter::once(Some(doc))
        .chain(std::iter::once(
            doc.get("workspace").and_then(toml::Value::as_table),
        ))
        .chain(
            targets
                .into_iter()
                .flat_map(|t| t.values().map(toml::Value::as_table)),
        )
        .flatten();
    for scope in scopes {
        for table in TABLES.iter().filter_map(|t| scope.get(*t)?.as_table()) {
            deps.extend(table.keys().map(|k| k.replace('-', "_")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::read;
    use std::collections::BTreeSet;

    #[test]
    fn a_manifest_s_dependencies_and_its_own_package_are_read() {
        let doc: toml::Table = "[package]\nname = \"my-lib\"\n[dependencies]\nserde-json = \"1\"\nmy_core = { path = \"../core\" }\n[target.'cfg(unix)'.dev-dependencies]\nnix = \"0.31\"\n[workspace.dependencies]\ntokio = \"1\"\n"
            .parse()
            .unwrap();
        let (mut deps, mut own) = (BTreeSet::new(), BTreeSet::new());
        read(&doc, &mut deps, &mut own);
        assert_eq!(
            deps.into_iter().collect::<Vec<_>>(),
            ["my_core", "nix", "serde_json", "tokio"]
        );
        assert_eq!(own.into_iter().collect::<Vec<_>>(), ["my_lib"]);
    }
}
