//! What a Codex session must know before it runs craft's review (realm @nick/craft, node #293;
//! the Codex surface, #292): whether Codex's own sandbox can run a command at all — the review's
//! agents are `codex exec -s read-only` processes. Asked by the start hook under Codex only; any
//! failure is silence.

use std::process::Command;
use std::time::Duration;

use super::js::{self, Re, compile};
use crate::hook::bounded;

/// How long `codex sandbox true` may take before the check gives up and says nothing.
const SANDBOX_LIMIT: Duration = Duration::from_millis(3000);
// What a sandbox that could not be set up prints; any other failure is silence.
static SETUP_FAILURE: Re = Re::new(|| {
    compile(r"(?i){B}bwrap:|operation not permitted|{B}unshare{B}|user namespace|uid_map")
});

/// How `codex sandbox true` ended: its exit code (`None` when killed or timed out) and stderr;
/// `None` as a whole when it could not be started or waited for.
pub struct Probed {
    pub status: Option<i32>,
    pub stderr: String,
}

/// The sandbox probe, apart so a test gives its own.
pub trait Probe {
    fn sandbox(&self) -> Option<Probed>;
}

/// The probe as a child process.
pub struct Spawned;

impl Probe for Spawned {
    fn sandbox(&self) -> Option<Probed> {
        let mut cmd = Command::new("codex");
        cmd.args(["sandbox", "true"]);
        craft_review::cancel::detached(&mut cmd);
        let out = bounded::output(cmd, SANDBOX_LIMIT).ok()?;
        Some(Probed {
            status: out.status.code(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

fn sandbox_line(probe: &dyn Probe) -> String {
    let Some(Probed {
        status: Some(status),
        stderr,
    }) = probe.sandbox()
    else {
        return String::new();
    };
    if status == 0 || !SETUP_FAILURE.is_match(&js::ascii_case(&stderr)) {
        return String::new();
    }
    // Codex may print its own WARNING lines before the sandbox's error.
    let lines: Vec<&str> = stderr
        .split('\n')
        .map(js::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let said = lines
        .iter()
        .find(|l| !l.starts_with("WARNING:"))
        .or(lines.first())
        .map_or(String::new(), |l| format!(": {l}"));
    [
        format!(
            "craft: before any work, tell the user that Codex's sandbox cannot run commands on this machine (`codex sandbox true` exited {status}{said})."
        ),
        "So craft's review and its review agents (`codex exec -s read-only`) will fail here.".to_owned(),
        "The fix is to allow unprivileged user namespaces for bwrap (on Ubuntu: the sysctl kernel.apparmor_restrict_unprivileged_userns, or an AppArmor profile for bwrap), or to run the review from another host.".to_owned(),
    ]
    .join(" ")
}

/// The readiness lines for a Codex start, each with its name; none when there is nothing to say.
/// Whether this plugin version's binary is cached is not asked here: the binary that would say so is
/// the one running, and `integrations/shared/craft-hook.sh` says it while the binary is absent (realm @nick/craft,
/// node #550).
pub fn lines(probe: &dyn Probe) -> Vec<(&'static str, String)> {
    [("sandbox", sandbox_line(probe))]
        .into_iter()
        .filter(|(_, text)| !text.is_empty())
        .collect()
}
