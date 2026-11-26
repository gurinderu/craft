//! The section a run's answer leads with when a write of its telemetry could not be confirmed, as
//! `telemetryLostSection` in `integrations/shared/review-coverage.mjs` words it: "" when every write
//! landed; a landed record whose run directory did not fold is counted apart.

/// The section over `lost`, each `<what> — <why>`; "" when it holds none.
#[must_use]
pub fn section(lost: &[String]) -> String {
    let lines: Vec<&String> = lost.iter().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return String::new();
    }
    let landed = lines
        .iter()
        .filter(|l| l.starts_with("the run directory (the record itself landed)"))
        .count();
    let unconfirmed = lines.len() - landed;
    let (title, head) = if unconfirmed > 0 {
        (
            "## ⚠️ Telemetry lost",
            format!(
                "{unconfirmed} record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did."
            ),
        )
    } else {
        let dirs = if landed == 1 {
            "directory"
        } else {
            "directories"
        };
        (
            "## ⚠️ Telemetry incomplete",
            format!(
                "This run's record is in the store, but {landed} run {dirs} could not be folded into it, so what those held is not there. Read the verdict below for what this run actually did."
            ),
        )
    };
    let mut out = vec![title.to_owned(), head];
    out.extend(lines.iter().map(|l| {
        let flat = l.replace(['\r', '\n'], " ");
        format!("- {}", flat.chars().take(300).collect::<String>())
    }));
    out.push(String::new());
    out.push(String::new());
    out.join("\n")
}
