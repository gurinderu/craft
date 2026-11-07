//! What the prepared sources give a run's text, as `lib/external-source-text.mjs` words it: the
//! lenses' block, the verifiers' block, and the report's section.

use serde_json::Value;

use super::{Prepared, Sources};

/// The lenses that judge another system's behaviour — lifecycle, compatibility and races
/// (`EXTERNAL_LENSES`); the general profile, adversarial-review's catalogue, has races and what a
/// failed call leaves behind (`ADVERSARIAL_EXTERNAL_LENSES`).
const EXTERNAL_LENSES: [&str; 4] = ["reconciler", "compat", "concurrency", "failure-windows"];
const GENERAL_EXTERNAL_LENSES: [&str; 2] = ["concurrency", "errors"];

/// Whether `profile`'s lens `lens` reads the external sources.
#[must_use]
pub fn reads(profile: &str, lens: &str) -> bool {
    if profile == "general" {
        GENERAL_EXTERNAL_LENSES.contains(&lens)
    } else {
        EXTERNAL_LENSES.contains(&lens)
    }
}

/// The lenses' block (`lensSourcesBlock`); empty when nothing was prepared.
#[must_use]
pub fn lens_block(prepared: &[Prepared]) -> String {
    if prepared.is_empty() {
        return String::new();
    }
    let dirs: Vec<String> = prepared
        .iter()
        .map(|p| format!("- {} @ {}: {}", p.system, p.rev, p.dir))
        .collect();
    format!(
        "EXTERNAL SOURCES (read-only — the source of a system this code relies on, at the version \
         the consumer deploys; read it with your own Read, Grep and Glob tools inside that \
         directory, never modify it):\n{}\nA claim about how one of these systems behaves must \
         cite `<dir>/<path>:<line>` under its directory above in `whereChecked`, and the finding \
         names the system in `externalSystem`. For a system not listed here, a claim about how it \
         behaves stands only on that system's source at the deployed version, opened by you; \
         otherwise it is an open question, not a finding.",
        dirs.join("\n")
    )
}

/// The verifiers' block (`verifySourcesBlock`); empty when nothing was prepared.
#[must_use]
pub fn verify_block(prepared: &[Prepared]) -> String {
    if prepared.is_empty() {
        return String::new();
    }
    let at: Vec<String> = prepared
        .iter()
        .map(|p| format!("{} @ {} at {}", p.system, p.rev, p.dir))
        .collect();
    format!(
        "EXTERNAL SOURCES (read-only, the deployed version of each system): {}. A `whereChecked` \
         under one of these directories is that system's own source: open it there to judge the \
         premise.\n",
        at.join("; ")
    )
}

/// The report's section: what was prepared, what was not (reviewed without that context), and the
/// systems findings leaned on that the profile does not name; empty when none of it applies.
#[must_use]
pub fn section(s: &Sources, findings: &[Value]) -> String {
    let all = s.systems.join(", ");
    let mut lines: Vec<String> = s
        .prepared
        .iter()
        .map(|p| {
            format!(
                "- {} @ {} (the review profile's revision): `{}`",
                p.system, p.rev, p.dir
            )
        })
        .collect();
    if !s.unreachable.is_empty() {
        lines.push(format!(
            "- ⚠️ the source cache was unreachable ({}) — {all} reviewed without external context",
            s.unreachable
        ));
    }
    if !s.skipped.is_empty() {
        lines.push(format!(
            "- ⚠️ reviewed without external context — {}",
            s.skipped
        ));
    }
    lines.extend(s.failed.iter().map(|f| {
        format!(
            "- ⚠️ {}: {} — reviewed without external context",
            f.system, f.error
        )
    }));
    let mut named: Vec<&str> = Vec::new();
    for n in findings
        .iter()
        .filter_map(|f| f.get("externalSystem")?.as_str())
    {
        let n = n.trim();
        let known = s.systems.iter().any(|k| k.eq_ignore_ascii_case(n));
        // A model's text: only a plain system name is printed.
        if super::spec::is_system_name(n) && !known && !named.contains(&n) {
            named.push(n);
        }
    }
    lines.extend(
        named.iter().map(|n| {
            format!("- not recorded: {n} — add it to the review profile with `craft init`")
        }),
    );
    if lines.is_empty() {
        return String::new();
    }
    format!("\n## External sources\n\n{}\n", lines.join("\n"))
}
