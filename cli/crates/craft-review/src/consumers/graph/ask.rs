//! The ready graph's two questions in their order: the callers first, as every lens's consumers
//! list stands on them (realm @nick/craft, node #529), within the budget less the floor kept for
//! the metrics read when a metrics lens wants it; then the metrics, in what is left.

use super::metrics::{Read, graph_metrics, kept_for_metrics};
use super::{GraphError, Ready, graph_callers};
use crate::consumers::cbm::Asked;
use crate::consumers::symbols::Symbol;
use crate::gate::lines::Lines;

/// What the two questions came to: the callers (none asked), then the numbers when asked.
pub(in crate::consumers) type Answers = (
    Result<Option<Asked>, GraphError>,
    Option<Result<Read, GraphError>>,
);

/// The callers of `found`, none asked when there is no symbol (indexed for the metrics lenses
/// alone, the graph is then no source); then, when `metrics`, the numbers of the functions
/// `changed` touches.
pub(in crate::consumers) fn ask(
    r: &Ready,
    found: &[Symbol],
    changed: &Lines,
    metrics: bool,
) -> Answers {
    let asked = (!found.is_empty())
        .then(|| graph_callers(r, found, kept_for_metrics(metrics)))
        .transpose();
    (asked, metrics.then(|| graph_metrics(r, changed)))
}
