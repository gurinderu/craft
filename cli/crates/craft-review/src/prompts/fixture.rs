//! The one `PromptContext` the tests start from, so a new field is spelled here only: each test
//! overrides what it exercises with struct-update syntax.

use serde_json::Value;

use super::{PromptContext, ReScope};

impl PromptContext {
    /// A first review of `base` in `repo`: no spec, craft root or version, not strict, no sources,
    /// consumers or scope.
    pub(crate) fn fixture(repo: &str, base: &str) -> Self {
        Self {
            mutants: false,
            composition: crate::composition::Composition::default(),
            project: crate::project::properties::Properties::new(),
            repo: repo.into(),
            base: base.into(),
            spec: String::new(),
            craft_root: None,
            craft_version: None,
            re_review: ReScope::First,
            strict: false,
            sources: super::Sources::default(),
            consumers: crate::consumers::Consumers::default(),
            graph_project: String::new(),
            design: crate::design::Seed::default(),
            scope: None,
        }
    }

    /// The context a parity case's input names: its `base`, `craftRoot` and `craftVersion` in
    /// `/work/repo`.
    pub(crate) fn parity(input: &Value) -> Self {
        Self {
            craft_root: input["craftRoot"].as_str().map(str::to_owned),
            craft_version: input["craftVersion"].as_str().map(str::to_owned),
            graph_project: "craft-review-repo-0123456789ab".into(),
            ..Self::fixture("/work/repo", input["base"].as_str().unwrap())
        }
    }
}
