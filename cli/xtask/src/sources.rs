//! Where the repository names its checks: package.json's scripts, integrations/shared/check-*.mjs, the `run:`
//! commands of CI's `test` job, the command cells of AGENTS.md "Commands" and the justfile's recipes.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use crate::justfile::{self, Recipe};
use crate::keys::Keys;

mod ci;
pub use ci::ci_test_runs;

/// What the repository holds, read once.
pub struct Repo {
    pub scripts: BTreeMap<String, String>,
    pub check_files: Vec<String>,
    pub ci_runs: Vec<String>,
    pub agents_cells: Vec<String>,
    pub recipes: Vec<Recipe>,
    /// The justfile's top-level `set`, `import` and `mod` lines.
    pub directives: Vec<String>,
}

impl Repo {
    pub fn read(root: &Path) -> Result<Self, String> {
        let read =
            |rel: &str| fs::read_to_string(root.join(rel)).map_err(|e| format!("{rel}: {e}"));
        let shared = root.join("integrations/shared");
        let names = fs::read_dir(&shared)
            .map_err(|e| format!("integrations/shared: {e}"))?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok());
        let justfile = read("justfile")?;
        Ok(Self {
            scripts: scripts(&read("package.json")?)?,
            check_files: check_files(names),
            ci_runs: ci_test_runs(&read(".github/workflows/ci.yml")?)?,
            agents_cells: agents_commands(&read("AGENTS.md")?),
            recipes: justfile::recipes(&justfile),
            directives: justfile::directives(&justfile),
        })
    }

    /// Every check the gate must run or exclude.
    pub fn required(&self, keys: &Keys) -> BTreeSet<String> {
        let mut out: BTreeSet<String> =
            self.scripts.keys().map(|s| format!("script:{s}")).collect();
        out.extend(self.check_files.iter().map(|f| format!("file:{f}")));
        out.extend(self.recipes.iter().map(|r| format!("recipe:{}", r.name)));
        for block in &self.ci_runs {
            let found = keys.of(block);
            if found.is_empty() {
                let first = block.trim().lines().next().unwrap_or_default();
                out.insert(format!("ci.yml: an unrecognised command: {first}"));
            }
            out.extend(found);
        }
        for cell in &self.agents_cells {
            out.extend(keys.of(cell));
        }
        out
    }
}

/// package.json's `scripts`.
pub fn scripts(package_json: &str) -> Result<BTreeMap<String, String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(package_json).map_err(|e| format!("package.json: {e}"))?;
    let scripts = value
        .get("scripts")
        .and_then(serde_json::Value::as_object)
        .ok_or("package.json has no scripts")?;
    Ok(scripts
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|b| (k.clone(), b.to_owned())))
        .collect())
}

/// `integrations/shared/check-*.mjs`, tests left out, sorted.
pub fn check_files(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = names
        .filter(|n| n.starts_with("check-") && n.ends_with(".mjs") && !n.ends_with(".test.mjs"))
        .map(|n| format!("integrations/shared/{n}"))
        .collect();
    out.sort();
    out
}

/// The command cell (the last) of each row of AGENTS.md "Commands".
pub fn agents_commands(md: &str) -> Vec<String> {
    let Some((_, section)) = md.split_once("\n## Commands\n") else {
        return Vec::new();
    };
    let section = section.split("\n## ").next().unwrap_or_default();
    section
        .lines()
        .filter(|l| l.starts_with("| ") && !l.starts_with("| What"))
        .filter_map(|l| {
            l.trim_end()
                .strip_suffix('|')
                .and_then(|row| row.rsplit('|').next())
        })
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests;
