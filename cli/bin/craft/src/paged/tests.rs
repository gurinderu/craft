//! A paged step: written whole, read back page by page into the same value.

use serde_json::{Value, json};

use super::{FILE, PAGE_CHARS, page};

/// Every page of `text` from line 1, each as printed, and the lines they carry joined.
fn pages(text: &str) -> (Vec<String>, String) {
    let file = std::path::Path::new("/run/host-step.out");
    let (mut printed, mut body, mut from) = (Vec::new(), Vec::new(), 1);
    loop {
        let mut out = Vec::new();
        page(&mut out, file, text, from).unwrap();
        let out = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(
            lines[0],
            format!("craft-out {} {}", file.display(), text.lines().count())
        );
        let last: usize = lines
            .last()
            .unwrap()
            .strip_prefix("craft-page ")
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(lines.len() - 2, last + 1 - from, "{out}");
        body.extend(lines[1..lines.len() - 1].iter().map(|l| (*l).to_owned()));
        printed.push(out);
        if last >= text.lines().count() {
            return (printed, body.join("\n"));
        }
        from = last + 1;
    }
}

fn big() -> Value {
    let tasks: Vec<Value> = (0..300)
        .map(|i| json!({"id": format!("lens-{i}"), "label": "lens:é — \",\"", "promptFile": format!("/run/tasks/lens-{i}.md")}))
        .collect();
    json!({"run": "/run", "done": false, "tasks": tasks})
}

#[test]
fn a_large_step_comes_back_whole_from_its_pages_each_within_the_bound() {
    let text = serde_json::to_string(&big())
        .unwrap()
        .replace(",\"", ",\n\"");
    let (printed, body) = pages(&text);
    assert!(printed.len() > 2, "{}", printed.len());
    for p in &printed {
        let lines: Vec<&str> = p.lines().collect();
        let chars: usize = lines[1..lines.len() - 1]
            .iter()
            .map(|l| l.chars().count() + 1)
            .sum();
        assert!(chars <= PAGE_CHARS, "{chars}");
    }
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), big());
}

#[test]
fn a_line_longer_than_a_page_is_a_page_of_its_own() {
    let long = "x".repeat(PAGE_CHARS * 2);
    let text = format!("a\n{long}\nb");
    let mut out = Vec::new();
    page(&mut out, std::path::Path::new("/f"), &text, 2).unwrap();
    let out = String::from_utf8(out).unwrap();
    assert!(
        out.ends_with(&format!("{long}\ncraft-page 2\n")),
        "{}",
        out.len()
    );
    let (_, body) = pages(&text);
    assert_eq!(body, text);
}

#[test]
fn a_paged_step_is_written_to_its_run_directory() {
    let t = tempfile::tempdir().unwrap();
    let run = t.path().display().to_string();
    let step =
        json!({"run": run, "done": true, "verdict": "Block", "report": "/r.md", "ledger": [1]});
    super::print(&step, &super::Paging { paged: true }).unwrap();
    let saved = std::fs::read_to_string(t.path().join(FILE)).unwrap();
    let back: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(back, crate::printed::for_host(step));
    assert!(saved.lines().count() > 1, "{saved}");
}
