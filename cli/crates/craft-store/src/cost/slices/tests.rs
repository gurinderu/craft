use super::*;

fn agent(name: &str, start: f64, record: &str) -> RunAgent {
    RunAgent {
        name: name.into(),
        start,
        record: record.into(),
        instance: String::new(),
        engine: String::new(),
    }
}

#[test]
fn a_record_filed_twice_ends_its_slice_at_the_later_filing() {
    let got = slice_agents(
        &[
            agent("a", 1.0, ""),
            agent("b", 2.0, "/r.json"),
            agent("c", 3.0, ""),
            agent("d", 4.0, "/r.json"),
        ],
        "this run",
    )
    .unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].transcripts, ["a", "b", "c", "d"]);
    assert_eq!((got[0].tail, got[0].end), (0, 4.0));
}
