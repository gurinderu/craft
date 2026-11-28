use super::*;
use crate::js::parse;

fn add(m: &mut Memory, memory: &str) {
    let r = parse(&format!(r#"{{"memory":{memory}}}"#)).unwrap();
    m.add(r.as_obj().unwrap()).unwrap();
}

#[test]
fn a_recall_counts_its_records_by_backend_and_a_none_by_its_class() {
    let mut m = Memory::default();
    add(
        &mut m,
        r#"{"source":"recalled","count":3,"questions":1,"rules":2,"externals":1,"covered":4,"truncated":"t"}"#,
    );
    add(&mut m, r#"{"source":"recalled","count":-1,"backend":"b"}"#);
    add(
        &mut m,
        r#"{"source":"launcher","recallDegraded":"d","count":9}"#,
    );
    add(
        &mut m,
        r#"{"source":"none","why":"not recalled — empty; detail","passed":1}"#,
    );
    add(
        &mut m,
        r#"{"source":"none","why":"the recall agent did not run at all","recallDied":"x"}"#,
    );
    add(
        &mut m,
        r#"{"source":"none","backend":"z","queryError":"q"}"#,
    );
    add(&mut m, r#"{"source":"none","backend":"z"}"#);
    add(&mut m, "null");
    assert_eq!(
        (
            m.runs,
            m.carrying,
            m.recalled,
            m.nested,
            m.none,
            m.passed_only
        ),
        (8, 7, 2, 1, 4, 1)
    );
    assert_eq!(
        (m.records, m.questions, m.rules, m.externals, m.covered),
        (3.0, 1.0, 2.0, 1.0, 4.0)
    );
    assert_eq!((m.not_read, m.partly_read, m.launcher_degraded), (2, 1, 1));
    assert_eq!(m.by_backend.get("unnamed"), Some(&1));
    assert_eq!(m.by_backend.get("b"), Some(&1));
    for class in [
        "not recalled — empty",
        "the recall agent did not run",
        "backend query may have failed in z",
        "recall found nothing in z",
    ] {
        assert_eq!(m.none_why.get(class), Some(&1), "{class}: {:?}", m.none_why);
    }
}
