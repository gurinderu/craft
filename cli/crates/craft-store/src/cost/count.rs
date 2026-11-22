//! The real cost of some of a run's agents, counted from their transcripts (`<run-dir>/agent-*.jsonl`):
//! the four token classes of each `type: "assistant"` line's `message.usage` — a record shape the
//! Claude Code harness owns (realm @nick/craft, node #98). Once per model message (#357): the lines
//! of one `message.id` fold into the largest value each class carries, then count once; a line
//! with no id counts alone and names the per-line rule. A blank, cut or usage-less line is passed
//! over, never allowed to abort the sum.

use std::collections::HashMap;
use std::path::Path;

use crate::js::{Js, Obj, parse};

/// The rule a cost was counted by: once per model message.
pub const COST_RULE: &str = "per-message";
/// Some usage lines carried no message id, each counted alone.
pub const COST_RULE_PER_LINE: &str = "per-line";

/// The four token classes, in the order a cost lists them.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tokens {
    pub output: f64,
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Tokens {
    fn of(usage: &Js) -> Self {
        let field = |k: &str| {
            let n = crate::publication::js_number(usage.as_obj().and_then(|u| u.get(k)));
            if n.is_nan() { 0.0 } else { n }
        };
        Self {
            output: field("output_tokens"),
            input: field("input_tokens"),
            cache_read: field("cache_read_input_tokens"),
            cache_write: field("cache_creation_input_tokens"),
        }
    }

    fn raise(&mut self, o: &Self) {
        self.output = self.output.max(o.output);
        self.input = self.input.max(o.input);
        self.cache_read = self.cache_read.max(o.cache_read);
        self.cache_write = self.cache_write.max(o.cache_write);
    }

    fn add(&mut self, o: &Self) {
        self.output += o.output;
        self.input += o.input;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
    }
}

/// A message id as a `Map` key tells it apart: a primitive by its value, anything else by itself.
#[derive(Debug, PartialEq, Eq, Hash)]
enum Key {
    Str(Vec<u16>),
    Num(u64),
    Bool(bool),
    Alone(usize),
}

fn key(id: Option<&Js>, line: usize) -> Key {
    match id {
        Some(Js::Str(s)) => Key::Str(s.units().collect()),
        // SameValueZero: -0 is 0.
        Some(Js::Num(n)) => Key::Num(if *n == 0.0 { 0 } else { n.to_bits() }),
        Some(Js::Bool(b)) => Key::Bool(*b),
        _ => Key::Alone(line),
    }
}

/// The usage of one line and its message id, when it is an assistant line carrying one.
fn assistant_usage(line: &str) -> Option<(Option<Js>, Js)> {
    if line.trim().is_empty() {
        return None;
    }
    let Ok(Js::Obj(rec)) = parse(line) else {
        return None;
    };
    if rec.get("type").and_then(Js::as_str) != Some("assistant") {
        return None;
    }
    let message = rec
        .get("message")
        .filter(|m| matches!(m, Js::Obj(_) | Js::Arr(_)))?;
    let message = message.as_obj();
    let usage = message.and_then(|m| m.get("usage"))?;
    matches!(usage, Js::Obj(_) | Js::Arr(_))
        .then(|| (message.and_then(|m| m.get("id")).cloned(), usage.clone()))
}

/// A transcript's sum, and how many of its usage lines carried no message id.
#[must_use]
pub fn count_usage(text: &str) -> (Tokens, usize) {
    let mut order: Vec<Tokens> = Vec::new();
    let mut at: HashMap<Key, usize> = HashMap::new();
    let mut unkeyed = 0;
    for (i, line) in text.split('\n').enumerate() {
        let Some((id, usage)) = assistant_usage(line) else {
            continue;
        };
        let id = id.filter(|v| *v != Js::Null);
        if id.is_none() {
            unkeyed += 1;
        }
        let one = Tokens::of(&usage);
        let k = key(id.as_ref(), i);
        if let Some(seen) = at.get(&k).and_then(|&n| order.get_mut(n)) {
            seen.raise(&one);
        } else {
            at.insert(k, order.len());
            order.push(one);
        }
    }
    let mut total = Tokens::default();
    for one in &order {
        total.add(one);
    }
    (total, unkeyed)
}

/// The cost of `names` (transcripts under `run_dir`) as every enrich-cost writes it: the four sums,
/// `total`, `agents`, `skipped` when some could not be read, `source` and the counting `rule`;
/// each warning pushed onto `warnings` as it arises.
///
/// # Errors
/// When none of them could be read.
pub fn measure(
    run_dir: &Path,
    names: &[String],
    warnings: &mut Vec<String>,
    source: &str,
) -> Result<Obj, String> {
    let (mut sum, mut agents, mut skipped, mut unkeyed) = (Tokens::default(), 0u32, 0u32, 0usize);
    for name in names {
        match std::fs::read(run_dir.join(name)) {
            Ok(bytes) => {
                let (t, u) = count_usage(&String::from_utf8_lossy(&bytes));
                sum.add(&t);
                unkeyed += u;
                agents += 1;
            }
            Err(e) => {
                // One unreadable entry must not discard every good transcript's cost.
                skipped += 1;
                warnings.push(format!("skipped unreadable transcript {name}: {e}"));
            }
        }
    }
    if agents == 0 {
        return Err(format!(
            "no readable agent-*.jsonl transcripts under {} ({skipped} matched but unreadable)",
            run_dir.display()
        ));
    }
    let total = sum.output + sum.input + sum.cache_read + sum.cache_write;
    let mut cost = Obj::new()
        .with("output", Js::Num(sum.output))
        .with("input", Js::Num(sum.input))
        .with("cacheRead", Js::Num(sum.cache_read))
        .with("cacheWrite", Js::Num(sum.cache_write))
        .with("total", Js::Num(total))
        .with("agents", Js::Num(f64::from(agents)));
    if skipped > 0 {
        cost.set("skipped", Js::Num(f64::from(skipped)));
    }
    cost.set("source", Js::str(source));
    let rule = if unkeyed > 0 {
        COST_RULE_PER_LINE
    } else {
        COST_RULE
    };
    cost.set("rule", Js::str(rule));
    if unkeyed > 0 {
        warnings.push(format!(
            "{unkeyed} usage line(s) without a message id, each counted alone — the cost may be overstated; marked rule \"{COST_RULE_PER_LINE}\" (realm @nick/craft, node #98)"
        ));
    }
    // Readable yet zero: a real run is never free, so the usage schema likely drifted (#98).
    if total == 0.0 {
        warnings.push(format!(
            "{agents} transcript(s) summed to zero tokens — a real run is never free; likely the transcript usage schema drifted (realm @nick/craft, node #98)"
        ));
    }
    Ok(cost)
}

#[cfg(test)]
mod tests;
