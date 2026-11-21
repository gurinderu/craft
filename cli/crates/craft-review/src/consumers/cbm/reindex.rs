//! The graph brought to the checkout a review reads (realm @nick/craft, node #529): one
//! `index_repository` of it, under a project name craft picks, within the review's graph
//! deadline. The graph indexes incrementally and swaps the new graph in whole when it is done;
//! while it runs, its questions answer from the graph it had (observed on cbm 0.12.1, node #533).

use std::time::Instant;

use serde_json::{Value, json};

use super::{Cbm, CbmError};

/// The index mode asked for. `fast` and `moderate` leave out every directory named `bin`,
/// `docs` or `scripts` (where a workspace's binaries often live), so their callers would never
/// be asked; `full` leaves out only build output and tool directories, and its incremental run
/// over an unchanged checkout takes under a second (observed on cbm 0.12.1, node #530).
const MODE: &str = "full";

impl Cbm {
    /// Indexes the checkout at `repo` as the project `name`, refused past `deadline`.
    ///
    /// # Errors
    /// When the graph does not answer within the time left, answers with an error, or says the
    /// index is not done.
    pub fn reindex(&self, repo: &str, name: &str, deadline: Instant) -> Result<(), CbmError> {
        let left = super::left(deadline)?;
        let args = json!({"repo_path": repo, "mode": MODE, "name": name});
        let answer = self.call("index_repository", args, left)?;
        match answer.get("status").and_then(Value::as_str) {
            Some("indexed") => Ok(()),
            other => Err(CbmError::Graph(format!(
                "index_repository: its answer says {}, not indexed",
                other.unwrap_or("no status")
            ))),
        }
    }
}
