//! The re-anchor step moves only a finding whose line cannot be its symbol's site to the one line
//! that symbol stands on (realm @nick/craft, node #547).

use std::cell::RefCell;

use serde_json::{Value, json};

use super::{Blob, Tree, target, within};

pub(super) const ROOT: &str = "/r";

/// The head's `src/lib.rs`: five lines, `head_lines` defined once on line 2 and called on none,
/// `twice` on two lines, `ab` short.
const LIB: &str = "use x;\nfn head_lines() {\n    twice();\n    twice();\n}\n";

/// A head tree holding `src/lib.rs`, with every path it was asked for.
#[derive(Default)]
pub(super) struct Fake {
    asked: RefCell<Vec<String>>,
}

impl Tree for Fake {
    fn at_head(&self, path: &str) -> Blob {
        self.asked.borrow_mut().push(path.to_owned());
        match path {
            "src/lib.rs" => Blob::Text(LIB.into()),
            "link" => Blob::Unreadable,
            _ => Blob::Missing,
        }
    }
}

pub(super) fn finding(line: i64, symbol: &str, extra: &Value) -> Value {
    let mut f = json!({"severity": "Medium", "title": "t", "file": "src/lib.rs", "line": line,
                       "why": "w", "source": "correctness", "ruleId": "", "symbol": symbol});
    if let (Some(o), Some(e)) = (f.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    f
}

fn to(f: &Value) -> Option<i64> {
    target(f, ROOT, &Fake::default())
}

#[test]
fn a_line_past_the_end_moves_to_the_one_line_of_its_symbol() {
    assert_eq!(to(&finding(603, "head_lines", &json!({}))), Some(2));
    assert_eq!(to(&finding(6, "Graph::head_lines", &json!({}))), Some(2));
    assert_eq!(to(&finding(6, "fn head_lines()", &json!({}))), Some(2));
}

#[test]
fn a_symbol_on_several_lines_stays() {
    assert_eq!(to(&finding(603, "twice", &json!({}))), None);
}

#[test]
fn a_symbol_absent_from_the_file_stays() {
    assert_eq!(to(&finding(603, "nowhere", &json!({}))), None);
    assert_eq!(to(&finding(603, "", &json!({}))), None, "no symbol");
    assert_eq!(to(&finding(603, "x", &json!({}))), None, "too short a name");
    assert_eq!(
        to(&finding(603, "head_line", &json!({}))),
        None,
        "a part of a word"
    );
}

#[test]
fn a_symbol_naming_several_items_stays() {
    assert_eq!(to(&finding(603, "twice / head_lines", &json!({}))), None);
    assert_eq!(to(&finding(603, "twice, head_lines", &json!({}))), None);
}

#[test]
fn a_line_inside_the_file_stays_even_off_its_symbol() {
    assert_eq!(
        to(&finding(2, "head_lines", &json!({}))),
        None,
        "already right"
    );
    assert_eq!(
        to(&finding(4, "head_lines", &json!({}))),
        None,
        "inside its body"
    );
    assert_eq!(
        to(&finding(5, "head_lines", &json!({}))),
        None,
        "the last line"
    );
}

#[test]
fn a_gate_seed_stays() {
    assert_eq!(
        to(&finding(603, "head_lines", &json!({"source": "clippy"}))),
        None
    );
    let sources = json!({"sources": ["correctness", "semgrep"]});
    assert_eq!(to(&finding(603, "head_lines", &sources)), None);
}

#[test]
fn a_file_level_finding_stays() {
    assert_eq!(to(&finding(0, "head_lines", &json!({}))), None);
    let mut f = finding(0, "head_lines", &json!({}));
    f.as_object_mut().unwrap().remove("line");
    assert_eq!(to(&f), None, "no line at all");
    assert_eq!(to(&finding(603, "head_lines", &json!({"file": ""}))), None);
    let tree = Fake::default();
    assert_eq!(
        target(&finding(0, "head_lines", &json!({})), ROOT, &tree),
        None
    );
    assert!(
        tree.asked.borrow().is_empty(),
        "a file-level finding reads nothing"
    );
}

#[test]
fn a_file_the_head_does_not_hold_or_cannot_read_stays() {
    assert_eq!(
        to(&finding(603, "head_lines", &json!({"file": "gone.rs"}))),
        None
    );
    assert_eq!(
        to(&finding(603, "head_lines", &json!({"file": "link"}))),
        None
    );
}

#[test]
fn an_escaping_path_is_never_read() {
    let tree = Fake::default();
    for file in [
        "../src/lib.rs",
        "src/../src/lib.rs",
        "/etc/src/lib.rs",
        ":(top)src/lib.rs",
        "src//lib.rs",
    ] {
        let f = finding(603, "head_lines", &json!({"file": file}));
        assert_eq!(target(&f, ROOT, &tree), None, "{file}");
    }
    assert!(tree.asked.borrow().is_empty(), "{:?}", tree.asked.borrow());
    assert_eq!(within("/r/src/lib.rs", "/r"), Some("src/lib.rs".into()));
    assert_eq!(within("./src/lib.rs", "/r/"), Some("src/lib.rs".into()));
    let absolute = finding(603, "head_lines", &json!({"file": "/r/src/lib.rs"}));
    assert_eq!(to(&absolute), Some(2), "an absolute path under the root");
}

#[path = "step_tests.rs"]
mod step;
