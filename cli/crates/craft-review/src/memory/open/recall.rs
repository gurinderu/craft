//! The recall as another kind asks it: its ask, and its answer read and merged with the
//! launcher's records.

use serde_json::Value;

use super::Ask;
use crate::content::{self, ContentError};
use crate::memory::{Memory, MemorySource, merge, recall};

/// The recall as it was asked: how many of its paths the prompt cut and grouped, to read its
/// answer by.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecallCut {
    pub cut: usize,
    pub grouped: usize,
}

impl Memory {
    /// The recall agent's ask over `paths` at `base`, and how its prompt cut them.
    ///
    /// # Errors
    /// When its prompt or schema is missing.
    pub fn recall_ask(paths: &[String], base: &str) -> Result<(Ask, RecallCut), ContentError> {
        let (_, grouped, cut) = recall::entries(paths);
        let ask = Ask {
            id: "memory-recall".into(),
            label: "memory-recall".into(),
            prompt: recall::prompt(paths, base)?,
            schema: content::schema("memory-recall")?,
        };
        Ok((ask, RecallCut { cut, grouped }))
    }

    /// Reads the recall's `answer` (`None`: it gave none) as it was asked (`asked`) and merges the
    /// launcher's records into it, the cap keeping those closest to `paths`.
    pub fn take_recalled(&mut self, answer: Option<&Value>, asked: RecallCut, paths: &[String]) {
        let m = merge::merge(
            recall::read(answer, asked.cut, asked.grouped),
            self.passed.as_ref(),
            paths,
        );
        self.decisions = m.decisions;
        self.set_refused(m.refused);
        self.source = m.source;
    }

    /// The memory of a run that asked no recall, said why.
    pub fn not_recalled(&mut self, why: &str) {
        self.source = MemorySource {
            why: why.into(),
            ..self.source.clone()
        };
    }
}
