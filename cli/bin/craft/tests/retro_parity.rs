//! `craft runs retro`, `hooks` and `round-pairs` print the figures the JavaScript reader
//! (`integrations/shared/analyze-runs.mjs`) printed over the same store, frozen in
//! `content/parity/retro-cases.json` when it was retired (realm @nick/craft, nodes #540, #562):
//! every row it printed, and no other, with the same numbers.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::path::Path;
use std::process::Command;

use serde_json::{Map, Value, json};

fn cases() -> Value {
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/parity/retro-cases.json"),
    )
    .unwrap();
    serde_json::from_str(&text).unwrap()
}

/// The store and hook log laid out, with one record that does not read beside them.
fn laid(cases: &Value) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let store = d.path().join("runs");
    std::fs::create_dir(&store).unwrap();
    for (name, r) in cases["store"].as_object().unwrap() {
        std::fs::write(store.join(name), serde_json::to_string(r).unwrap()).unwrap();
    }
    std::fs::write(store.join("2026-12-01T00-00-00Z-broken.json"), "{").unwrap();
    std::fs::write(
        d.path().join("hooks.jsonl"),
        cases["hooks"].as_str().unwrap(),
    )
    .unwrap();
    d
}

fn craft(d: &Path, args: &[&str]) -> (Vec<Value>, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .arg("runs")
        .args(args)
        .arg("--json")
        .arg("--store")
        .arg(d.join("runs"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let lines = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    (lines, String::from_utf8_lossy(&out.stderr).into_owned())
}

/// The key a keyed section's row is filed under, and the value it is compared by.
fn keyed(section: &str, l: &Value) -> Option<(String, Value)> {
    let s = |k: &str| l[k].as_str().unwrap().to_owned();
    Some(match section {
        "engine" => (s("engine"), l["runs"].clone()),
        "versionCollision" => (s("version"), l["revisions"].clone()),
        "notRun" | "saved" => (s("what"), l["runs"].clone()),
        "uncovered" => (s("file"), l["runs"].clone()),
        "agentUnavailable" => (s("agent"), l["runs"].clone()),
        "agentFallback" => (s("agent"), l.clone()),
        "workflow" => (s("name"), l.clone()),
        "lens" | "noise" => (s("lens"), l.clone()),
        "contradictions" => (s("chain"), l.clone()),
        "depth" => (format!("{} {}", s("chain"), s("depth")), l.clone()),
        "unfinishedRun" => (s("ts"), l.clone()),
        _ => return None,
    })
}

/// The NDJSON lines filed by section: a singleton section as its line, a keyed one by its key.
fn filed(lines: &[Value]) -> Map<String, Value> {
    let mut out = Map::new();
    for l in lines {
        let section = l["section"].as_str().unwrap();
        match keyed(section, l) {
            Some((k, v)) => {
                let rows = out.entry(section).or_insert_with(|| json!({}));
                rows[k] = v;
            }
            None => drop(out.insert(section.to_owned(), l.clone())),
        }
    }
    out
}

/// Fields whose every key the JavaScript reader printed, and no other.
const WHOLE: [&str; 5] = ["apart", "savedByLens", "byBackend", "noneWhy", "bySeverity"];

/// `want` within `have`: each field `want` names has its value; a keyed section and a [`WHOLE`]
/// field carry exactly `want`'s keys.
fn within(want: &Value, have: &Value, at: &str, exact: bool) {
    match (want, have) {
        (Value::Object(w), Value::Object(h)) => {
            if exact {
                let (mut wk, mut hk): (Vec<_>, Vec<_>) = (w.keys().collect(), h.keys().collect());
                wk.sort();
                hk.sort();
                assert_eq!(wk, hk, "{at}: the rows differ");
            }
            for (k, v) in w {
                let next = format!("{at}.{k}");
                assert!(h.contains_key(k), "{next} is missing");
                let have = h.get(k).unwrap();
                within(v, have, &next, WHOLE.contains(&k.as_str()));
            }
        }
        (Value::Number(w), Value::Number(h)) => {
            assert_eq!(w.as_f64(), h.as_f64(), "{at}");
        }
        _ => assert_eq!(want, have, "{at}"),
    }
}

fn holds(want: &Value, lines: &[Value]) {
    let have = Value::Object(filed(lines));
    for (section, w) in want.as_object().unwrap() {
        if section == "version" || section == "sliceEngine" {
            continue;
        }
        let singleton = matches!(
            section.as_str(),
            "summary" | "signals" | "memory" | "sorting" | "develop" | "unfinishedListed"
        );
        let h = have.get(section).cloned().unwrap_or_else(|| json!({}));
        within(w, &h, section, !singleton);
    }
}

#[test]
fn the_retro_prints_what_the_javascript_report_printed() {
    let c = cases();
    let d = laid(&c);
    let (lines, err) = craft(d.path(), &["retro"]);
    holds(&c["expected"]["retro"], &lines);
    assert!(err.contains("2026-12-01T00-00-00Z-broken.json"), "{err}");
}

#[test]
fn a_version_retro_prints_what_the_javascript_version_slice_printed() {
    let c = cases();
    let d = laid(&c);
    let want = &c["expected"]["retroVersion"];
    let (lines, _) = craft(d.path(), &["retro", want["version"].as_str().unwrap()]);
    holds(want, &lines);
}

#[test]
fn an_engine_retro_prints_what_the_javascript_engine_slice_printed() {
    let c = cases();
    let d = laid(&c);
    let want = &c["expected"]["retroEngine"];
    let engine = want["sliceEngine"].as_str().unwrap();
    let (lines, _) = craft(d.path(), &["retro", "--engine", engine]);
    holds(want, &lines);
}

#[test]
fn the_hooks_print_what_the_javascript_hook_section_printed() {
    let c = cases();
    let d = laid(&c);
    let log = d.path().join("hooks.jsonl");
    let (lines, err) = craft(d.path(), &["hooks", "--log", log.to_str().unwrap()]);
    let want = &c["expected"]["hooks"];
    let rows: Map<String, Value> = lines
        .iter()
        .filter(|l| l["section"] == "hook")
        .map(|l| (l["group"].as_str().unwrap().to_owned(), l.clone()))
        .collect();
    within(&want["rows"], &Value::Object(rows), "hooks", true);
    let join = lines.iter().find(|l| l["section"] == "hookJoin").unwrap();
    within(&want["join"], join, "join", false);
    assert!(err.contains("passed over 1 line(s)"), "{err}");
}

#[test]
fn the_round_pairs_are_what_the_javascript_pairing_found() {
    let c = cases();
    let d = laid(&c);
    let (lines, _) = craft(d.path(), &["round-pairs"]);
    let want = &c["expected"]["roundPairs"];
    let pairs: Map<String, Value> = lines
        .iter()
        .filter(|l| l["section"] == "roundPair")
        .map(|l| {
            let key = format!(
                "{} {}>{}",
                l["branch"].as_str().unwrap(),
                l["fromRound"],
                l["toRound"]
            );
            (key, l.clone())
        })
        .collect();
    within(&want["pairs"], &Value::Object(pairs), "pairs", true);
    let excluded: Map<String, Value> = lines
        .iter()
        .filter(|l| l["section"] == "roundsExcluded")
        .map(|l| {
            (
                l["reason"].as_str().unwrap().to_owned(),
                l["records"].clone(),
            )
        })
        .collect();
    within(
        &want["excluded"],
        &Value::Object(excluded),
        "excluded",
        true,
    );
}
