//! The pull request as GitHub has it: `gh pr view <url> --json headRefOid,baseRefName,headRefName`,
//! the head commit the check judges and the branch it merges into.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

use super::bounded;

/// Within the hook's 30 s, beside the base fetch's own limit ([`super::repo`]).
const LIMIT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    /// The commit the PR's head is.
    pub head_ref_oid: String,
    /// The branch it merges into.
    pub base_ref_name: String,
    /// The branch it comes from.
    pub head_ref_name: String,
}

/// The PR at `url`, asked from `dir`; why not, when `gh` is missing, fails, is slow or answers
/// something else.
pub fn view(dir: &Path, url: &str) -> Result<Pr, String> {
    let mut cmd = Command::new("gh");
    cmd.current_dir(dir).args([
        "pr",
        "view",
        url,
        "--json",
        "headRefOid,baseRefName,headRefName",
    ]);
    let out = bounded::output(cmd, LIMIT)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let first = stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("gh pr view failed ({}): {first}", out.status));
    }
    let pr: Pr = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("gh pr view answered no PR this check reads ({e})"))?;
    let named = |s: &str| !s.is_empty() && !s.starts_with('-');
    if !(pr.head_ref_oid.chars().all(|c| c.is_ascii_hexdigit())
        && named(&pr.head_ref_oid)
        && named(&pr.base_ref_name))
    {
        return Err(format!(
            "gh pr view answered a head {:?} or base {:?} this check cannot read",
            pr.head_ref_oid, pr.base_ref_name
        ));
    }
    Ok(pr)
}
