//! `nix flake check --no-write-lock-file` as nix 2.35.2 answered it, its stderr replayed by a
//! stand-in `nix`: a flake whose second input its flake.lock did not lock yet, its checks passing,
//! one of them failing, the new input unfetchable, and the daemon's socket missing. Observed by
//! hand on a throwaway flake (`path:` inputs); only the flake's own path is shortened here.

use std::path::Path;
use std::time::Duration;

use super::tests::{nix_track, repo, setup, tool};
use super::{Gate, Status, run};

/// The warning nix prints whenever an input changed; evaluation goes on after it.
const NOT_WRITING: &str = "warning: not writing modified lock file of flake 'path:/work/flake':
• Added input 'dep2':
    'path:/work/dep2?lastModified=1794124190&narHash=sha256-qtIRbNLtGZzpylbnUOP/9rYGew7a8CsJ3cG1pekNo7A%3D' (2026-11-08)
evaluating flake...
checking flake output 'lib'...
";

/// The checks passing after it (exit 0).
const PASSED: &str = "all checks passed!\n";

/// A check failing after it (exit 1).
const CHECK_FAILED: &str = "checking flake output 'checks'...
checking derivation checks.x86_64-linux.bad...
error:
       … while checking flake output 'checks'
         at /nix/store/v8yqcmavi3qbmz9s1qbifz9bbvx4c74y-source/flake.nix:6:5:
            5|     lib.v = dep1.value + dep2.value;
            6|     checks.x86_64-linux.bad = throw \"the check is broken\";
             |     ^
            7|   };

       (stack trace truncated; use '--show-trace' to show the full, detailed trace)

       error: the check is broken
";

/// The new input unfetchable: locking it failed, no check ran (exit 1).
const LOCKING_FAILED: &str = "error:
       … while updating the lock file of flake 'path:/work/flake?lastModified=1794124224&narHash=sha256-WECkGOAiZZK73l9K8lxGDySXFevPfs4Y6u1hHBAyNrU%3D'

       … while updating the flake input 'dep2'

       … while fetching the input 'path:/nonexistent/craft-dep'

       error: opening file \"/nonexistent/craft-dep\": No such file or directory
";

/// `NIX_REMOTE` at a socket that does not exist (exit 1).
const NO_DAEMON: &str = "error:
       … while fetching the input 'path:/work/flake'

       error: cannot connect to socket at '/tmp/craft-no-such-socket': No such file or directory
";

/// A check whose build log echoes a socket error of its own program: the change's, red.
const LOG_ECHO: &str = "error: builder for '/nix/store/x-check.drv' failed with exit code 1;
       last 1 log lines:
       > app: cannot connect to socket /run/app.sock
";

/// The gate over the fixture flake with a `nix` printing `stderr` and exiting `code`; it rewrites
/// flake.lock unless told `--no-write-lock-file`.
fn flake_check(stderr: &str, code: u8) -> (Gate, String) {
    let (repo, tools, run_dir) = (
        repo(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    std::fs::write(repo.path().join("flake.lock"), "pinned\n").unwrap();
    let said = tools.path().join("stderr.txt");
    std::fs::write(&said, stderr).unwrap();
    let script = format!(
        "case \"$*\" in *--no-write-lock-file*) ;; *) printf 'rewritten' > flake.lock ;; esac\n\
         while IFS= read -r l; do printf '%s\\n' \"$l\"; done < '{}' >&2\nexit {code}",
        said.display()
    );
    tool(tools.path(), "nix", &script);
    let (gate, _) = run(
        repo.path(),
        "HEAD~1",
        &nix_track(),
        &setup(tools.path(), Duration::from_secs(30)),
        run_dir.path(),
    );
    let lock = std::fs::read_to_string(Path::new(repo.path()).join("flake.lock")).unwrap();
    (gate, lock)
}

#[test]
fn a_new_input_left_unlocked_neither_rewrites_flake_lock_nor_hides_a_red_check() {
    let (gate, lock) = flake_check(&format!("{NOT_WRITING}{PASSED}"), 0);
    assert_eq!(lock, "pinned\n", "the branch's flake.lock is never written");
    assert_eq!(gate.tracks[0].status, Status::Pass);
    let (gate, lock) = flake_check(&format!("{NOT_WRITING}{CHECK_FAILED}"), 1);
    assert_eq!(lock, "pinned\n");
    let t = &gate.tracks[0];
    assert_eq!(
        t.status,
        Status::Fail,
        "the warning does not excuse a failing check: {t:?}"
    );
    assert_eq!(
        t.failed_checks,
        ["nix flake check: error: the check is broken"]
    );
    assert!(gate.exit().is_some());
}

#[test]
fn only_nix_failing_to_lock_or_reach_its_daemon_leaves_the_signal_unknown() {
    let (gate, _) = flake_check(LOCKING_FAILED, 1);
    let t = &gate.tracks[0];
    assert_eq!(t.status, Status::Unknown, "{t:?}");
    assert!(t.notes.iter().any(|n| n.contains("no check ran")), "{t:?}");
    let (gate, _) = flake_check(NO_DAEMON, 1);
    assert_eq!(gate.tracks[0].status, Status::Unknown);
    let (gate, _) = flake_check(LOG_ECHO, 1);
    assert_eq!(
        gate.tracks[0].status,
        Status::Fail,
        "a socket error in a check's own log is the check's"
    );
}
