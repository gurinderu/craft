use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::fixture::{Bench, read};

#[test]
fn a_signal_stops_the_host_group_without_filing_a_review_then_resumes() {
    for (signal, code) in [("-TERM", 143), ("-INT", 130)] {
        let b = Bench::new();
        let script = std::fs::read(b.path("host")).unwrap();
        crate::common::write_executable(&b.path("host"), "#!/bin/sh\ncat > /dev/null\nsleep 300 &\necho $! > \"$FIXTURE/grandchild\"\necho $$ > \"$FIXTURE/pid.tmp\"\nmv \"$FIXTURE/pid.tmp\" \"$FIXTURE/pid\"\nwait\n").unwrap();
        let mut child = b
            .command("codex", "ok")
            .arg("--repo")
            .arg(b.path("repo"))
            .arg("--report")
            .arg(b.path("report.md"))
            .arg("--run-dir")
            .arg(b.path("run"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let bound = Instant::now() + Duration::from_secs(15);
        while !b.path("pid").exists() && Instant::now() < bound {
            std::thread::sleep(Duration::from_millis(20));
        }
        let ready = b.path("pid").exists();
        assert!(
            Command::new("kill")
                .args([signal, &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let bound = Instant::now() + Duration::from_secs(15);
        while child.try_wait().unwrap().is_none() && Instant::now() < bound {
            std::thread::sleep(Duration::from_millis(20));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(ready, "host never started");
        for file in ["pid", "grandchild"] {
            let pid = std::fs::read_to_string(b.path(file)).unwrap();
            let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid.trim()));
            let gone = stat.map_or(true, |s| {
                s.rsplit(')').next().unwrap().trim_start().starts_with('Z')
            });
            if !gone {
                let _killed = Command::new("kill").args(["-KILL", pid.trim()]).status();
            }
            assert!(gone, "{file} outlived craft");
        }
        b.expect(&out, code);
        assert!(String::from_utf8_lossy(&out.stdout).contains("To resume it"));
        assert!(b.index().is_empty());
        assert!(!b.path("run/record.json").exists());
        assert_eq!(read(&b.path("run/state.json"))["tasks"][0]["retries"], 0);
        std::fs::write(b.path("host"), script).unwrap();
        b.expect(&b.resume("codex", "ok"), 0);
        assert_eq!(b.index().len(), 1);
    }
}
