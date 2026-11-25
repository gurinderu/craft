//! The memory as triage's run record keeps it, key for key in the engine's order.

use craft_review::memory::MemorySource;
use craft_store::js::{Js, Obj};

/// The order the engine's memory source holds its keys in, as `readMemoryRecall` sets them and
/// `acceptedMemory`, `withPassed` and `withDerived` add theirs after (the kinds re-added last).
const RECORD_ORDER: [&str; 13] = [
    "source",
    "count",
    "why",
    "recallDied",
    "backend",
    "externals",
    "queryError",
    "truncated",
    "questions",
    "rules",
    "passed",
    "added",
    "derived",
];

/// The memory as the run record keeps it (`memoryRecord`): the source's fields in the engine's
/// order, any other after them, the derived ids' titles left out.
#[must_use]
pub fn memory_record(source: &MemorySource) -> Js {
    let text = serde_json::to_string(source).unwrap_or_default();
    let Ok(Js::Obj(mut o)) = craft_store::js::parse(&text) else {
        return Js::Null;
    };
    o.remove("derivedNamed");
    let mut out = Obj::new();
    for k in RECORD_ORDER {
        if let Some(v) = o.remove(k) {
            out.set(k, v);
        }
    }
    out.spread(&o);
    Js::Obj(out)
}
