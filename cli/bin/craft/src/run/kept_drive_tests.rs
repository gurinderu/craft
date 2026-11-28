//! A round the loop ends without a submit that took it — a stopping signal cut it short, no account
//! is logged in, or its submit failed — keeps the round's degraded notes in the run beside the
//! answers that landed, for the resume's submit to take (realm @nick/craft, node #752); a round
//! that is submitted keeps none.

use craft_step::noted;

use super::*;
use crate::run::protocol::Lifecycle;

/// [`Fake`] as a triage: the same steps, the triage's lifecycle.
struct Triage(Fake);

impl Protocol for Triage {
    fn lifecycle(&self) -> Lifecycle {
        Lifecycle::Triage
    }
    fn start(&self, cancel: &Cancel) -> Result<Value> {
        self.0.start(cancel)
    }
    fn submit(&self, run: &Path, said: &Said) -> Result<Value> {
        self.0.submit(run, said)
    }
    fn status(&self, run: &Path) -> Result<Value> {
        self.0.status(run)
    }
    fn comment(&self, run: &Path) -> Result<Value> {
        self.0.comment(run)
    }
    fn unfinished(&self, run: &Path, not_run: &[&str]) -> Option<Vec<String>> {
        self.0.unfinished(run, not_run)
    }
}

/// A round whose `n` names an agent with no body and answers, while `slow` hangs until a signal
/// sent once `n`'s answer landed.
fn signalled_bench() -> Bench {
    let mut bench = Bench::new(HostKind::Codex);
    bench.stop_after = Some((Duration::from_millis(200), 143));
    bench.stop_once = Some(bench.path("run/answers/n.json"));
    bench
}

fn tasks() -> Vec<Spec> {
    vec![
        Spec("n", "do n", Some("nix-reviewer")),
        Spec("slow", "HANG", None),
    ]
}

/// The run's kept notes: the one for `nix-reviewer`'s missing body.
fn assert_kept(bench: &Bench) {
    let kept = noted::kept(&bench.path("run"));
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert!(kept[0].contains("`nix-reviewer`"), "{kept:?}");
}

#[tokio::test]
async fn a_review_round_a_signal_cut_short_keeps_its_degraded_notes_for_the_resume() {
    let _turn = SETTLING.lock().await;
    let bench = signalled_bench();
    let fake = bench.fake(tasks());
    let answer = bench.drive(&fake).await;
    tokio::task::spawn_blocking(craft_agent::settle_stops)
        .await
        .unwrap();
    assert!(!answer.finished, "{}", answer.text);
    assert!(fake.submits.borrow().is_empty(), "nothing is submitted");
    assert_eq!(
        bench.answer("n"),
        json!({"answer": "ok"}),
        "its answer landed"
    );
    assert_kept(&bench);
}

#[tokio::test]
async fn a_triage_round_a_signal_cut_short_keeps_its_degraded_notes_for_the_resume() {
    let _turn = SETTLING.lock().await;
    let bench = signalled_bench();
    let triage = Triage(bench.fake(tasks()));
    let answer = bench.drive(&triage).await;
    tokio::task::spawn_blocking(craft_agent::settle_stops)
        .await
        .unwrap();
    assert!(!answer.finished, "{}", answer.text);
    assert!(triage.0.submits.borrow().is_empty(), "nothing is submitted");
    assert_kept(&bench);
}

#[tokio::test]
async fn a_round_stopped_for_a_missing_login_keeps_its_degraded_notes_for_the_resume() {
    let mut bench = Bench::new(HostKind::Codex);
    bench.concurrency = 1;
    let fake = bench.fake(vec![
        Spec("n", "do n", Some("nix-reviewer")),
        Spec("a", "NOLOGIN", None),
    ]);
    let answer = bench.drive(&fake).await;
    assert!(!answer.finished, "{}", answer.text);
    assert!(fake.submits.borrow().is_empty(), "nothing is submitted");
    assert_kept(&bench);
}

#[tokio::test]
async fn a_review_round_whose_submit_failed_keeps_its_degraded_notes_for_the_resume() {
    let bench = Bench::new(HostKind::Codex);
    let mut fake = bench.fake(vec![Spec("n", "do n", Some("nix-reviewer"))]);
    fake.broken = true;
    let answer = bench.drive(&fake).await;
    assert!(!answer.finished, "{}", answer.text);
    assert!(
        answer.text.contains("the step could not be read"),
        "{}",
        answer.text
    );
    assert_kept(&bench);
}

#[tokio::test]
async fn a_triage_round_whose_submit_failed_keeps_its_degraded_notes_for_the_resume() {
    let bench = Bench::new(HostKind::Codex);
    let mut fake = bench.fake(vec![Spec("n", "do n", Some("nix-reviewer"))]);
    fake.broken = true;
    let triage = Triage(fake);
    let answer = bench.drive(&triage).await;
    assert!(!answer.finished, "{}", answer.text);
    assert!(
        answer.text.contains("the step could not be read"),
        "{}",
        answer.text
    );
    assert_kept(&bench);
}

#[tokio::test]
async fn a_round_that_is_submitted_keeps_no_note_and_says_it_in_its_submit() {
    let bench = Bench::new(HostKind::Codex);
    let fake = bench.fake(vec![Spec("n", "do n", Some("nix-reviewer"))]);
    let answer = bench.drive(&fake).await;
    assert!(answer.finished, "{}", answer.text);
    let submits = fake.submits.borrow();
    assert_eq!(submits[0].degraded.len(), 1, "{:?}", submits[0].degraded);
    assert!(!noted::file(&bench.path("run")).exists());
}
