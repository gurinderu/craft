//! What the runs did not do, each kept apart from what did not run: the verifications they
//! deliberately did not buy (`savedByFloor`) and the runs whose premise for that did not hold; the
//! findings the harm cap lowered, over the runs that record it; the files no language profile
//! covered; and the craft agents not registered, whose work went to the generic subagent (realm
//! @nick/craft, nodes #113, #151).

use std::collections::{BTreeMap, BTreeSet};

use crate::js::{Js, JsString, Obj, Utf16Error};

/// The sums over the runs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Signals {
    pub saved: BTreeMap<String, u64>,
    /// Runs whose saving's premise was revoked (`savedByFloorPremiseHeld: false`).
    pub revoked_runs: u64,
    pub harm_runs: u64,
    pub harm_lowered: f64,
    /// Per file, the runs that left it uncovered.
    pub uncovered: BTreeMap<String, u64>,
    pub uncovered_runs: u64,
    /// Per agent type, the runs that learned it is not registered.
    pub unavailable: BTreeMap<String, u64>,
    /// Per agent type, the dispatches the generic subagent answered, and in how many runs.
    pub fallbacks: BTreeMap<String, (f64, u64)>,
}

fn strings(v: Option<&Js>) -> Result<Vec<String>, Utf16Error> {
    v.and_then(Js::as_arr)
        .unwrap_or(&[])
        .iter()
        .map(Js::to_js_string)
        .collect()
}

impl Signals {
    /// Adds one run.
    /// # Errors
    /// When a saving, a file or an agent type cannot be represented as Unicode.
    pub fn add(&mut self, r: &Obj) -> Result<(), Utf16Error> {
        for item in strings(r.get("savedByFloor"))? {
            *self.saved.entry(item).or_default() += 1;
        }
        self.revoked_runs += u64::from(r.get("savedByFloorPremiseHeld") == Some(&Js::Bool(false)));
        let lowered = r.get("harmCap").and_then(Js::as_obj);
        if let Some(n) = lowered.and_then(|h| h.get("lowered")).and_then(Js::as_num) {
            self.harm_runs += 1;
            self.harm_lowered += n;
        }
        let files: BTreeSet<String> = strings(r.get("uncoveredFiles"))?
            .into_iter()
            .filter(|f| !f.is_empty())
            .collect();
        self.uncovered_runs += u64::from(!files.is_empty());
        for f in files {
            *self.uncovered.entry(f).or_default() += 1;
        }
        let (missing, fallbacks) = agent_unavailable(r)?;
        for agent in missing {
            *self.unavailable.entry(agent).or_default() += 1;
        }
        for (agent, n) in fallbacks {
            let was = self.fallbacks.entry(agent).or_default();
            *was = (was.0 + n, was.1 + 1);
        }
        Ok(())
    }
}

/// The agent types a record learned are not registered, each once, and per agent type the
/// dispatches the generic subagent answered (`readAgentUnavailable`): the shape both engines write
/// now, or the review engine's earlier fields keyed by profile id (`craft:<id>-reviewer`).
fn agent_unavailable(r: &Obj) -> Result<(BTreeSet<String>, BTreeMap<String, f64>), Utf16Error> {
    let current = r.has("agentUnavailable") || r.has("agentFallbacks");
    let (list, counts, name): (_, _, fn(String) -> String) = if current {
        (r.get("agentUnavailable"), r.get("agentFallbacks"), |k| k)
    } else {
        (
            r.get("reviewerAgentUnavailable"),
            r.get("reviewerAgentFallbacks"),
            |id| format!("craft:{id}-reviewer"),
        )
    };
    let mut missing = BTreeSet::new();
    for v in list.and_then(Js::as_arr).unwrap_or(&[]) {
        if let Js::Str(s) = v {
            missing.insert(name(s.to_utf8()?));
        }
    }
    let mut fallbacks = BTreeMap::new();
    for (k, v) in counts
        .and_then(Js::as_obj)
        .map(Obj::iter)
        .into_iter()
        .flatten()
    {
        if let Some(n) = v.as_num().filter(|n| *n > 0.0) {
            *fallbacks.entry(name(JsString::to_utf8(k)?)).or_default() += n;
        }
    }
    Ok((missing, fallbacks))
}

#[cfg(test)]
mod tests;
