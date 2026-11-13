//! The loop end to end against a stand-in binary ([`Fake`], acting as the step protocol's binary
//! does) and stand-in host CLIs: shell scripts that act on a word in their task's
//! prompt — FAIL fails, FAIL-ONCE fails the first time, HANG outlives its deadline, LIMIT says the
//! usage limit, NOLOGIN says no account is logged in, BLOCKED (Codex) answers that it could not
//! look — and otherwise answer.

use std::cell::RefCell;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, bail};
use serde_json::{Value, json};

use super::HostKind;
use super::drive::Driver;
use super::ending::{Answer, drive};
use super::events::Event;
use super::exe::write_executable;
use super::host::Host;
use super::models::ModelTable;
use super::protocol::{Protocol, Said};
use super::round::RoundCtx;

/// One task the fake start lays out: its id, prompt, and the agent it names.
struct Spec(&'static str, &'static str, Option<&'static str>);

/// The stand-in binary: one step of tasks; each submit hands out again (twice at most) each task
/// with no answer that was not abandoned, then finishes with one finding and `verdict`.
struct Fake {
    run: PathBuf,
    tasks: Vec<Spec>,
    verdict: &'static str,
    broken: bool,
    /// craft's own worktree the steps name as the run's repo, with its line.
    worktree: Option<PathBuf>,
    submits: RefCell<Vec<Said>>,
    filed: RefCell<Vec<String>>,
}

impl Fake {
    fn new(run: &Path, tasks: Vec<Spec>) -> Self {
        Self {
            run: run.to_path_buf(),
            tasks,
            verdict: "Approve",
            broken: false,
            worktree: None,
            submits: RefCell::default(),
            filed: RefCell::default(),
        }
    }

    fn task(&self, s: &Spec) -> Value {
        let file = |d: &str, ext: &str| {
            self.run
                .join(d)
                .join(format!("{}{ext}", s.0))
                .display()
                .to_string()
        };
        let mut t = json!({"id": s.0, "label": s.0, "model": "opus", "kind": "lens", "promptFile": file("tasks", ".md"), "schemaFile": file("tasks", ".schema.json"), "answerFile": file("answers", ".json")});
        if let (Some(a), Some(o)) = (s.2, t.as_object_mut()) {
            o.insert("agentType".into(), json!(a));
        }
        t
    }

    fn pending(&self, missing: &[&Spec]) -> Value {
        self.placed(json!({"run": self.run, "done": false, "phase": "lenses", "tasks": missing.iter().map(|s| self.task(s)).collect::<Vec<_>>()}))
    }

    /// `step` naming the worktree as the run's repo, when there is one.
    fn placed(&self, mut step: Value) -> Value {
        if let Some(w) = &self.worktree {
            step["repo"] = json!(w);
            step["worktree"] = json!(format!("reviewed in craft's own worktree {}", w.display()));
        }
        step
    }
}

impl Protocol for Fake {
    fn start(&self) -> Result<Value> {
        std::fs::create_dir_all(self.run.join("tasks"))?;
        for s in &self.tasks {
            std::fs::write(self.run.join("tasks").join(format!("{}.md", s.0)), s.1)?;
            let schema = json!({"type": "object", "additionalProperties": false, "required": ["answer"], "properties": {"answer": {"type": "string"}, "note": {"type": "string"}}});
            std::fs::write(
                self.run.join("tasks").join(format!("{}.schema.json", s.0)),
                schema.to_string(),
            )?;
        }
        Ok(self.pending(&self.tasks.iter().collect::<Vec<_>>()))
    }

    fn submit(&self, run: &Path, said: &Said) -> Result<Value> {
        if self.broken {
            bail!("the step could not be read");
        }
        self.submits.borrow_mut().push(said.clone());
        let submits = self.submits.borrow();
        let abandoned: Vec<&String> = submits.iter().flat_map(|s| &s.abandoned).collect();
        let missing: Vec<&Spec> = self
            .tasks
            .iter()
            .filter(|s| {
                !run.join("answers").join(format!("{}.json", s.0)).exists()
                    && !abandoned.iter().any(|a| *a == s.0)
            })
            .collect();
        if !missing.is_empty() && submits.len() < 3 {
            return Ok(self.pending(&missing));
        }
        Ok(self.placed(
            json!({"run": run, "done": true, "report": run.join("report.md"), "verdict": self.verdict, "line": format!("{} — fake review", self.verdict), "findings": [{"severity": "High", "file": "src/a.rs", "line": 3, "title": "a fake finding", "tier": "confirmed"}], "filing": {"record": "filed", "lost": []}}),
        ))
    }

    fn status(&self, _run: &Path) -> Result<Value> {
        Ok(json!({"done": false, "round": 2, "phase": "lenses", "filing": {"finished": null}}))
    }

    fn comment(&self, _run: &Path) -> Result<Value> {
        bail!("not asked")
    }

    fn unfinished(&self, _run: &Path, why: &str) -> Option<Vec<String>> {
        self.filed.borrow_mut().push(why.to_owned());
        Some(Vec::new())
    }
}

/// The stand-in host CLI's script: `read` puts the task's prompt in `$input`, `answer` answers.
fn host_script(log: &Path, read: &str, answer: &str) -> String {
    let log = log.display();
    format!(
        r#"#!/bin/sh
{read}
mkdir -p '{log}/live'; touch '{log}/live/'$$; ls '{log}/live' | wc -l >> '{log}/alive'
printf '%s' "$input" > '{log}/call-'$$; echo "$@" > '{log}/argv-'$$; echo "$CLAUDE_PLUGIN_ROOT" > '{log}/root'; pwd -P > '{log}/cwd'
case "$input" in *HANG*) sleep 30;; esac
sleep 0.3; rm -f '{log}/live/'$$
case "$input" in
  *FAIL-ONCE*) if [ ! -f '{log}/failed-once' ]; then touch '{log}/failed-once'; echo boom >&2; exit 1; fi;;
  *FAIL*) echo boom >&2; exit 1;;
  *NOLOGIN*) echo 'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: x' >&2; echo 'No API key found for x' >&2; exit 1;;
  *LIMIT*) echo "ERROR: You've hit your usage limit. Try again in 3 hours." >&2; exit 1;;
  *BLOCKED*) blocked=1;;
