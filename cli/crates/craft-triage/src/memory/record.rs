//! The memory as triage's run record keeps it, in the form every kind's record holds it
//! (`craft_store::memory`).

use craft_review::memory::MemorySource;
use craft_store::js::Js;

/// The memory as the run record keeps it (`memoryRecord`): the derived ids' titles left out, its
/// keys in the engines' order.
#[must_use]
pub fn memory_record(source: &MemorySource) -> Js {
    let text = serde_json::to_string(source).unwrap_or_default();
    let Ok(Js::Obj(mut o)) = craft_store::js::parse(&text) else {
        return Js::Null;
    };
    o.remove("derivedNamed");
    Js::Obj(craft_store::memory::ordered(&o))
}
