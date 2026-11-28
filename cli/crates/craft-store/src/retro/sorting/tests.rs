use super::*;
use crate::js::parse;

fn add(s: &mut Sorting, sorting: &str) {
    s.add(
        parse(&format!(r#"{{"sorting":{sorting}}}"#))
            .unwrap()
            .as_obj()
            .unwrap(),
    );
}

#[test]
fn the_doubtful_end_by_the_reviewers_choice_and_a_count_is_a_positive_whole_number() {
    let mut s = Sorting::default();
    add(
        &mut s,
        r#"{"defect":2,"doubtful":5,"choices":{"1":{"choice":"defect"},"2":{"choice":"question"},"3":{"choice":"dropped"},"4":{"choice":"x"}}}"#,
    );
    add(
        &mut s,
        r#"{"defect":1.5,"doubtful":-2,"choices":[{"choice":"dropped"}]}"#,
    );
    add(&mut s, r#"{"defect":0}"#);
    add(&mut s, "null");
    assert_eq!((s.runs, s.posted, s.doubtful), (3, 2.0, 5.0));
    assert_eq!((s.defect, s.question, s.dropped), (1, 1, 2));
    assert_eq!(s.undecided(), 1.0);
    assert_eq!(s.percent(2), Some(40.0));
    assert_eq!(s.percent(1), Some(20.0));
    assert_eq!(Sorting::default().percent(1), None);
    let over = Sorting {
        doubtful: 1.0,
        defect: 2,
        question: 1,
        ..Sorting::default()
    };
    assert_eq!(over.undecided(), 0.0, "never below none");
}