esac
{answer}
"#
    )
}

const CODEX_READ: &str =
    r#"input=$(cat); prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done"#;
const CODEX_ANSWER: &str = r#"if [ -n "$blocked" ]; then printf '{"answer":"","note":null,"blocked":{"couldNotLook":true,"what":"bwrap: Operation not permitted"}}' > "$out"; else printf '{"answer":"ok","note":null}' > "$out"; fi"#;
const PI_READ: &str = r#"for a in "$@"; do msg="$a"; done; file=$(printf '%s' "$msg" | sed -n 's/^Read the file \([^ ]*\) and do.*/\1/p'); input=$(cat "$file")"#;
const PI_ANSWER: &str = r#"printf 'Done.\n```craft-answer\n{"answer": "ok"}\n```\n'"#;
const OPENCODE_READ: &str = r#"msg=$(cat); printf '%s' "$msg" > "$0.msg-$$"; file=$(printf '%s' "$msg" | sed -n 's/^Read the file \([^ ]*\) and do.*/\1/p'); input=$(cat "$file")"#;
const OPENCODE_ANSWER: &str = r#"printf '%s\n' '{"type":"step_start","part":{}}' '{"type":"text","part":{"id":"p","text":"Done.\n```craft-answer\n{\"answer\": \"ok\"}\n```"}}' '{"type":"step_finish","part":{"cost":0.01,"tokens":{"input":5,"output":2}}}'"#;

struct Bench {
    dir: tempfile::TempDir,
    kind: HostKind,
    concurrency: usize,
    deadline: Option<Duration>,
    agents: Option<Vec<String>>,
    events: RefCell<Vec<Event>>,
    /// A stopping signal's exit status, sent this long after the drive starts.
    stop_after: Option<(Duration, u8)>,
}

