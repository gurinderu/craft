//! What a Codex session must know before it runs craft's review (realm @nick/craft, node #293;
//! the Codex surface, #292): whether Codex's own sandbox can run a command at all — the review's
//! agents are `codex exec -s read-only` processes — and whether this plugin version's binary is in
//! the cache `bin/craft` runs (`~/.craft/bin/<version>/craft`), since fetching it needs the network
//! and writes outside the workspace. Asked by the start hook under Codex only; any failure is
//! silence.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use super::Ctx;
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

/// The plugin version Codex installed, from `<root>/.codex-plugin/plugin.json`.
fn plugin_version(root: &Path) -> String {
    std::fs::read(root.join(".codex-plugin").join("plugin.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("version")?.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn executable(file: &Path) -> bool {
    std::fs::metadata(file).is_ok_and(|m| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            m.is_file() && m.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        m.is_file()
    })
}

fn binary_line(ctx: &Ctx) -> String {
    let root = ctx.var("PLUGIN_ROOT");
    if root.is_empty() || !ctx.var("CRAFT_BIN").is_empty() {
        return String::new();
    }
    let version = plugin_version(Path::new(root));
    let Some(home) = ctx.home.as_deref() else {
        return String::new();
    };
    let name = if cfg!(windows) { "craft.exe" } else { "craft" };
    if version.is_empty() || executable(&home.join(".craft").join("bin").join(&version).join(name))
    {
        return String::new();
    }
    let wrapper = js::resolve(&Path::new(root).join("bin").join("craft"));
    [
        format!(
            "craft: the craft binary {version} is not in ~/.craft/bin yet. When you run craft's review (the codex-review skill),"
        ),
        "its first run downloads it, which needs the network and writes outside the workspace:".to_owned(),
        format!(
            "then run `sh \"{}\" review run --backend codex …` with escalated permissions and ask the user to approve it.",
            wrapper.display()
        ),
        "This is not a request to start a review now.".to_owned(),
    ]
    .join(" ")
}

/// The readiness lines for a Codex start, each with its name; none when there is nothing to say.
pub fn lines(ctx: &Ctx, probe: &dyn Probe) -> Vec<(&'static str, String)> {
    [
        ("sandbox", sandbox_line(probe)),
        ("binary", binary_line(ctx)),
    ]
    .into_iter()
    .filter(|(_, text)| !text.is_empty())
    .collect()
}
