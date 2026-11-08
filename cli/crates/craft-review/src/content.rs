//! The review's knowledge as data (realm @nick/craft, node #452): prompt templates under
//! `content/prompts/` and answer schemas under `content/schemas/`, read here exactly as
//! `lib/content.mjs` reads them for the engines. A template is plain text with `{{name}}`
//! placeholders, rendered in one pass (a value is never itself rendered); a placeholder with no
//! value is an error; a content file's final newline is not part of its text. A schema's
//! `{"$ref": "<file>"}` node is replaced by that sibling schema, itself resolved.
//!
//! The files are compiled into the binary, so a release build carries the content it was built
//! from.

use std::collections::BTreeMap;

use serde_json::Value;

/// The values a template is rendered with, by placeholder name.
pub type Vars = BTreeMap<String, String>;

/// Why content could not be rendered or resolved.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContentError {
    #[error("template placeholder {{{{{0}}}}} has no value")]
    MissingValue(String),
    #[error("schema reference {0} is not known")]
    UnknownRef(String),
    #[error("schema references nest deeper than {0}: a cycle?")]
    TooDeep(usize),
    #[error("no content file {0}")]
    UnknownFile(String),
    #[error("content file {0} is not JSON: {1}")]
    NotJson(String, String),
}

/// `(name, ...)` pairs as [`Vars`].
#[must_use]
pub fn vars<const N: usize>(pairs: [(&str, String); N]) -> Vars {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// The text of a content file: its final newline dropped.
#[must_use]
pub fn content_text(raw: &str) -> &str {
    raw.strip_suffix('\n').unwrap_or(raw)
}

/// `template` with each `{{name}}` replaced by `vars[name]`, in one pass.
///
/// # Errors
/// [`ContentError::MissingValue`] on a placeholder `vars` does not name.
pub fn render(template: &str, vars: &Vars) -> Result<String, ContentError> {
    let mut rest = content_text(template);
    let mut out = String::with_capacity(rest.len());
    while let Some(at) = rest.find("{{") {
        let (before, from) = rest.split_at(at);
        out.push_str(before);
        if let Some((name, len)) = placeholder(from) {
            let value = vars
                .get(name)
                .ok_or_else(|| ContentError::MissingValue(name.to_owned()))?;
            out.push_str(value);
            rest = from.get(len..).unwrap_or_default();
        } else {
            // Not a placeholder here; the regex the engines use retries one character on.
            out.push('{');
            rest = from.get(1..).unwrap_or_default();
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// The name and byte length of the `{{name}}` that `s` starts with, where a name is
/// `[A-Za-z][A-Za-z0-9]*` as in `lib/content.mjs`.
fn placeholder(s: &str) -> Option<(&str, usize)> {
    let body = s.strip_prefix("{{")?;
    let len = body
        .char_indices()
        .find(|&(i, c)| !(c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())))
        .map_or(body.len(), |(i, _)| i);
    if len == 0 {
        return None;
    }
    let (name, tail) = body.split_at(len);
    tail.starts_with("}}").then_some((name, len + 4))
}

/// How deep `$ref`s may nest before resolution gives up; the engines' resolver has no bound and
/// would recurse forever on a cycle.
const MAX_REF_DEPTH: usize = 32;

/// `node` with each `{"$ref": "<file>"}` replaced by `refs[<file>]`, itself resolved.
///
/// # Errors
/// [`ContentError::UnknownRef`] on a reference `refs` lacks; [`ContentError::TooDeep`] on a cycle.
pub fn resolve_refs(node: &Value, refs: &BTreeMap<String, Value>) -> Result<Value, ContentError> {
    resolve_at(node, refs, 0)
}

fn resolve_at(
    node: &Value,
    refs: &BTreeMap<String, Value>,
    depth: usize,
) -> Result<Value, ContentError> {
    if depth > MAX_REF_DEPTH {
        return Err(ContentError::TooDeep(MAX_REF_DEPTH));
    }
    match node {
        Value::Array(items) => items
            .iter()
            .map(|n| resolve_at(n, refs, depth))
            .collect::<Result<_, _>>()
            .map(Value::Array),
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get("$ref") {
                let target = refs
                    .get(r)
                    .ok_or_else(|| ContentError::UnknownRef(r.clone()))?;
                return resolve_at(target, refs, depth + 1);
            }
            map.iter()
                .map(|(k, v)| Ok((k.clone(), resolve_at(v, refs, depth)?)))
                .collect::<Result<_, _>>()
                .map(Value::Object)
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(node.clone()),
    }
}

macro_rules! content_files {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../content/", $path)))),*]
    };
}

/// The content files this crate uses, by their path under `content/`.
const FILES: &[(&str, &str)] = content_files![
    "profiles/rust.json",
    "profiles/nix.json",
    "profiles/general.json",
    "prompts/scout.md",
    "prompts/scout-rules-rust.md",
    "prompts/scout-rules-nix.md",
    "prompts/scout-rules-general.md",
    "prompts/scout-repo-rules.md",
    "prompts/lens.md",
    "prompts/lens-spec.md",
    "prompts/lens-catalogue.md",
    "prompts/lens-rule-id.md",
    "prompts/lens-rule-id-none.md",
    "prompts/lens-mutants.md",
    "prompts/lens-negative-space.md",
    "prompts/lens-negative-space-spec.md",
    "prompts/already-found.md",
    "prompts/repo-rules-line.md",
    "prompts/dedup.md",
    "prompts/lens-briefs/rust-safety.md",
    "prompts/lens-briefs/rust-errors.md",
    "prompts/lens-briefs/rust-concurrency.md",
    "prompts/lens-briefs/rust-performance.md",
    "prompts/lens-briefs/rust-api-idioms.md",
    "prompts/lens-briefs/rust-api-boundary.md",
    "prompts/lens-briefs/rust-reconciler.md",
    "prompts/lens-briefs/rust-failure-windows.md",
    "prompts/lens-briefs/rust-compat.md",
    "prompts/lens-briefs/rust-maintainability.md",
    "prompts/lens-briefs/rust-tests.md",
    "prompts/lens-briefs/rust-intent.md",
    "prompts/lens-briefs/rust-invariants.md",
    "prompts/lens-briefs/rust-negative-space.md",
    "prompts/lens-briefs/nix-purity.md",
    "prompts/lens-briefs/nix-reproducibility.md",
    "prompts/lens-briefs/nix-injection.md",
    "prompts/lens-briefs/nix-packaging.md",
    "prompts/lens-briefs/nix-dev-env.md",
    "prompts/lens-briefs/nix-modules.md",
    "prompts/lens-briefs/nix-maintainability.md",
    "prompts/lens-briefs/nix-intent.md",
    "prompts/lens-briefs/nix-negative-space.md",
    "prompts/lens-briefs/general-correctness.md",
    "prompts/lens-briefs/general-security.md",
    "prompts/lens-briefs/general-money.md",
    "prompts/lens-briefs/general-concurrency.md",
    "prompts/lens-briefs/general-errors.md",
    "prompts/lens-briefs/general-performance.md",
    "prompts/review-rules.md",
    "prompts/dependency-source.md",
    "prompts/verify.md",
    "prompts/verify-head-skeptic.md",
    "prompts/verify-head-tool.md",
    "prompts/verify-gate.md",
    "prompts/verify-exclusion-catalog.md",
    "prompts/verify-shared-exclusions.md",
    "prompts/verify-harm-question.md",
    "prompts/verify-batch.md",
    "prompts/verify-batch-finding.md",
    "prompts/lens-re-review-fixes.md",
    "prompts/lens-re-review-rescan.md",
    "prompts/adjudicate.md",
    "prompts/carry-check.md",
    "prompts/scout-strict.md",
    "prompts/lens-strict-maintainability.md",
    "prompts/memory-recall.md",
    "prompts/red-team.md",
    "prompts/match-judge.md",
    "prompts/rule-judge.md",
    "schemas/scout.schema.json",
    "schemas/dedup.schema.json",
    "schemas/findings.schema.json",
    "schemas/finding-item.schema.json",
    "schemas/verdict.schema.json",
    "schemas/batch-verdict.schema.json",
    "schemas/adjudicate.schema.json",
    "schemas/changed.schema.json",
    "schemas/memory-recall.schema.json",
    "schemas/attack.schema.json",
    "schemas/match-judge.schema.json",
    "schemas/rule-judge.schema.json",
];

/// The raw text of the content file at `path` under `content/`.
///
/// # Errors
/// [`ContentError::UnknownFile`] when this crate does not carry it.
pub fn raw(path: &str) -> Result<&'static str, ContentError> {
    FILES
        .iter()
        .find(|(p, _)| *p == path)
        .map(|(_, text)| *text)
        .ok_or_else(|| ContentError::UnknownFile(path.to_owned()))
}

/// Renders the prompt template `content/prompts/<name>.md`.
///
/// # Errors
/// As [`raw`] and [`render`].
pub fn prompt(name: &str, vars: &Vars) -> Result<String, ContentError> {
    render(raw(&format!("prompts/{name}.md"))?, vars)
}

/// The text of `content/prompts/<name>.md` as a value, its final newline dropped.
///
/// # Errors
/// As [`raw`].
pub fn text(name: &str) -> Result<String, ContentError> {
    raw(&format!("prompts/{name}.md")).map(|t| content_text(t).to_owned())
}

/// The schema `content/schemas/<name>.schema.json` with its references to sibling schemas inlined.
///
/// # Errors
/// As [`raw`] and [`resolve_refs`], or when a schema file is not JSON.
pub fn schema(name: &str) -> Result<Value, ContentError> {
    let parse = |path: &str, text: &str| {
        serde_json::from_str::<Value>(text)
            .map_err(|e| ContentError::NotJson(path.to_owned(), e.to_string()))
    };
    let mut siblings = BTreeMap::new();
    for (path, text) in FILES {
        if let Some(file) = path.strip_prefix("schemas/") {
            siblings.insert(file.to_owned(), parse(path, text)?);
        }
    }
    let path = format!("schemas/{name}.schema.json");
    resolve_refs(&parse(&path, raw(&path)?)?, &siblings)
}

#[cfg(test)]
mod tests;
