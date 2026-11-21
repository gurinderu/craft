use std::time::{Duration, Instant};

use super::take;
use crate::cancel::Cancel;

#[test]
fn of_two_takers_of_a_dead_holder_s_lock_exactly_one_holds_it() {
    for _ in 0..40 {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("p.lock");
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::process::Command::new("touch")
            .args(["-d", "2000-01-01", &dir.display().to_string()])
            .status()
            .unwrap();
        assert!(old.success());
        let barrier = std::sync::Barrier::new(4);
        let held = std::thread::scope(|s| {
            let takers: Vec<_> = (0..4)
                .map(|_| {
                    s.spawn(|| {
                        barrier.wait();
                        let until = Instant::now() + Duration::from_millis(300);
                        take(
                            (t.path(), Duration::from_secs(600)),
                            "p",
                            until,
                            &Cancel::default(),
                        )
                        .is_ok()
                    })
                })
                .collect();
            takers
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|held| *held)
                .count()
        });
        assert_eq!(held, 1, "more than one holds the lock");
    }
}
