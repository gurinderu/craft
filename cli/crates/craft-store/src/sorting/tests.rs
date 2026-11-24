use super::*;

fn record() -> Obj {
    let f = |n: Js, title: &str| {
        Js::Obj(
            Obj::new()
                .with("n", n)
                .with("title", Js::str(title))
                .with("file", Js::str("a.rs"))
                .with("line", Js::Num(3.0)),
        )
    };
    let sorting = Obj::new()
        .with(
            "findings",
            Js::Arr(vec![f(Js::Num(1.0), "one"), f(Js::str("2"), "two")]),
        )
        .with("choices", Js::Obj(Obj::new().with("1", Js::str("old"))));
    Obj::new()
        .with("sorting", Js::Obj(sorting))
        .with("after", Js::Bool(true))
}

#[test]
fn a_choice_lands_beside_the_earlier_ones_and_a_later_one_replaces_it() {
    let (r, named) = apply_choice(&record(), 2.0, "defect", "T").unwrap();
    assert_eq!(named, "two @ a.rs:3");
    let choices = r
        .get("sorting")
        .and_then(Js::as_obj)
        .and_then(|s| s.get("choices"))
        .unwrap();
    assert_eq!(
        choices.compact(),
        r#"{"1":"old","2":{"choice":"defect","at":"T"}}"#
    );
    let (again, _) = apply_choice(&r, 1.0, "dropped", "U").unwrap();
    let choices = again
        .get("sorting")
        .and_then(Js::as_obj)
        .and_then(|s| s.get("choices"))
        .unwrap();
    assert_eq!(
        choices.compact(),
        r#"{"1":{"choice":"dropped","at":"U"},"2":{"choice":"defect","at":"T"}}"#
    );
}

#[test]
fn an_unknown_choice_a_missing_finding_or_no_sorting_is_refused_by_name() {
    assert_eq!(
        apply_choice(&record(), 1.0, "maybe", "T").unwrap_err(),
        r#"--choice must be one of question, defect, dropped, got "maybe""#
    );
    assert_eq!(
        apply_choice(&record(), 9.0, "defect", "T").unwrap_err(),
        "the record lists no doubtful finding numbered 9"
    );
    assert!(
        apply_choice(&Obj::new(), 1.0, "defect", "T")
            .unwrap_err()
            .starts_with("the record carries no sorting")
    );
}

#[test]
fn the_pr_a_post_is_marked_with_stays_with_the_choice_that_completes_it() {
    let marked = posting::apply(&record(), 2.0, 7, "T").unwrap();
    let choices = |r: &Obj| {
        r.get("sorting")
            .and_then(Js::as_obj)
            .and_then(|s| s.get("choices"))
            .unwrap()
            .compact()
    };
    assert_eq!(
        choices(&marked),
        r#"{"1":"old","2":{"pr":7,"posting":true,"at":"T"}}"#
    );
    let (done, _) = apply_choice(&marked, 2.0, "question", "U").unwrap();
    assert_eq!(
        choices(&done),
        r#"{"1":"old","2":{"choice":"question","at":"U","pr":7}}"#
    );
    let json: serde_json::Value = serde_json::from_str(&Js::Obj(done).compact()).unwrap();
    assert_eq!(posting::recorded_pr(&json, 2), Some(7));
    assert_eq!(posting::recorded_pr(&json, 1), None);
    assert_eq!(
        posting::apply(&record(), 9.0, 7, "T").unwrap_err(),
        posting::Refusal::NoFinding("9".into())
    );
    assert_eq!(
        posting::apply(&Obj::new(), 2.0, 7, "T").unwrap_err(),
        posting::Refusal::NoSorting
    );
}

#[test]
fn a_mark_tells_a_record_s_refusal_from_a_failure_to_read_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    let file = dir.path().join("r-review.json");
    std::fs::write(&file, Js::Obj(record()).pretty()).unwrap();
    posting::mark(&store, &file, 2.0, 7, 0).unwrap();
    assert_eq!(
        posting::recorded_pr(
            &serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap(),
            2
        ),
        Some(7)
    );
    let refused = posting::mark(&store, &file, 9.0, 7, 0).unwrap_err();
    assert!(refused.is_refusal(), "{refused}");
    assert_eq!(
        refused,
        posting::MarkError::Refused {
            file: file.display().to_string(),
            refusal: posting::Refusal::NoFinding("9".into())
        }
    );
    let missing = posting::mark(&store, &dir.path().join("gone.json"), 2.0, 7, 0).unwrap_err();
    assert!(
        matches!(&missing, posting::MarkError::Failed(_)) && !missing.is_refusal(),
        "{missing}"
    );
}

#[test]
fn a_post_mark_keeps_a_choice_made_before() {
    let (dropped, _) = apply_choice(&record(), 2.0, "dropped", "T").unwrap();
    let marked = posting::apply(&dropped, 2.0, 7, "U").unwrap();
    let choices = marked
        .get("sorting")
        .and_then(Js::as_obj)
        .and_then(|s| s.get("choices"))
        .unwrap()
        .compact();
    assert_eq!(
        choices,
        r#"{"1":"old","2":{"choice":"dropped","at":"U","pr":7,"posting":true}}"#
    );
}

#[test]
fn a_post_mark_replaces_the_pr_a_choice_named_and_keeps_an_array_of_choices() {
    let (asked, _) = apply_choice(&record(), 2.0, "question", "T").unwrap();
    let on7 = posting::apply(&asked, 2.0, 7, "U").unwrap();
    let on9 = posting::apply(&on7, 2.0, 9, "V").unwrap();
    let choices = |r: &Obj| {
        r.get("sorting")
            .and_then(Js::as_obj)
            .and_then(|s| s.get("choices"))
            .unwrap()
            .compact()
    };
    assert_eq!(
        choices(&on9),
        r#"{"1":"old","2":{"choice":"question","at":"V","pr":9,"posting":true}}"#
    );
    let mut arrayed = record();
    let sorting = arrayed.get("sorting").and_then(Js::as_obj).unwrap().clone();
    let sorting = sorting.with("choices", Js::Arr(vec![Js::str("zero"), Js::str("one")]));
    arrayed.set("sorting", Js::Obj(sorting));
    let marked = posting::apply(&arrayed, 2.0, 7, "T").unwrap();
    assert_eq!(
        choices(&marked),
        r#"{"0":"zero","1":"one","2":{"pr":7,"posting":true,"at":"T"}}"#
    );
}
