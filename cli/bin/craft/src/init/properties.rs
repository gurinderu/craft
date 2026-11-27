//! The `[project]` section `craft init` shows, offers and writes as the reviewer confirmed it
//! (realm @nick/craft, node #654): what the profile holds, as the flags a write takes it back by,
//! and what the repository's tracked files offer, each with the files it was read from.

use std::path::Path;

use anyhow::{Result, anyhow};
use craft_review::project::properties::{self, Properties, propose};
use serde_json::{Value, json};

/// Whether the project publishes a library, as `--library` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum YesNo {
    Yes,
    No,
}

/// The flags that write the `[project]` section: neither of them, the scout's answer alone.
#[derive(Debug, Clone, Default, clap::Args)]
pub struct ProjectArgs {
    /// Whether the project is a published library, over the scout's guess either way.
    #[arg(
        long = "library",
        conflicts_with = "propose",
        value_enum,
        value_name = "YES|NO"
    )]
    pub library: Option<YesNo>,
    /// A rule file the lenses are handed, repository-relative, over the scout's; repeatable.
    #[arg(long = "rule", conflicts_with = "propose", value_name = "PATH")]
    pub rules: Vec<String>,
    /// The project holds controllers: the reconciler lens runs on every change.
    #[arg(long = "controllers", conflicts_with = "propose")]
    pub controllers: bool,
    /// Where security lives, a path or Cargo-style glob: a change under it is security-sensitive;
    /// repeatable.
    #[arg(
        long = "security-path",
        conflicts_with = "propose",
        value_name = "GLOB"
    )]
    pub security_paths: Vec<String>,
    /// A contract file beside those craft knows, a path or glob: a change to it takes the compat
    /// lens; repeatable.
    #[arg(long = "contract", conflicts_with = "propose", value_name = "GLOB")]
    pub contracts: Vec<String>,
}

/// The section the flags name, a path named twice or empty refused.
pub fn confirmed(args: &ProjectArgs) -> Result<Properties> {
    for (flag, list) in [
        ("--rule", &args.rules),
        ("--security-path", &args.security_paths),
        ("--contract", &args.contracts),
    ] {
        for (i, p) in list.iter().enumerate() {
            if p.trim().is_empty() {
                return Err(anyhow!("{flag}: an empty path"));
            }
            if list.iter().take(i).any(|q| q == p) {
                return Err(anyhow!("{flag} {p}: named twice"));
            }
        }
    }
    Ok(Properties {
        library: args.library.map(|l| l == YesNo::Yes),
        rules: (!args.rules.is_empty()).then(|| args.rules.clone()),
        controllers: args.controllers,
        security_paths: args.security_paths.clone(),
        contracts: args.contracts.clone(),
    })
}

/// What `--propose` says of the section: what the profile holds and the flags that write it again,
/// or why it could not be read; and what the repository's files offer, or why they could not be
/// listed.
pub fn proposed(top: Option<&Path>, profile: &Path) -> Value {
    let (held, unread) = match properties::of(profile) {
        Ok(p) => (p, None),
        Err(e) => (Properties::new(), Some(e.to_string())),
    };
    let (offered, offered_unread) = match top.map(propose::of_repo) {
        Some(Ok(o)) => (Some(o), None),
        Some(Err(e)) => (None, Some(e.to_string())),
        None => (None, Some("not a git checkout".to_owned())),
    };
    json!({
        "held": held,
        "flags": flags(&held),
        "unread": unread,
        "offered": offered,
        "offeredUnread": offered_unread,
    })
}

/// What a write says it wrote: the section and the flags that write it again.
pub fn written(p: &Properties) -> Value {
    json!({"held": p, "flags": flags(p)})
}

/// The flags that write `p` again.
fn flags(p: &Properties) -> Vec<String> {
    let mut out = Vec::new();
    let mut each = |flag: &str, list: &[String]| {
        for v in list {
            out.extend([flag.to_owned(), v.clone()]);
        }
    };
    if let Some(l) = p.library {
        each("--library", &[if l { "yes" } else { "no" }.to_owned()]);
    }
    each("--rule", p.rules.as_deref().unwrap_or_default());
    each("--security-path", &p.security_paths);
    each("--contract", &p.contracts);
    if p.controllers {
        out.push("--controllers".to_owned());
    }
    out
}
