//! The Rust writer held to the JavaScript one by `content/parity/store-cases.json`, which
//! `lib/store-parity.test.mjs` writes from `lib/binary-filing-replay.mjs` over `lib/craft-log-run.mjs`:
//! each case's requests answered in a fresh repository and store, the answers and every file the
//! store holds afterwards byte for byte, with the same placeholders put back.
#![expect(
    clippy::unwrap_used,
    clippy::cast_possible_truncation,
    reason = "the fixture fails the test loudly, like the test it serves"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use craft_store::adapter::Env;
use craft_store::js::{Js, Obj, parse};

fn cases() -> Js {
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/parity/store-cases.json");
    parse(&std::fs::read_to_string(file).unwrap()).unwrap()
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn repo_of(kind: &str, repo: &Path) {
    if kind == "plain" {
        return;
    }
    git(repo, &["init", "-q", "-b", "feat/x"]);
    std::fs::write(repo.join("a.rs"), "fn a() {}\n").unwrap();
    git(repo, &["add", "a.rs"]);
    git(repo, &["commit", "-q", "-m", "a"]);
    if kind == "dirty" {
        std::fs::write(repo.join("b.rs"), "\n").unwrap();
    }
}

fn map_strings(v: &Js, f: &dyn Fn(&str) -> String) -> Js {
    match v {
        Js::Str(s) => Js::str(s.map_unicode(f)),
        Js::Arr(a) => Js::Arr(a.iter().map(|x| map_strings(x, f)).collect()),
        Js::Obj(o) => {
            let mut out = Obj::new();
            for (k, x) in o.iter() {
                out.set(k.clone(), map_strings(x, f));
            }
            Js::Obj(out)
        }
        other @ (Js::Null | Js::Bool(_) | Js::Num(_)) => other.clone(),
    }
}

/// A file's bytes as the parity file holds them: each line as text, or `hex:<bytes>` for one that
/// is not UTF-8.
fn shown(bytes: &[u8]) -> String {
    bytes
        .split(|b| *b == b'\n')
        .map(|l| match std::str::from_utf8(l) {
            Ok(t) => t.to_owned(),
            Err(_) => format!(
                "hex:{}",
                l.iter().map(|b| format!("{b:02x}")).collect::<String>()
            ),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn hex(h: &str) -> Vec<u8> {
    h.as_bytes()
        .chunks(2)
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
        .collect()
}

fn files_under(dir: &Path, at: &str, out: &mut BTreeMap<String, String>) {
    for e in std::fs::read_dir(dir.join(at)).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if at.is_empty() {
            name
        } else {
            format!("{at}/{name}")
        };
        if e.file_type().unwrap().is_dir() {
            files_under(dir, &rel, out);
        } else {
            out.insert(rel.clone(), shown(&std::fs::read(dir.join(&rel)).unwrap()));
        }
    }
}

struct Real {
    store: String,
    repo: String,
    head: String,
    short: String,
}

impl Real {
    fn back(&self, s: &str) -> String {
        let mut t = s
            .replace(&self.store, "<store>")
            .replace(&self.repo, "<repo>");
        if !self.head.is_empty() {
            t = t.replace(&self.head, "<head>");
            t = t.replace(&format!("\"{}\"", self.short), "\"<short>\"");
        }
        let proof = regex::Regex::new(r"\b(dir-)?[0-9a-f]{64}\b").unwrap();
        proof
            .replace_all(&t, |c: &regex::Captures<'_>| {
                format!("{}<proof>", c.get(1).map_or("", |m| m.as_str()))
            })
            .into_owned()
    }
}

/// The request as the JavaScript test sent it: its defaults under the case's own fields.
fn request(raw: &Obj) -> Obj {
    let mut o = Obj::new()
        .with("repo", Js::str("<repo>"))
        .with("craftVersion", Js::str("0.55.0"))
        .with("session", Js::str(""))
        .with("dir", Js::str(""))
        .with("rejoin", Js::Bool(false))
        .with("steps", Js::Arr(Vec::new()))
        .with("head", Js::str(""));
    o.spread(raw);
    o
}

#[test]
fn every_case_files_as_the_javascript_writer_filed_it() {
    let file = cases();
    let all = file
        .as_obj()
        .unwrap()
        .get("cases")
        .unwrap()
        .as_arr()
        .unwrap();
    assert!(all.len() >= 5);
    for case in all {
        let case = case.as_obj().unwrap();
        let name = case.text("name").unwrap();
        let (repo_dir, store_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let repo = std::fs::canonicalize(repo_dir.path()).unwrap();
        let store = std::fs::canonicalize(store_dir.path()).unwrap();
        repo_of(case.text("repo").unwrap(), &repo);
        let plain = case.text("repo").unwrap() == "plain";
        let real = Real {
            store: store.display().to_string(),
            repo: repo.display().to_string(),
            head: if plain {
                String::new()
            } else {
                git(&repo, &["rev-parse", "HEAD"])
            },
            short: if plain {
                String::new()
            } else {
                git(&repo, &["rev-parse", "--short", "HEAD"])
            },
        };
        let env = Env {
            store: store.clone(),
            craft_commit: Some("<craft>".into()),
            now: case.get("now").unwrap().as_num().unwrap() as i64,
        };
        let (mut run_dir, mut record_file) = (String::new(), String::new());
        let mut answers = Vec::new();
        for call in case.get("calls").unwrap().as_arr().unwrap() {
            let call = call.as_obj().unwrap();
            let req = request(call.get("request").unwrap().as_obj().unwrap());
            let req = map_strings(&Js::Obj(req), &|s| {
                s.replace("<runDir>", &run_dir)
                    .replace("<recordFile>", &record_file)
                    .replace("<repo>", &real.repo)
                    .replace("<head>", &real.head)
                    .replace("<store>", &real.store)
            });
            let req = req.as_obj().unwrap();
            if call.text("command").unwrap() == "write" {
                // A file laid in the store as another writer left it.
                let at = Path::new(req.text("path").unwrap());
                std::fs::create_dir_all(at.parent().unwrap()).unwrap();
                let bytes = match req.get("hex").and_then(Js::as_str) {
                    Some(h) => hex(h),
                    None => req.text("text").unwrap().as_bytes().to_vec(),
                };
                std::fs::write(at, bytes).unwrap();
                let wrote = Obj::new().with("wrote", Js::str(real.back(req.text("path").unwrap())));
                answers.push(Js::Obj(wrote));
                continue;
            }
            let got = craft_store::answer_js(call.text("command").unwrap(), req, &env).unwrap();
            if !got.text("runDir").unwrap().is_empty() {
                run_dir = got.text("runDir").unwrap().to_owned();
            }
            if !got.text("file").unwrap().is_empty() {
                record_file = got.text("file").unwrap().to_owned();
            }
            answers.push(parse(&real.back(&Js::Obj(got).compact())).unwrap());
        }
        let want = case.get("expected").unwrap().as_obj().unwrap();
        assert_eq!(
            Js::Arr(answers).pretty(),
            want.get("answers").unwrap().pretty(),
            "{name}: answers"
        );
        let mut files = BTreeMap::new();
        files_under(&store, "", &mut files);
        let files: BTreeMap<String, String> = files
            .iter()
            .map(|(k, v)| (real.back(k), real.back(v)))
            .collect();
        let want_files = want.get("files").unwrap().as_obj().unwrap();
        let want_files: BTreeMap<String, String> = want_files
            .iter()
            .map(|(k, v)| (k.to_utf8().unwrap(), v.as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(
            files.keys().collect::<Vec<_>>(),
            want_files.keys().collect::<Vec<_>>(),
            "{name}: files"
        );
        for (k, v) in &want_files {
            assert_eq!(&files[k], v, "{name}: {k}");
        }
    }
}
