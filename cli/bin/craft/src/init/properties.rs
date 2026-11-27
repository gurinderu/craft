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
    /// No rule file is handed to the lenses, whatever the scout finds.
    #[arg(long = "no-rules", conflicts_with_all = ["propose", "rules"])]
    pub no_rules: bool,
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

/// `p` as a write keeps it: trimmed, a leading `./` and a trailing `/` dropped.
fn clean(p: &str) -> String {
    let p = p.trim();
    p.strip_prefix("./")
        .unwrap_or(p)
        .trim_end_matches('/')
        .to_owned()
}

/// The paths `list` names under `flag`, each cleaned; one empty or named twice is refused.
fn paths(flag: &str, list: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for p in list {
        let c = clean(p);
        if c.is_empty() {
            return Err(anyhow!("{flag}: an empty path"));
        }
        if out.contains(&c) {
            return Err(anyhow!("{flag} {p}: named twice"));
        }
        out.push(c);
    }
    Ok(out)
}

/// The section the flags name, a path named twice or empty refused.
pub fn confirmed(args: &ProjectArgs) -> Result<Properties> {
    let rules = paths("--rule", &args.rules)?;
    Ok(Properties {
        library: args.library.map(|l| l == YesNo::Yes),
        rules: (args.no_rules || !rules.is_empty()).then_some(rules),
        controllers: args.controllers,
        security_paths: paths("--security-path", &args.security_paths)?,
        contracts: paths("--contract", &args.contracts)?,
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
    let each = |out: &mut Vec<String>, flag: &str, list: &[String]| {
        for v in list {
            out.extend([flag.to_owned(), v.clone()]);
        }
    };
    if let Some(l) = p.library {
        each(
            &mut out,
            "--library",
            &[if l { "yes" } else { "no" }.to_owned()],
        );
    }
    match p.rules.as_deref() {
        Some([]) => out.push("--no-rules".to_owned()),
        rules => each(&mut out, "--rule", rules.unwrap_or_default()),
    }
    each(&mut out, "--security-path", &p.security_paths);
    each(&mut out, "--contract", &p.contracts);
    if p.controllers {
        out.push("--controllers".to_owned());
    }
    out
}
