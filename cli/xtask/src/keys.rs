//! The checks a command line names, as keys: `script:<package.json script>`, `file:integrations/shared/<x>.mjs`,
//! `recipe:<justfile recipe>`, `xtask:<cargo xtask command>` and `cmd:<a known command>`.

use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;

/// Commands named by a plain substring.
const KNOWN_COMMANDS: [&str; 5] = [
    "npm ci",
    "npm audit",
    "semgrep",
    "cargo",
    "plugin validate . --strict",
];

pub struct Keys {
    npm: Regex,
    node: Regex,
    just: Regex,
    xtask: Regex,
    /// `(name, body)`, the longest body first.
    scripts: Vec<(String, String)>,
}

impl Keys {
    pub fn new(scripts: &BTreeMap<String, String>) -> Result<Self, regex::Error> {
        let mut by_length: Vec<(String, String)> = scripts
            .iter()
            .map(|(n, b)| (n.clone(), b.clone()))
            .filter(|(_, b)| !b.is_empty())
            .collect();
        by_length.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
        Ok(Self {
            npm: Regex::new(r"\bnpm (?:run (?:--silent )?([\w:-]+)|(test)\b)")?,
            node: Regex::new(r"\bnode (integrations/shared/[\w.-]+\.mjs)")?,
            just: Regex::new(r"\bjust ([A-Za-z_][\w-]*)")?,
            xtask: Regex::new(r"\bcargo xtask ([\w-]+)")?,
            scripts: by_length,
        })
    }

    /// The keys `text` names, a script by its name or by its command anywhere in `text`.
    pub fn of(&self, text: &str) -> BTreeSet<String> {
        let mut keys = self.named(text);
        // Longest body first, each match removed: `knip --no-progress` must not match inside
        // `knip --no-progress --production`.
        let mut rest = text.to_owned();
        for (name, body) in &self.scripts {
            if rest.contains(body.as_str()) {
                keys.insert(format!("script:{name}"));
                rest = rest.replace(body.as_str(), " ");
            }
        }
        keys
    }

    /// Whether `package.json` has the script `name`.
    pub fn has_script(&self, name: &str) -> bool {
        self.scripts.iter().any(|(n, _)| n == name)
    }

    /// Every key but a script spelled out.
    fn named(&self, text: &str) -> BTreeSet<String> {
        let mut keys = BTreeSet::new();
        for m in self.npm.captures_iter(text) {
            if let Some(name) = m.get(1).or_else(|| m.get(2)) {
                keys.insert(format!("script:{}", name.as_str()));
            }
        }
        captured(&self.node, text, "file", &mut keys);
        captured(&self.just, text, "recipe", &mut keys);
        captured(&self.xtask, text, "xtask", &mut keys);
        for cmd in KNOWN_COMMANDS {
            if text.contains(cmd) {
                keys.insert(format!("cmd:{cmd}"));
            }
        }
        keys
    }

    /// The keys a script's body names, empty for a script package.json does not have.
    pub fn of_script(&self, name: &str) -> BTreeSet<String> {
        self.scripts
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, body)| self.of(body))
            .unwrap_or_default()
    }
}

fn captured(re: &Regex, text: &str, kind: &str, keys: &mut BTreeSet<String>) {
    for m in re.captures_iter(text) {
        if let Some(value) = m.get(1) {
            keys.insert(format!("{kind}:{}", value.as_str()));
        }
    }
}

#[cfg(test)]
mod tests;
