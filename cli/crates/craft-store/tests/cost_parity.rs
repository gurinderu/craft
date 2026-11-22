//! `craft runs enrich-cost` held to the JavaScript enrich-cost it replaced by
//! `content/parity/cost-cases.json`, frozen golden data: each case's files laid under a Claude
//! home that is also the store, the run enriched, and what it said and left behind compared — then
//! enriched again, which changes nothing.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the test it serves"
)]

use std::collections::BTreeMap;
use std::path::Path;

use craft_store::js::{Js, parse};

fn cases() -> Js {
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/parity/cost-cases.json");
    parse(&std::fs::read_to_string(file).unwrap()).unwrap()
}

fn files_under(dir: &Path, at: &str, out: &mut BTreeMap<String, String>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir.join(at)).unwrap().flatten().collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for e in entries {
        let rel = if at.is_empty() {
            e.file_name().to_string_lossy().into_owned()
        } else {
            format!("{at}/{}", e.file_name().to_string_lossy())
        };
        let kind = e.file_type().unwrap();
        if kind.is_symlink() {
            let to = std::fs::read_link(dir.join(&rel)).unwrap();
            out.insert(rel, format!("link:{}", to.display()));
        } else if kind.is_dir() {
            files_under(dir, &rel, out);
        } else {
            out.insert(
                rel.clone(),
                std::fs::read_to_string(dir.join(&rel)).unwrap(),
            );
        }
    }
}

struct Dirs {
    home: String,
    elsewhere: String,
}

impl Dirs {
    fn real(&self, s: &str) -> String {
        s.replace("<home>", &self.home)
            .replace("<elsewhere>", &self.elsewhere)
    }
    fn back(&self, s: &str) -> String {
        s.replace(&self.home, "<home>")
            .replace(&self.elsewhere, "<elsewhere>")
    }
    fn listed(&self, dir: &str) -> BTreeMap<String, String> {
        let mut got = BTreeMap::new();
        files_under(Path::new(dir), "", &mut got);
        got.into_iter()
            .map(|(k, v)| (self.back(&k), self.back(&v)))
            .collect()
    }
}

fn texts(v: &Js) -> BTreeMap<String, String> {
    v.as_obj()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.to_utf8().unwrap(), v.as_str().unwrap().to_owned()))
        .collect()
}

