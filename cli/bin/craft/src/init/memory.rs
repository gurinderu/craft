//! The project memory's `external` records proposed as integration points — the owner's decision on
//! realm @nick/craft node #470, option (a). The binary reads no memory store itself: the session
//! recalls the records with the craft:memory skill and pipes them in (`--memory-externals -`), and
//! `lib/craft-externals.mjs memory` reads each one's revision from its version file and pattern,
//! or takes the version stated, as a review reads it (node #431). Each candidate carries its
//! system, its source and that revision, and the `--point` that writes it; the reviewer confirms
//! it. Nothing here fails the proposal: a missing plugin root, node or readable list is named.

use std::io::Read;
use std::path::Path;

use anyhow::Result;
use craft_review::project::IntegrationPoint;
use serde_json::{Value, json};

use super::{externals, ran};

/// What the session handed in.
pub(super) enum Recalled {
    /// No `--memory-externals`.
    None,
    Records(Value),
    /// Stdin held no JSON: why.
    Unreadable(String),
}

/// The records `--memory-externals -` hands in on stdin.
///
/// # Errors
/// When the flag names anything but `-`, or stdin cannot be read.
pub(super) fn recalled(flag: Option<&str>) -> Result<Recalled> {
    let Some(flag) = flag else {
        return Ok(Recalled::None);
    };
    anyhow::ensure!(
        flag == "-",
        "--memory-externals takes only \"-\" (the records as JSON on stdin)"
    );
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    Ok(match serde_json::from_str(&text) {
        Ok(v) => Recalled::Records(v),
        Err(e) => Recalled::Unreadable(format!("--memory-externals: stdin is not JSON ({e})")),
    })
}

/// The records as a list: the list itself, or the one an object holds under `externals` or
/// `records`; none otherwise.
pub(super) fn listed(recalled: &Recalled) -> Vec<Value> {
    let Recalled::Records(v) = recalled else {
        return Vec::new();
    };
    let list = v
        .as_array()
        .or_else(|| v.get("externals").and_then(Value::as_array))
        .or_else(|| v.get("records").and_then(Value::as_array));
    list.cloned().unwrap_or_default()
}

/// The memory's records as candidates over the repository at `cwd`, each with the `--point` that
/// writes it and the revision the profile `held` names for its system, if any.
pub(super) fn import(
    root: Option<&Path>,
    cwd: &Path,
    recalled: &Recalled,
    held: &[IntegrationPoint],
) -> Value {
    let records = match recalled {
        Recalled::None => {
            return json!({"ran": false, "why": "no memory records given: recall the project's `external` records with the craft:memory skill and pipe them in with --memory-externals -"});
        }
        Recalled::Unreadable(why) => return json!({"ran": false, "why": why}),
        Recalled::Records(v) => v,
    };
    let mut answer = ran(externals(root, cwd, &["memory"], records));
    let candidates = answer.get_mut("candidates").and_then(Value::as_array_mut);
    for c in candidates.into_iter().flatten() {
        annotate(c, held);
    }
    answer
}

/// Adds to candidate `c` its `--point`, why that point would be refused, and the profile's own
/// revision of its system.
fn annotate(c: &mut Value, held: &[IntegrationPoint]) {
    let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let (system, repo, rev) = (text("system"), text("repo"), text("ref"));
    let point = format!("{system}={repo}@{rev}");
    let refused = IntegrationPoint::parse(&point).err();
    let profile = held
        .iter()
        .find(|p| p.name == system)
        .map(|p| p.rev.clone());
    if let Some(o) = c.as_object_mut() {
        o.insert("point".into(), Value::from(point));
        if let Some(why) = refused {
            o.insert("refused".into(), Value::from(why));
        }
        o.insert("profileRef".into(), json!(profile));
    }
}
