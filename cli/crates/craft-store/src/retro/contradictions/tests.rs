use super::*;
use crate::js::parse;

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

const ROUND: &str = r#""kind":"workflow","name":"review","project":"/p","branch":"b""#;

#[test]
fn each_finding_takes_its_fate_from_the_newest_later_round_of_its_chain() {
    let mut c = Contradictions::default();
    let m = r#""memoryContradictions":{"count":3,"doubtSignsAlone":1,"findings":[{"fp":"a","toPr":true},{"fp":"b","toPr":null},{"fp":"c"},{"fp":"d"},{}]}"#;
    c.add("first", &rec(&format!("{{{ROUND},\"ts\":\"1\",{m}}}")));
    c.add("older", &rec(&format!("{{{ROUND},\"ts\":\"2\"}}")));
    c.add("newest", &rec(&format!("{{{ROUND},\"ts\":\"3\"}}")));
    c.add(
        "nested",
        &rec(&format!("{{{ROUND},\"ts\":\"4\",\"nested\":true}}")),
    );
    c.add(
        "cli",
        &rec(&format!("{{{ROUND},\"ts\":\"5\",\"driver\":\"cli\"}}")),
    );
    c.add(
        "other",
        &rec(&format!("{{{ROUND},\"ts\":\"6\",\"branch\":\"x\"}}")),
    );
    let ledger = parse(r#"[{"fp":"a","disposition":"closed"},{"fp":"b","disposition":"open"},{"fp":"c","disposition":"rejected"},{"fp":"d","disposition":1}]"#).unwrap();
    let mut asked = Vec::new();
    let [js, cli] = c.settle(|id| {
        asked.push(id.to_owned());
        Some(ledger.clone())
    });
    assert_eq!(asked, ["newest"]);
    assert_eq!(
        (
            js.runs,
            js.count,
            js.doubt_signs_alone,
            js.to_pr,
            js.no_posting
        ),
        (1, 3.0, 1.0, 1, 1)
    );
    assert_eq!(
        (
            js.fixed,
            js.open,
            js.set_aside,
            js.unknown,
            js.no_later_round
        ),
        (1, 1, 1, 2, 0)
    );
    assert_eq!(cli, Tally::default());
}

#[test]
fn with_no_later_round_a_fingerprinted_finding_has_none_and_without_a_branch_none_is_looked_for() {
    let mut c = Contradictions::default();
    let m = r#""memoryContradictions":{"findings":[{"fp":"a"},{"fp":""}]}"#;
    c.add("only", &rec(&format!("{{{ROUND},\"ts\":\"1\",{m}}}")));
    c.add(
        "nobranch",
        &rec(&format!(
            "{{\"kind\":\"workflow\",\"name\":\"review\",\"ts\":\"1\",{m}}}"
        )),
    );
    c.add(
        "later",
        &rec(r#"{"kind":"workflow","name":"review","ts":"2"}"#),
    );
    let [js, _] = c.settle(|_| None);
    assert_eq!((js.runs, js.no_later_round, js.unknown), (2, 2, 2));
}