impl Bench {
    fn new(kind: HostKind) -> Self {
        let dir = tempfile::tempdir().unwrap();
        for d in ["log", "root/agents", "repo", "run"] {
            std::fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        std::fs::write(
            dir.path().join("root/agents/rust-reviewer.md"),
            "---\nname: r\n---\nRUBRIC BODY",
        )
        .unwrap();
        let (read, answer) = match kind {
            HostKind::Codex => (CODEX_READ, CODEX_ANSWER),
            HostKind::Pi => (PI_READ, PI_ANSWER),
            HostKind::OpenCode => (OPENCODE_READ, OPENCODE_ANSWER),
        };
        write_executable(
            &dir.path().join("host"),
            &host_script(&dir.path().join("log"), read, answer),
        )
        .unwrap();
        Self {
            dir,
            kind,
            concurrency: 4,
            deadline: None,
            agents: None,
            events: RefCell::default(),
            stop_after: None,
        }
    }

    fn path(&self, p: &str) -> PathBuf {
        self.dir.path().join(p)
    }

    fn fake(&self, tasks: Vec<Spec>) -> Fake {
        Fake::new(&self.path("run"), tasks)
    }

    async fn drive(&self, fake: &Fake) -> Answer {
        let models: ModelTable = [("opus".to_owned(), "big".to_owned())]
            .into_iter()
            .collect();
        let host = Host {
            kind: self.kind,
            models,
            thinking: super::models::ThinkingTable::new(),
            command: self.path("host"),
            agents: self.agents.clone(),
            archived: true,
        };
        let (root, repo) = (self.path("root"), self.path("repo"));
        let again = |run: &str| {
            format!("this command again, `craft review run --backend codex --run '{run}'`")
        };
        let round = RoundCtx {
            host: &host,
            root: &root,
            repo: &repo,
            concurrency: NonZeroUsize::new(self.concurrency).unwrap(),
            deadline: self.deadline,
            log: &|_| {},
            emit: &|e| self.events.borrow_mut().push(e),
            stop: {
                let (send, stop) = tokio::sync::watch::channel(None);
                if let Some((after, code)) = self.stop_after {
                    tokio::spawn(async move {
                        tokio::time::sleep(after).await;
                        let _gone = send.send(Some(code));
                        std::future::pending::<()>().await;
                    });
                }
                stop
            },
        };
        drive(
            &Driver {
                proto: fake,
                round,
                again: &again,
            },
            None,
            false,
        )
        .await
    }

    fn calls(&self) -> Vec<String> {
        let mut calls: Vec<String> = std::fs::read_dir(self.path("log"))
            .unwrap()
            .filter_map(|e| {
                let e = e.unwrap();
                e.file_name()
                    .to_string_lossy()
                    .starts_with("call-")
                    .then(|| std::fs::read_to_string(e.path()).unwrap())
            })
            .collect();
        calls.sort();
        calls
    }

    fn answer(&self, id: &str) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(self.path("run/answers").join(format!("{id}.json"))).unwrap(),
        )
        .unwrap()
    }
}

#[tokio::test]
async fn codex_tasks_run_in_parallel_up_to_the_limit_with_their_rubric_and_model_and_the_verdict_is_printed()
 {
    let mut bench = Bench::new(HostKind::Codex);
    bench.concurrency = 2;
    let fake = bench.fake(vec![
        Spec("a", "do a", Some("rust-reviewer")),
        Spec("b", "do b", None),
        Spec("c", "do c", None),
    ]);
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    assert!(
        answer
            .text
            .starts_with("## Verdict\n\n✅ Approve — fake review"),
        "{}",
        answer.text
    );
    assert!(
        answer
            .text
            .contains("- [High] src/a.rs:3 — a fake finding (confirmed)"),
        "{}",
        answer.text
    );
    assert_eq!(
        bench.answer("a"),
        json!({"answer": "ok"}),
        "the forced null is dropped"
    );
    let alive = std::fs::read_to_string(bench.path("log/alive")).unwrap();
    assert!(
        alive
            .split_whitespace()
            .all(|n| n.parse::<u32>().unwrap() <= 2),
        "{alive}"
    );
    let calls = bench.calls();
    assert!(
        calls
            .iter()
            .any(|c| c.starts_with("RUBRIC BODY\n\n---\n\n") && c.contains("do a")),
        "{calls:?}"
    );
    assert_eq!(
        std::fs::read_to_string(bench.path("log/root"))
            .unwrap()
            .trim(),
        bench.path("root").display().to_string()
    );
    let submits = fake.submits.borrow();
    assert_eq!((submits.len(), submits[0].agents), (1, 3));
}

