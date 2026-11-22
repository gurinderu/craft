//! Which of a run's transcripts belong to which record it filed (realm @nick/craft, nodes #393,
//! #389): sliced by engine first, then by time within one engine — rust-audit and the
//! rust-review/nix-review entries run a nested engine in the same run, whose agents interleave
//! with the outer engine's, so a cut by time alone gives one engine's agents to the other's record.

use std::collections::HashMap;

use super::agents::RunAgent;

/// The nested engines whose agents a slice took in, one per instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Absorbed {
    pub engine: String,
    pub instance: String,
    pub agents: u32,
}

/// One engine instance's agents.
type Group = (String, Vec<RunAgent>);

/// One record's slice of the run.
#[derive(Debug, Clone, PartialEq)]
pub struct Slice {
    pub record: String,
    pub transcripts: Vec<String>,
    /// The agents that started after the last record's logger, given to the last record.
    pub tail: u32,
    pub end: f64,
    pub absorbed: Vec<Absorbed>,
}

/// One engine's records in filing order, each with the agents that started after the previous
/// record's logger, up to and including its own; a record filed twice ends at its later filing.
///
/// # Errors
/// When no agent of `engine` names a filed record.
pub fn slice_agents(agents: &[RunAgent], engine: &str) -> Result<Vec<Slice>, String> {
    let mut ordered: Vec<&RunAgent> = agents.iter().collect();
    ordered.sort_by(|a, b| {
        a.start
            .total_cmp(&b.start)
            .then_with(|| a.name.cmp(&b.name))
    });
    let mut bounds: Vec<(String, f64)> = Vec::new();
    for a in ordered.iter().filter(|a| !a.record.is_empty()) {
        match bounds.iter_mut().find(|(r, _)| *r == a.record) {
            Some(b) => b.1 = a.start,
            None => bounds.push((a.record.clone(), a.start)),
        }
    }
    bounds.sort_by(|a, b| a.1.total_cmp(&b.1));
    if bounds.is_empty() {
        return Err(format!(
            "no log-run agent of {engine} reported a filed record"
        ));
    }
    let mut slices: Vec<Slice> = bounds
        .iter()
        .map(|(record, end)| Slice {
            record: record.clone(),
            transcripts: Vec::new(),
            tail: 0,
            end: *end,
            absorbed: Vec::new(),
        })
        .collect();
    let last = slices.len() - 1;
    for a in ordered {
        let i = bounds.iter().position(|(_, end)| a.start <= *end);
        if let Some(slice) = slices.get_mut(i.unwrap_or(last)) {
            if i.is_none() {
                slice.tail += 1;
            }
            slice.transcripts.push(a.name.clone());
        }
    }
    Ok(slices)
}

/// The run's agents grouped by engine instance (`""` for the top-level engine), in order of first
/// appearance. A nested instance that filed no record ran on the top-level engine's behalf: its
/// agents join that group, a warning says so, and `absorbed` names each such agent's engine.
fn by_engine(
    agents: &[RunAgent],
    warnings: &mut Vec<String>,
) -> (Vec<Group>, HashMap<String, RunAgent>) {
    let mut groups: Vec<Group> = Vec::new();
    for a in agents {
        match groups.iter_mut().find(|(i, _)| *i == a.instance) {
            Some(g) => g.1.push(a.clone()),
            None => groups.push((a.instance.clone(), vec![a.clone()])),
        }
    }
    let mut absorbed = HashMap::new();
    let nested: Vec<String> = groups
        .iter()
        .filter(|(i, list)| !i.is_empty() && list.iter().all(|a| a.record.is_empty()))
        .map(|(i, _)| i.clone())
        .collect();
    for instance in nested {
        let Some(at) = groups.iter().position(|(i, _)| *i == instance) else {
            continue;
        };
        let (_, list) = groups.remove(at);
        warnings.push(format!(
            "{} agent(s) of \"{instance}\" filed no record — counted under the top-level engine",
            list.len()
        ));
        for a in &list {
            absorbed.insert(a.name.clone(), a.clone());
        }
        match groups.iter_mut().find(|(i, _)| i.is_empty()) {
            Some(top) => top.1.extend(list),
            None => groups.push((String::new(), list)),
        }
    }
    (groups, absorbed)
}

fn absorbed_in(slice: &Slice, absorbed: &HashMap<String, RunAgent>) -> Vec<Absorbed> {
    let mut by: Vec<Absorbed> = Vec::new();
    for a in slice.transcripts.iter().filter_map(|n| absorbed.get(n)) {
        match by.iter_mut().find(|x| x.instance == a.instance) {
            Some(x) => x.agents += 1,
            None => by.push(Absorbed {
                engine: a.engine.clone(),
                instance: a.instance.clone(),
                agents: 1,
            }),
        }
    }
    by
}

/// Every record of the run with its slice, in filing order. `name_of` reads a record's `name`
/// (`None` when it has no string one) and refuses an unreadable one.
///
/// # Errors
/// When an engine filed no record, a record cannot be read, a nested engine's record is not that
/// engine's, or one record was filed from two engines.
pub fn slice_by_engine(
    agents: &[RunAgent],
    name_of: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
    warnings: &mut Vec<String>,
) -> Result<Vec<Slice>, String> {
    let mut slices: Vec<Slice> = Vec::new();
    let (groups, absorbed) = by_engine(agents, warnings);
    for (instance, list) in groups {
        let who = if instance.is_empty() {
            "the top-level engine".to_owned()
        } else {
            format!("\"{instance}\"")
        };
        let mut mine = slice_agents(&list, &who)?;
        let engine = list
            .iter()
            .find(|a| !a.engine.is_empty())
            .map_or("", |a| a.engine.as_str());
        for s in &mut mine {
            let name = name_of(&s.record)?;
            if !instance.is_empty() && name.as_deref() != Some(engine) {
                return Err(format!(
                    "record {} is \"{}\", but its logger ran under \"{instance}\" — not matched, refusing the run",
                    s.record,
                    name.as_deref().unwrap_or("undefined")
                ));
            }
            if slices.iter().any(|o| o.record == s.record) {
                return Err(format!(
                    "record {} was filed from two engines of this run — refusing the run",
                    s.record
                ));
            }
            s.absorbed = absorbed_in(s, &absorbed);
        }
        slices.extend(mine);
    }
    slices.sort_by(|a, b| a.end.total_cmp(&b.end));
    Ok(slices)
}

#[cfg(test)]
mod tests;
