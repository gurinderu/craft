//! Lost step responses must recover triage state without review's fallback writer.
use super::*;
use crate::run::protocol::Lifecycle;

struct Triage {
    inner: Fake,
    status: Option<Value>,
    refile: Option<Value>,
    calls: RefCell<Vec<Said>>,
    first: Option<Value>,
}

impl Protocol for Triage {
    fn lifecycle(&self) -> Lifecycle {
        Lifecycle::Triage
    }
    fn start(&self, cancel: &Cancel) -> Result<Value> {
        self.first
            .clone()
            .map_or_else(|| self.inner.start(cancel), Ok)
    }
    fn submit(&self, _: &Path, said: &Said) -> Result<Value> {
        self.calls.borrow_mut().push(said.clone());
        if self.calls.borrow().len() > 1
            && let Some(step) = &self.refile
        {
            return Ok(step.clone());
        }
        bail!("lost submit response")
    }
    fn status(&self, _: &Path) -> Result<Value> {
        self.status
            .clone()
            .ok_or_else(|| anyhow::anyhow!("lost status response"))
    }
    fn comment(&self, _: &Path) -> Result<Value> {
        bail!("triage must not publish a review")
    }
    fn unfinished(&self, _: &Path, _: &[&str]) -> Option<Vec<String>> {
        panic!("no review fallback for triage")
    }
}

fn fake(b: &Bench, status: Option<Value>) -> Triage {
    Triage {
        inner: b.fake(vec![Spec("a", "do a", None)]),
        status,
        refile: None,
        calls: RefCell::default(),
        first: None,
    }
}

#[path = "terminal_tests.rs"]
mod terminal;

#[tokio::test]
async fn lost_submit_and_lost_resume_recover_a_stop_before_a_stale_plan_even_with_done_false() {
    for resume in [false, true] {
        let b = Bench::new(HostKind::Codex);
        let f = fake(
            &b,
            Some(
                json!({"done": false, "stopped": {"text":"usage limit reached: wait until tomorrow"}, "planFile": "absent", "summary":"STALE"}),
            ),
        );
        let dir = b.path("run");
        let a = b.drive_from(&f, resume.then_some(dir.as_path())).await;
        assert!(!a.finished);
        assert!(a.text.contains("wait until tomorrow"), "{}", a.text);
        assert!(!a.text.contains("final triage plan") && !a.text.contains("STALE"));
        assert!(a.step.as_ref().unwrap().get("planFile").is_none());
        assert_eq!(f.calls.borrow().len(), 1);
    }
}

#[tokio::test]
async fn lost_submit_recovers_done_and_refiles_only_when_unfiled() {
    for filed in [true, false] {
        let b = Bench::new(HostKind::Codex);
        let plan = b.path("run/plan.json");
        std::fs::write(
            &plan,
            r#"{"plan_markdown":"body","summary":"checked plan","ledger":[]}"#,
        )
        .unwrap();
        let status = json!({"done":true,"planFile":plan,"filing":{"record":if filed {"filed"} else {"failed"},"lost":[]}});
        let mut f = fake(&b, Some(status.clone()));
        let mut refile = status;
        refile["filing"]["record"] = json!("filed");
        f.refile = Some(refile);
        let a = b.drive(&f).await;
        assert!(a.finished, "{}", a.text);
        assert!(a.text.contains("checked plan"));
        assert!(!a.text.contains("filed again"));
        let calls = f.calls.borrow();
        assert_eq!(calls.len(), if filed { 1 } else { 2 });
        if !filed {
            assert!(calls[1].resume);
        }
    }
}

#[tokio::test]
async fn unavailable_status_keeps_the_usage_reason_and_never_fabricates_a_record() {
    for status in [None, Some(json!({"done":false,"phase":"gather"}))] {
        let b = Bench::new(HostKind::Codex);
        let mut f = fake(&b, status);
        f.inner.tasks = vec![Spec("a", "LIMIT", None)];
        let a = b.drive(&f).await;
        assert!(!a.finished);
        for text in [
            "usage limit",
            "lost submit response",
            "could not be established",
            "no fallback record",
        ] {
            assert!(a.text.contains(text), "{}", a.text);
        }
        assert!(a.step.is_none());
        assert_eq!(f.calls.borrow().len(), 1);
    }
}

#[tokio::test]
async fn failed_refiling_keeps_the_confirmed_plan_and_names_the_missing_record() {
    let b = Bench::new(HostKind::Codex);
    let plan = b.path("run/plan.json");
    std::fs::write(
        &plan,
        r#"{"plan_markdown":"body","summary":"checked plan","ledger":[]}"#,
    )
    .unwrap();
    let f = fake(
        &b,
        Some(
            json!({"done":true,"planFile":plan,"filing":{"record":"failed","lost":["record — unavailable"]}}),
        ),
    );
    let a = b.drive(&f).await;
    assert!(a.finished, "{}", a.text);
    assert!(a.text.contains("record — unavailable") && a.text.contains("filed again"));
    assert_eq!(f.calls.borrow().len(), 2);
}