#[tokio::test]
async fn a_task_that_fails_once_is_handed_out_again_and_its_retry_answers() {
    let bench = Bench::new(HostKind::Codex);
    let fake = bench.fake(vec![Spec("a", "FAIL-ONCE", None)]);
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    assert_eq!(fake.submits.borrow().len(), 2);
    assert_eq!(bench.answer("a"), json!({"answer": "ok"}));
}

#[tokio::test]
async fn a_late_task_is_abandoned_and_an_agent_with_no_body_said_degraded() {
    let mut bench = Bench::new(HostKind::Codex);
    bench.deadline = Some(Duration::from_secs(2));
    let fake = bench.fake(vec![
        Spec("slow", "HANG", None),
        Spec("n", "do n", Some("nix-reviewer")),
    ]);
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    let submits = fake.submits.borrow();
    assert_eq!(submits[0].abandoned, ["slow"]);
    assert_eq!(submits[0].degraded.len(), 1);
    assert!(
        submits[0].degraded[0].contains("`nix-reviewer`"),
        "{:?}",
        submits[0].degraded
    );
}

#[tokio::test]
async fn a_task_on_the_usage_limit_starts_no_other_and_the_submit_carries_the_limit() {
    let mut bench = Bench::new(HostKind::Codex);
    bench.concurrency = 1;
    let fake = bench.fake(vec![
        Spec("a", "LIMIT", None),
        Spec("b", "do b", None),
        Spec("c", "do c", None),
    ]);
    bench.drive(&fake).await;
    let limit = fake.submits.borrow()[0].limit.clone();
    assert_eq!(
        limit.as_deref(),
        Some("ERROR: You've hit your usage limit. Try again in 3 hours.")
    );
    assert_eq!(fake.submits.borrow()[0].agents, 1);
    assert_eq!(
        bench.calls().iter().filter(|c| c.contains("do b")).count(),
        0
    );
}

#[tokio::test]
async fn no_login_stops_the_run_before_the_submit_naming_how_to_resume_and_files_it() {
    let mut bench = Bench::new(HostKind::Codex);
    bench.concurrency = 1;
    let fake = bench.fake(vec![Spec("a", "NOLOGIN", None), Spec("b", "do b", None)]);
    let answer = bench.drive(&fake).await;
    assert!(!answer.finished);
    assert!(fake.submits.borrow().is_empty());
    assert!(
        answer
            .text
            .contains("⚠️ INCOMPLETE — Codex is not logged in (401 Unauthorized"),
        "{}",
        answer.text
    );
    assert!(
        answer
            .text
            .contains("`craft review run --backend codex --run '"),
        "{}",
        answer.text
    );
    assert_eq!(
        *fake.filed.borrow(),
        ["the craft binary did not finish the run"]
    );
}

#[tokio::test]
async fn pi_reads_its_answer_from_what_it_printed_and_its_prompt_with_the_root_written_in() {
    let bench = Bench::new(HostKind::Pi);
    let fake = bench.fake(vec![Spec(
        "a",
        "see ${CLAUDE_PLUGIN_ROOT}/skills",
        Some("rust-reviewer"),
    )]);
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    assert_eq!(bench.answer("a"), json!({"answer": "ok"}));
    assert_eq!(
        bench.calls(),
        [format!("see {}/skills", bench.path("root").display())]
    );
}

#[tokio::test]
async fn a_run_cut_short_exits_non_zero_and_says_what_the_dead_agents_wrote() {
    let bench = Bench::new(HostKind::Pi);
    let mut fake = bench.fake(vec![Spec("a", "FAIL", None), Spec("b", "FAIL", None)]);
    fake.verdict = "Warning (INCOMPLETE)";
    let answer = bench.drive(&fake).await;
    assert!(!answer.finished);
    assert!(answer.text.contains("## What the agents said\n\nThe tasks that gave no answer last wrote:\n\n- 6 task(s): `boom`"), "{}", answer.text);
}