fn lay(case: &craft_store::js::Obj, d: &Dirs) {
    for (rel, text) in case.get("files").unwrap().as_obj().unwrap().iter() {
        let rel = rel.to_utf8().unwrap();
        let at = if rel.starts_with("<elsewhere>") {
            d.real(&rel)
        } else {
            format!("{}/{rel}", d.home)
        };
        std::fs::create_dir_all(Path::new(&at).parent().unwrap()).unwrap();
        std::fs::write(&at, d.real(text.as_str().unwrap())).unwrap();
    }
    for (rel, to) in case.get("links").unwrap().as_obj().unwrap().iter() {
        let at = format!("{}/{}", d.home, rel.to_utf8().unwrap());
        std::fs::create_dir_all(Path::new(&at).parent().unwrap()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(format!("{}/{}", d.home, to.as_str().unwrap()), &at).unwrap();
    }
}

#[test]
fn every_case_enriches_as_the_javascript_enrich_cost_did_and_again_changes_nothing() {
    let file = cases();
    let all = file
        .as_obj()
        .unwrap()
        .get("cases")
        .unwrap()
        .as_arr()
        .unwrap();
    assert!(all.len() >= 20);
    for case in all {
        let case = case.as_obj().unwrap();
        let name = case.text("name").unwrap();
        if cfg!(not(unix)) && !case.get("links").unwrap().as_obj().unwrap().is_empty() {
            continue;
        }
        let (h, e) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let d = Dirs {
            home: std::fs::canonicalize(h.path())
                .unwrap()
                .display()
                .to_string(),
            elsewhere: std::fs::canonicalize(e.path())
                .unwrap()
                .display()
                .to_string(),
        };
        lay(case, &d);
        let want = case.get("expected").unwrap().as_obj().unwrap();
        let home = Path::new(&d.home);
        let got = craft_store::cost::enrich_run(case.text("runId").unwrap(), home, home);
        match (&got, want.get("ok") == Some(&Js::Bool(true))) {
            (Ok(said), true) => {
                let lines: Vec<String> = said.lines.iter().map(|l| d.back(l)).collect();
                let want_lines: Vec<&str> = want
                    .get("stdout")
                    .unwrap()
                    .as_arr()
                    .unwrap()
                    .iter()
                    .map(|l| l.as_str().unwrap())
                    .collect();
                assert_eq!(lines, want_lines, "{name}: stdout");
                let warnings: Vec<String> = said.warnings.iter().map(|l| d.back(l)).collect();
                let want_warnings = want.get("warnings").unwrap().as_arr().unwrap();
                assert_eq!(warnings.len(), want_warnings.len(), "{name}: {warnings:?}");
                for (w, x) in warnings.iter().zip(want_warnings) {
                    assert!(
                        w.starts_with(x.as_str().unwrap()),
                        "{name}: {w} is not {x:?}"
                    );
                }
            }
            (Err(why), false) => {
                let why = d.back(why);
                assert!(
                    why.starts_with(want.text("error").unwrap()),
                    "{name}: {why}"
                );
            }
            (got, _) => panic!("{name}: {got:?}"),
        }
        assert_eq!(
            d.listed(&d.home),
            texts(want.get("home").unwrap()),
            "{name}: home"
        );
        assert_eq!(
            d.listed(&d.elsewhere),
            texts(want.get("elsewhere").unwrap()),
            "{name}: elsewhere"
        );
        let again = craft_store::cost::enrich_run(case.text("runId").unwrap(), home, home);
        assert_eq!(again.is_ok(), got.is_ok(), "{name}: again");
        assert_eq!(
            d.listed(&d.home),
            texts(want.get("home").unwrap()),
            "{name}: again, home"
        );
    }
}

#[test]
fn every_run_directory_case_sums_as_the_javascript_enrich_cost_did_and_again_changes_nothing() {
    let file = cases();
    let all = file
        .as_obj()
        .unwrap()
        .get("runDirCases")
        .unwrap()
        .as_arr()
        .unwrap();
    assert!(all.len() >= 7);
    for case in all {
        let case = case.as_obj().unwrap();
        let name = case.text("name").unwrap();
        let h = tempfile::tempdir().unwrap();
        let d = Dirs {
            home: std::fs::canonicalize(h.path())
                .unwrap()
                .display()
                .to_string(),
            elsewhere: "<no elsewhere>".into(),
        };
        lay(
            &case
                .clone()
                .with("links", Js::Obj(craft_store::js::Obj::new())),
            &d,
        );
        let want = case.get("expected").unwrap().as_obj().unwrap();
        let home = Path::new(&d.home);
        let (dir, record) = (
            home.join(case.text("runDir").unwrap()),
            home.join(case.text("record").unwrap()),
        );
        let store = home.join("store");
        let got = craft_store::cost::enrich_dir(&dir, &record, &store);
        match (&got, want.get("ok") == Some(&Js::Bool(true))) {
            (Ok(said), true) => {
                let lines: Vec<String> = said.lines.iter().map(|l| d.back(l)).collect();
                let want_lines: Vec<&str> = want
                    .get("stdout")
                    .unwrap()
                    .as_arr()
                    .unwrap()
                    .iter()
                    .map(|l| l.as_str().unwrap())
                    .collect();
                assert_eq!(lines, want_lines, "{name}: stdout");
                let want_warnings = want.get("warnings").unwrap().as_arr().unwrap();
                assert_eq!(
                    said.warnings.len(),
                    want_warnings.len(),
                    "{name}: {:?}",
                    said.warnings
                );
                for (w, x) in said.warnings.iter().zip(want_warnings) {
                    assert!(
                        d.back(w).starts_with(x.as_str().unwrap()),
                        "{name}: {w} is not {x:?}"
                    );
                }
            }
            (Err(why), false) => assert!(
                d.back(why).starts_with(want.text("error").unwrap()),
                "{name}: {why}"
            ),
            (got, _) => panic!("{name}: {got:?}"),
        }
        assert_eq!(
            d.listed(&d.home),
            texts(want.get("home").unwrap()),
            "{name}: home"
        );
        let again = craft_store::cost::enrich_dir(&dir, &record, &store);
        assert_eq!(again.is_ok(), got.is_ok(), "{name}: again");
        assert_eq!(
            d.listed(&d.home),
            texts(want.get("home").unwrap()),
            "{name}: again, home"
        );
    }
}
