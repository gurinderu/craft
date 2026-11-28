//! A review run through the binary's own driver (`craft review run`, a stand-in `codex` giving the
//! smallest answer each task's schema allows, one Medium finding to the first lens and its verifier's
//! confirming vote) files its record, and `craft runs retro` reads that
//! record as it was filed: a lens row per lens it ran, the workflow's refute rate, its depth.
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

mod common;

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

/// A stand-in `codex exec`: to `-o` the smallest value the `--output-schema` admits.
const FAKE_CODEX: &str = r"#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const at = f => argv[argv.indexOf(f) + 1]
const fill = s => {
  if (!s || typeof s !== 'object') return null
  if (Array.isArray(s.enum)) return s.enum[0]
  if ('const' in s) return s.const
  if (s.anyOf) return fill(s.anyOf.find(x => x.type === 'null') ?? s.anyOf[0])
  const t = Array.isArray(s.type) ? (s.type.includes('null') ? 'null' : s.type[0]) : s.type
  if (t === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fill(v)]))
  return { array: [], string: '', integer: s.minimum ?? 0, number: s.minimum ?? 0, boolean: false }[t] ?? null
}
fs.readFileSync(0, 'utf8')
const schema = JSON.parse(fs.readFileSync(at('--output-schema'), 'utf8'))
const answer = fill(schema)
const lens = (schema.required ?? []).includes('lens') && 'findings' in (schema.properties ?? {})
if (lens && !fs.existsSync(process.env.FAKE_MARK)) {
  fs.writeFileSync(process.env.FAKE_MARK, '')
  answer.findings = [{ severity: 'Medium', title: 'x[1] panics on a slice shorter than two', file: 'src/lib.rs', line: 1,
    why: 'an out-of-bounds index panics', fix: 'use get', blastRadius: '', source: '', ruleId: '', whereChecked: '' }]
}
if ((schema.required ?? []).includes('verdicts')) {
  answer.verdicts = [{ index: 0, refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true,
    behaviourIntended: false, harmSupported: true, confirmedHarmLevel: 'outage', reason: 'x[1] on a short slice panics' }]
}
fs.writeFileSync(at('-o'), JSON.stringify(answer))
";

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .status()
        .unwrap();
    assert!(ok.success(), "git {args:?}");
}

/// A repository whose branch adds an indexing bug over `origin/main`.
fn reviewed(dir: &Path) {
    std::fs::create_dir_all(dir.join("src")).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    std::fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"s\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("src/lib.rs"), "pub fn f() -> u8 { 1 }\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "init"]);
    git(dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(
        dir.join("src/lib.rs"),
        "pub fn f(x: &[u8]) -> u8 { x[1] }\n",
    )
    .unwrap();
    git(dir, &["commit", "-qam", "feat: index"]);
}

fn lines(out: &std::process::Output) -> Vec<Value> {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// The review run under `tmp` to its verdict: the home it filed under, and the one record it filed.
fn filed(tmp: &Path) -> (std::path::PathBuf, Value) {
    let (repo, home, fake) = (tmp.join("repo"), tmp.join("home"), tmp.join("codex"));
    reviewed(&repo);
    std::fs::create_dir_all(&home).unwrap();
    common::write_executable(&fake, FAKE_CODEX).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../integrations/claude-code");
    let run = Command::new(env!("CARGO_BIN_EXE_craft"))
        .env("CRAFT_CODE_GRAPH", "")
        .args([
            "review",
            "run",
            "--backend",
            "codex",
            "--base",
            "origin/main",
        ])
        .args(["--no-gate", "--no-recall", "--depth", "light", "--cwd"])
        .arg(&repo)
        .arg("--host-bin")
        .arg(&fake)
        .arg("--craft-root")
        .arg(&root)
        .env("HOME", &home)
        .env("FAKE_MARK", tmp.join("found"))
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let store = home.join(".craft/runs");
    let filed: Vec<Value> = std::fs::read_dir(&store)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap())
        .collect();
    assert_eq!(filed.len(), 1, "one record filed: {filed:?}");
    (home, filed.into_iter().next().unwrap())
}

#[test]
fn a_record_the_binary_filed_is_read_as_it_was_filed() {
    let tmp = tempfile::tempdir().unwrap();
    let (home, record) = filed(tmp.path());
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "retro", "--json"])
        .env("HOME", &home)
        .output()
        .unwrap();
    let ls = lines(&out);
    let ran: Vec<&Value> = record["dimensions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["ran"] != json!(false))
        .collect();
    assert!(!ran.is_empty(), "the light round ran its lenses: {record}");
    let found: f64 = ran.iter().filter_map(|d| d["findingCount"].as_f64()).sum();
    assert!(found >= 1.0, "one lens found the bug: {record}");
    for d in ran {
        let name = format!("{} (cli)", d["dimension"].as_str().unwrap());
        let row = ls
            .iter()
            .find(|l| l["section"] == "lens" && l["lens"] == json!(name))
            .unwrap_or_else(|| panic!("{name}: {ls:?}"));
        assert_eq!(
            (row["runs"].clone(), row["findings"].clone()),
            (json!(1), d["findingCount"].clone()),
            "{name}"
        );
    }
    assert_eq!(
        (
            record["verification"]["candidates"].clone(),
            record["verification"]["confirmed"].clone()
        ),
        (json!(1), json!(1)),
        "the verifier's vote landed: one candidate judged and confirmed: {record}"
    );
    let flow = ls.iter().find(|l| l["section"] == "workflow").unwrap();
    assert_eq!(flow["name"], json!("review (cli)"));
    assert_eq!(
        flow["avgRefute"], record["verification"]["refuteRate"],
        "{flow}"
    );
    assert!(
        record["runtimeStats"]["agents"]
            .as_f64()
            .is_some_and(|n| n > 0.0),
        "{record}"
    );
    let depth = ls
        .iter()
        .find(|l| l["section"] == "depth" && l["chain"] == "cli" && l["depth"] == "light")
        .unwrap();
    assert_eq!(
        (depth["runs"].clone(), depth["agentsPerRun"].clone()),
        (json!(1), record["runtimeStats"]["agents"].clone()),
        "{depth}"
    );
}