#[tokio::test]
async fn an_answer_that_could_not_look_is_a_failed_task_with_its_reason() {
    let bench = Bench::new(HostKind::Codex);
    let mut fake = bench.fake(vec![Spec("a", "BLOCKED", None), Spec("b", "do b", None)]);
    fake.verdict = "Warning (INCOMPLETE)";
    let answer = bench.drive(&fake).await;
    assert_eq!(
        bench.answer("a")["blocked"]["what"],
        json!("bwrap: Operation not permitted"),
        "written for the binary to fail with its reason"
    );
    let events = bench.events.borrow();
    assert!(
        events.iter().any(|e| matches!(e, Event::TaskFailed { id, reason } if id == "a" && reason == "could not review: bwrap: Operation not permitted")),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::TaskFinished { id, .. } if id == "b")),
        "{events:?}"
    );
    assert!(
        answer.text.contains("## What the agents said\n\nThe tasks that gave no answer last wrote:\n\n- 1 task(s): `could not review: bwrap: Operation not permitted`"),
        "{}",
        answer.text
    );
}

#[tokio::test]
async fn a_submit_that_fails_is_asked_of_status_and_the_run_said_where_it_stands() {
    let bench = Bench::new(HostKind::Codex);
    let mut fake = bench.fake(vec![Spec("a", "do a", None)]);
    fake.broken = true;
    let answer = bench.drive(&fake).await;
    assert!(!answer.finished);
    assert!(
        answer.text.contains(
            "review stopped (the binary reports round 2, phase lenses): the step could not be read."
        ),
        "{}",
        answer.text
    );
    assert_eq!(fake.filed.borrow().len(), 1);
}

#[tokio::test]
async fn a_stopping_signal_stops_the_round_s_tasks_and_files_the_run_incomplete() {
    let mut bench = Bench::new(HostKind::Codex);
    bench.stop_after = Some((Duration::from_millis(500), 143));
    let fake = bench.fake(vec![Spec("slow", "HANG", None), Spec("b", "HANG", None)]);
    let answer = bench.drive(&fake).await;
    tokio::task::spawn_blocking(craft_agent::settle_stops)
        .await
        .unwrap();
    assert!(!answer.finished);
    assert!(
        answer
            .text
            .contains("INCOMPLETE — review run was stopped by a signal (exit 143)"),
        "{}",
        answer.text
    );
    assert!(answer.text.contains("To resume it"), "{}", answer.text);
    assert!(fake.submits.borrow().is_empty(), "nothing is submitted");
    assert_eq!(
        *fake.filed.borrow(),
        ["review run was stopped by a signal (exit 143)"]
    );
    let pids: Vec<String> = std::fs::read_dir(bench.path("log"))
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            name.strip_prefix("call-").map(str::to_owned)
        })
        .collect();
    assert_eq!(pids.len(), 2, "both tasks started");
    for pid in pids {
        let alive = std::process::Command::new("kill")
            .args(["-0", "--", &format!("-{pid}")])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the group of task process {pid} is left behind");
    }
}

#[path = "opencode_drive_tests.rs"]
mod opencode;

#[tokio::test]
async fn the_tasks_run_in_the_worktree_the_step_names_and_the_answer_names_it() {
    let bench = Bench::new(HostKind::Pi);
    let worktree = bench.path("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let mut fake = bench.fake(vec![Spec("a", "do a", None)]);
    fake.worktree = Some(worktree.clone());
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    let cwd = std::fs::read_to_string(bench.path("log/cwd")).unwrap();
    assert_eq!(
        cwd.trim(),
        worktree.canonicalize().unwrap().display().to_string()
    );
    assert!(
        answer.text.contains(&format!(
            "reviewed in craft's own worktree {}.",
            worktree.display()
        )),
        "{}",
        answer.text
    );
}
