//! The `memory` field of a run record, one form for every kind the binary drives (realm
//! @nick/craft, node #250): its keys in the order the JavaScript engines set them, whatever order
//! they reached the writer in.

use crate::js::{Js, Obj};

/// The order the engines' memory source holds its keys in, as `readMemoryRecall` sets them and
/// `acceptedMemory`, `withPassed` and `withDerived` add theirs after (the kinds re-added last).
const ORDER: [&str; 13] = [
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

/// `memory` with its keys in the engines' order, any other after them in the order they came.
#[must_use]
pub fn ordered(memory: &Obj) -> Obj {
    let mut rest = memory.clone();
    let mut out = Obj::new();
    for k in ORDER {
        if let Some(v) = rest.remove(k) {
            out.set(k, v);
        }
    }
    out.spread(&rest);
    out
}

/// The `memory` field as the record keeps it: an object ordered, anything else null.
#[must_use]
pub fn field(v: Option<&Js>) -> Js {
    match v {
        Some(Js::Obj(o)) => Js::Obj(ordered(o)),
        _ => Js::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::ordered;
    use crate::js::{Js, parse};

    #[test]
    fn the_keys_take_the_engines_order_and_any_other_follows_as_it_came() {
        let sorted = r#"{"backend":"repo","count":5,"rules":2,"source":"recalled","zeta":1,"questions":1,"why":"w","alpha":0}"#;
        let Js::Obj(o) = parse(sorted).unwrap() else {
            panic!()
        };
        assert_eq!(
            Js::Obj(ordered(&o)).compact(),
            r#"{"source":"recalled","count":5,"why":"w","backend":"repo","questions":1,"rules":2,"zeta":1,"alpha":0}"#
        );
    }

    #[test]
    fn every_key_the_engines_set_takes_its_place() {
        // As `acceptedMemory` leaves a recall with externals that may have failed in part, the
        // launcher's records counted after (`withPassed`, `withDerived`), then a dead recall.
        let want = r#"{"source":"recalled","count":3,"why":"w","recallDied":"d","backend":"repo","externals":1,"queryError":"q","truncated":"t","questions":1,"rules":1,"passed":2,"added":1,"derived":1}"#;
        let Js::Obj(o) = parse(want).unwrap() else {
            panic!()
        };
        let mut keys: Vec<_> = o.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        keys.sort_by_key(|a| a.0.to_utf8_lossy());
        let mut sorted = crate::js::Obj::new();
        for (k, v) in keys {
            sorted.set(k, v);
        }
        assert_ne!(
            Js::Obj(sorted.clone()).compact(),
            want,
            "the input arrives out of order"
        );
        assert_eq!(Js::Obj(ordered(&sorted)).compact(), want);
    }
}
