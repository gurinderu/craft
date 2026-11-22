use serde_json::json;

use super::support::{Store, row};

#[test]
fn damaged_nonobjects_directories_and_skip_precedence_are_counted_without_an_index() {
    let s = Store::new();
    for (name, value) in [
        ("null", json!(null)),
        ("array", json!([])),
        ("number", json!(2)),
        ("string", json!("text")),
        ("bool", json!(true)),
    ] {
        s.write(name, &value);
    }
    std::fs::write(s.store.join("broken.json"), "{").unwrap();
    std::fs::create_dir(s.store.join("directory.json")).unwrap();
    std::fs::write(s.store.join("index.jsonl"), "not an index").unwrap();
    std::fs::write(s.store.join("ignored.txt"), "not a record").unwrap();
    s.write("other", &json!({"project":null,"partial":true}));
    for (i, partial) in [json!([]), json!({}), json!("false"), json!(true), json!(1)]
        .iter()
        .enumerate()
    {
        s.write(
            &format!("partial{i}"),
            &json!({"project":s.project,"partial":partial}),
        );
    }
    s.write(
        "branch",
        &json!({"project":s.project,"branch":" \u{feff} "}),
    );
    s.record("ledger", "a", json!({}));
    s.record("good", "a", json!([]));
    let out = s.read(&[]);
    assert_eq!(
        out["skipped"],
        json!({"unreadable":7,"otherProject":1,"partial":5,"noBranch":1,"noLedger":1})
    );
    assert_eq!(out["runsRead"], 16);
    assert_eq!(
        out["note"],
        "1 run(s) of this project read; rejected, refuted, justified, covered, deferred and dismissed findings are not counted, nor unverified and suspected ones — only findings verified real and not already settled"
    );
}

#[test]
fn only_confirmed_unsettled_or_resolved_rows_count_and_fields_are_trimmed() {
    let s = Store::new();
    let mut rows = Vec::new();
    for (i, disposition) in [
        "rejected",
        "justified",
        "covered",
        "deferred",
        "closed",
        "open",
        "resolved",
        "unknown",
    ]
    .iter()
    .enumerate()
    {
        let mut r = row(&format!("f{i}"), "same");
        r["disposition"] = json!(format!(" {disposition} "));
        r["why"] = json!(" dismissed in round 2 ");
        rows.push(r);
    }
    for tier in [
        json!("refuted"),
        json!("suspected"),
        json!("unverified"),
        json!("Confirmed"),
        json!(null),
        json!(false),
    ] {
        let mut r = row("not-confirmed", "same");
        r["tier"] = tier;
        rows.push(r);
    }
    let mut resolved = row(" \u{feff}resolved ", " same ");
    resolved["tier"] = json!(" confirmed ");
    resolved["disposition"] = json!("closed");
    resolved["why"] = json!("resolved in round 2");
    resolved["severity"] = json!(" High ");
    rows.push(resolved);
    for malformed in [
        json!(null),
        json!([]),
        json!(false),
        json!({"file":1,"title":"same","tier":"confirmed"}),
        row(" ", "same"),
        row("f", " "),
    ] {
        rows.push(malformed);
    }
    for (i, partial) in [json!(null), json!(false), json!(0), json!("")]
        .iter()
        .enumerate()
    {
        s.write(&format!("r{i}"), &json!({"project":s.project,"partial":partial,"branch":format!(" b{i} "),"ts":" 2026 ","ledger":rows}));
    }
    let out = s.read(&[]);
    let files: Vec<_> = out["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["file"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["f5", "f6", "f7", "resolved"]);
    assert_eq!(out["groups"][3]["severities"], json!(["High"]));
    assert_eq!(
        out["groups"][0]["branches"],
        json!(["b0", "b1", "b2", "b3"])
    );
    assert_eq!(out["groups"][0]["lastSeen"], "2026");
}

#[test]
fn newest_500_bound_applies_before_project_filter_at_adjacent_boundaries() {
    for total in [499_usize, 500, 501, 502] {
        let s = Store::new();
        s.record("0000", "a", json!([row("f", "same")]));
        s.record("0001", "b", json!([row("f", "same")]));
        for i in 2..total {
            s.write(&format!("{i:04}"), &json!({"project":"other"}));
        }
        let out = s.read(&[]);
        assert_eq!(out["runsRead"], total.min(500));
        assert_eq!(out["runsNotRead"], total.saturating_sub(500));
        assert_eq!(
            out["groups"].as_array().unwrap().len(),
            usize::from(total <= 500)
        );
        assert_eq!(out["skipped"]["otherProject"], (total - 2).min(500));
        if total > 500 {
            assert!(out["note"].as_str().unwrap().contains(&format!(
                "{} older run(s) past the bound of 500 were not read",
                total - 500
            )));
        }
    }
}

#[test]
fn existing_store_that_cannot_be_listed_is_an_error() {
    let s = Store::new();
    std::fs::remove_dir(&s.store).unwrap();
    std::fs::write(&s.store, "file, not directory").unwrap();
    let out = s.output(&[]);
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("listing run store"), "{stderr}");
    assert_eq!(stderr.matches("os error").count(), 1, "said once: {stderr}");
}
