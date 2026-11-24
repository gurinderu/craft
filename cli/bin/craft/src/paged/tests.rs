//! A paged step: written whole, read back page by page into the same value, every count checked.

use serde_json::{Value, json};

use super::cut::{PAGE_UNITS, byte_at, page as cut_page, units};
use super::{FILE, page};

/// One printed page: its header's total, from and count, its body, and its closing end.
struct Printed {
    total: usize,
    from: usize,
    count: usize,
    body: String,
    end: usize,
}

fn printed(text: &str, from: usize) -> Printed {
    let mut out = Vec::new();
    page(
        &mut out,
        std::path::Path::new("/run/host-step.out"),
        text,
        from,
    )
    .unwrap();
    let out = String::from_utf8(out).unwrap();
    let lines: Vec<&str> = out.split('\n').collect();
    assert_eq!(
        lines.len(),
        4,
        "a header, one body line, a closing line: {out}"
    );
    let head: Vec<&str> = lines[0].split(' ').collect();
    assert_eq!(&head[..2], ["craft-out", "/run/host-step.out"]);
    let n = |s: &str| s.parse::<usize>().unwrap();
    Printed {
        total: n(head[2]),
        from: n(head[3]),
        count: n(head[4]),
        body: lines[1].to_owned(),
        end: n(lines[2].strip_prefix("craft-page ").unwrap()),
    }
}

/// Every page of `text`, joined as the driver joins them, each count checked as it checks them.
fn read_back(text: &str) -> (usize, String) {
    let (mut pages, mut joined, mut from) = (0, String::new(), 0);
    loop {
        let p = printed(text, from);
        assert_eq!((p.total, p.from), (units(text), from));
        assert_eq!(units(&p.body), p.count);
        assert_eq!(p.end, from + p.count);
        assert!(p.count <= PAGE_UNITS, "{}", p.count);
        joined.push_str(&p.body);
        pages += 1;
        if p.end == p.total {
            return (pages, joined);
        }
        assert!(p.count > 0, "a page that moves nothing");
        from = p.end;
    }
}

/// A step whose strings end in a comma, hold `,"`, and carry characters of every UTF-8 and UTF-16
/// width, long enough to cross many pages.
fn big() -> Value {
    let tasks: Vec<Value> = (0..400)
        .map(|i| {
            json!({"id": format!("lens-{i},"), "label": "é — \",\" 🦀 ,", "note": "a, \"b\",", "path": format!("/run/tasks/{i}.md")})
        })
        .collect();
    json!({"run": "/run", "done": false, "tasks": tasks})
}

#[test]
fn a_large_step_comes_back_the_same_value_from_its_pages() {
    let text = serde_json::to_string(&big()).unwrap();
    let (pages, joined) = read_back(&text);
    assert!(pages > 3, "{pages}");
    assert_eq!(joined, text);
    assert_eq!(serde_json::from_str::<Value>(&joined).unwrap(), big());
}

#[test]
fn a_cut_never_splits_a_character_nor_sits_beside_whitespace() {
    // Four-byte characters, two UTF-16 units each, then spaces where the bound falls.
    let text = format!("{}{}", "🦀".repeat(PAGE_UNITS / 2 - 3), " x ".repeat(10));
    let body = cut_page(&text);
    assert!(text.starts_with(body));
    assert!(units(body) <= PAGE_UNITS);
    assert!(
        !body.ends_with(' ') && !text.get(body.len()..).unwrap().starts_with(' '),
        "{}",
        body.len()
    );
    assert_eq!(byte_at("🦀a", 1), None, "inside a surrogate pair");
    assert_eq!(byte_at("🦀a", 2), Some(4));
    assert_eq!(byte_at("🦀a", 3), Some(5));
    assert_eq!(byte_at("🦀a", 4), None, "past the end");
}

#[test]
fn a_page_holds_as_much_as_its_bound_allows() {
    let text = "y".repeat(PAGE_UNITS * 2 + 1);
    assert_eq!(printed(&text, 0).count, PAGE_UNITS);
    assert_eq!(printed(&text, PAGE_UNITS * 2).count, 1);
    // A step that fits is one page.
    assert_eq!(read_back("{\"run\":\"/r\"}").0, 1);
}

#[test]
fn an_offset_inside_a_character_is_refused() {
    let mut out = Vec::new();
    let err = page(&mut out, std::path::Path::new("/f"), "🦀", 1).unwrap_err();
    assert!(err.to_string().contains("no character boundary"), "{err}");
}

#[test]
fn a_paged_step_is_written_to_its_run_directory() {
    let t = tempfile::tempdir().unwrap();
    let run = t.path().display().to_string();
    let step =
        json!({"run": run, "done": true, "verdict": "Block", "report": "/r.md", "ledger": [1]});
    let mut out = Vec::new();
    super::step_to(&mut out, &step, &super::Paging { paged: true }).unwrap();
    assert!(String::from_utf8(out).unwrap().starts_with("craft-out "));
    let saved = std::fs::read_to_string(t.path().join(FILE)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap(),
        crate::printed::for_host(step)
    );
    assert!(!t.path().join("host-step.out.tmp").exists());
}

#[test]
fn a_step_whose_file_cannot_be_written_is_printed_whole_and_not_lost() {
    let t = tempfile::tempdir().unwrap();
    let run = t.path().join("gone").display().to_string();
    let step = json!({"run": run, "done": false, "tasks": []});
    let mut out = Vec::new();
    super::step_to(&mut out, &step, &super::Paging { paged: true }).unwrap();
    let out = String::from_utf8(out).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), step, "{out}");
    // Without --paged, or with no run named, the step is printed whole too.
    for (step, paged) in [(step.clone(), false), (json!({"done": false}), true)] {
        let mut out = Vec::new();
        super::step_to(&mut out, &step, &super::Paging { paged }).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&String::from_utf8(out).unwrap()).unwrap(),
            step
        );
    }
}
