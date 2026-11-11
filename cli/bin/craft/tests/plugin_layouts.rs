//! `craft review run` against craft as each host installs it, every symlink gone (realm @nick/craft,
//! node #500): Codex copies the repository root and drops the Claude Code delivery's links to
//! `skills/`, `lib/`, `content/` and `src/`, leaving only `integrations/claude-code/agents/` real; the
//! Claude Code release branch holds the delivery with those links made real directories. On both, a
//! review run by a stand-in `codex` (the smallest answer each task's schema allows) reaches its
//! verdict, the tasks are told of skills that exist and given the agents' bodies, and the run is
//! filed through the plugin's own `lib/`.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

/// A stand-in `codex exec`: the prompt appended to `FAKE_LOG`, and to `-o` the smallest value the
/// `--output-schema` admits — null where it may be, else the first enum value or an empty one.
const FAKE_CODEX: &str = r#"#!/usr/bin/env node
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
fs.appendFileSync(process.env.FAKE_LOG, fs.readFileSync(0, 'utf8') + '\n')
fs.writeFileSync(at('-o'), JSON.stringify(fill(JSON.parse(fs.readFileSync(at('--output-schema'), 'utf8')))))
"#;

fn checkout() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn git(dir: &Path, args: &[&str]) {
    let _out = git_out(dir, args);
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap()
}

/// The checkout's tracked files as Codex installs them: no symlink, and none of `cli/`.
fn codex_copy(to: &Path) {
    let from = checkout();
    for line in git_out(&from, &["ls-files", "-s"]).lines() {
        let (meta, file) = line.split_once('\t').unwrap();
        if meta.starts_with("120000") || file.starts_with("cli/") {
            continue;
        }
        let dest = to.join(file);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::copy(from.join(file), &dest).unwrap();
    }
}

/// `dir` copied under `to`, recursively.
fn copy_dir(dir: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let dest = to.join(path.file_name().unwrap());
        if path.is_dir() {
            copy_dir(&path, &dest);
        } else {
            std::fs::copy(&path, &dest).unwrap();
        }
    }
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

/// The review run with the stand-in Codex and `root` as the plugin, to its verdict: the answer,
/// every task's prompt, and the home the run was filed under.
fn review(tmp: &Path, root: &Path) -> (String, String, PathBuf) {
    let (repo, home, log) = (tmp.join("repo"), tmp.join("home"), tmp.join("prompts"));
    reviewed(&repo);
    std::fs::create_dir_all(&home).unwrap();
    let fake = tmp.join("codex");
    common::write_executable(&fake, FAKE_CODEX).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
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
        .arg(root)
        .env("HOME", &home)
        .env("FAKE_LOG", &log)
        .env_remove("CLAUDE_PLUGIN_ROOT")
        .env_remove("CRAFT_ROOT")
        .output()
        .unwrap();
    let answer = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{answer}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    (answer, std::fs::read_to_string(&log).unwrap(), home)
}

/// Every `<root>…` path the prompts name, up to its first space or backtick.
fn named(prompts: &str, root: &Path) -> Vec<PathBuf> {
    let root = root.display().to_string();
    prompts
        .split(&root)
        .skip(1)
        .map(|rest| rest.split([' ', '`', '\n', ',']).next().unwrap_or_default())
        .map(|rest| PathBuf::from(format!("{root}{}", rest.trim_end_matches([':', '.']))))
        .collect()
}

/// A finished review over `root`: a verdict, skills that exist, the agents' bodies, a filed record.
fn assert_reviewed(tmp: &Path, root: &Path) {
    let (answer, prompts, home) = review(tmp, root);
    assert!(answer.starts_with("## Verdict\n\n✅ Approve"), "{answer}");
    let skills = named(&prompts, root);
    assert!(!skills.is_empty(), "the prompts name the plugin's files");
    for path in skills
        .iter()
        .filter(|p| !p.to_string_lossy().contains("<name>"))
    {
        assert!(path.exists(), "{} is named but missing", path.display());
    }
    assert!(prompts.contains("You are a senior Rust reviewer."));
    let records = std::fs::read_dir(home.join(".craft/runs")).unwrap();
    let filed = records
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .any(|n| n.ends_with("-workflow-review.json"));
    assert!(filed, "the run's record was filed");
}

#[test]
fn a_codex_install_without_symlinks_resolves_each_plugin_part_where_it_is() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    codex_copy(&root);
    assert!(!root.join("integrations/claude-code/skills").exists());
    assert_reviewed(tmp.path(), &root);
}

#[test]
fn the_materialized_claude_code_delivery_resolves_under_itself() {
    let tmp = tempfile::tempdir().unwrap();
    let copy = tmp.path().join("copy");
    codex_copy(&copy);
    let delivery = copy.join("integrations/claude-code");
    for shared in ["skills", "lib", "content", "src"] {
        copy_dir(&copy.join(shared), &delivery.join(shared));
    }
    let root = tmp.path().join("delivery");
    std::fs::rename(&delivery, &root).unwrap();
    std::fs::remove_dir_all(&copy).unwrap();
    assert_reviewed(tmp.path(), &root);
}
