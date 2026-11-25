//! The triage of review findings (`craft:triage-findings`) as the binary will run it, the second
//! kind of the step protocol (realm @nick/craft, node #616): for now its pure logic only, ported
//! from `integrations/claude-code/src/triage-findings.js`, `integrations/shared/triage-sift.mjs`
//! and `integrations/shared/triage-noise-class.mjs` and held to them by
//! `content/parity/triage-cases.json` (the `parity` tests). A gathered finding's identity and site
//! ([`finding`]); repeats in one batch collapsed ([`sift`]); a prior ledger's settled verdicts
//! carried ([`prior`]) and the stand-in for a dead validator ([`ledger`]); the batch sifted by the
//! project's memory, the review's own, through its open API ([`memory`]); the noise classes a
//! verdict is read back by ([`noise`]) and the issue class 1 files ([`issue`]); the plan's ledger
//! with the rows this side settled pinned ([`pinned`]); the banners that lead the plan
//! ([`banner`]); the run record ([`record`]). Each is the engine's object, its keys in the engine's
//! order, held in the run store's JavaScript-compatible value (`craft_store::js`) and read as
//! the engine reads it ([`field`]).

pub mod banner;
pub mod field;
pub mod finding;
pub mod issue;
pub mod ledger;
pub mod memory;
pub mod noise;
#[cfg(test)]
mod parity;
pub mod pinned;
pub mod prior;
pub mod prompts;
pub mod record;
pub mod sift;

/// Why an agent's answer could not be read as the triage needs it.
#[derive(Debug, thiserror::Error)]
pub enum TriageError {
    /// The answer is not the shape its schema promises.
    #[error("{what} is not the answer its schema promises: {why}")]
    Answer { what: String, why: String },
}
