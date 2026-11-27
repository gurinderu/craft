//! The section a run's answer leads with when a write of its telemetry could not be confirmed, as
//! `telemetryLostSection` in `integrations/shared/review-coverage.mjs` words it: "" when every write
//! landed; a landed record whose run directory did not fold is counted apart.

use crate::js::{JsStr, JsString};

/// The section over `lost`, each `<what> — <why>`; "" when it holds none.
#[must_use]
pub fn section(lost: &[String]) -> String {
    let lines: Vec<&String> = lost.iter().filter(|l| !l.js_trim().is_empty()).collect();
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
        let cut = JsString::from_utf16(flat(l).encode_utf16().take(300).collect());
        format!("- {}", cut.to_utf8_lossy())
    }));
    out.push(String::new());
    out.push(String::new());
    out.join("\n")
}

/// `l.replace(/[\r\n]+/g, ' ')`: each run of line breaks one space.
fn flat(l: &str) -> String {
    let mut out = String::with_capacity(l.len());
    let mut in_break = false;
    for c in l.chars() {
        let brk = matches!(c, '\r' | '\n');
        if !brk {
            out.push(c);
        } else if !in_break {
            out.push(' ');
        }
        in_break = brk;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::section;

    fn lines(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn nothing_lost_says_nothing_and_a_blank_line_counts_as_nothing() {
        assert_eq!(section(&[]), "");
        assert_eq!(section(&lines(&["  "])), "");
    }

    #[test]
    fn each_unconfirmed_write_is_counted_and_a_landed_record_beside_it_is_listed() {
        let got = section(&lines(&[
            "the run record — x",
            "the run directory (the record itself landed) — y",
            "phase checkpoint 'start' — z",
        ]));
        assert_eq!(
            got,
            "## ⚠️ Telemetry lost\n2 record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did.\n- the run record — x\n- the run directory (the record itself landed) — y\n- phase checkpoint 'start' — z\n\n"
        );
    }

    #[test]
    fn only_landed_records_read_incomplete_counting_their_directories() {
        let one = section(&lines(&[
            "the run directory (the record itself landed) — y",
        ]));
        assert!(one.starts_with("## ⚠️ Telemetry incomplete\nThis run's record is in the store, but 1 run directory could"), "{one}");
        let two = section(&lines(&[
            "the run directory (the record itself landed) — a",
            "the run directory (the record itself landed) — b",
        ]));
        assert!(two.contains("but 2 run directories could"), "{two}");
    }

    #[test]
    fn a_line_is_flattened_and_cut_at_300_characters() {
        let long = format!("a\nb\rd{}", "c".repeat(400));
        let got = section(&[long]);
        let item = got.lines().nth(2).unwrap();
        assert_eq!(item.chars().count(), 2 + 300, "{item}");
        assert!(item.starts_with("- a b d"), "{item}");
    }

    #[test]
    fn a_run_of_line_breaks_is_one_space_as_the_engine_flattens_it() {
        // `telemetryLostSection(['a\r\n\r\nb\n\rc\rd'])`'s item, read from the engine.
        let got = section(&lines(&["a\r\n\r\nb\n\rc\rd"]));
        assert_eq!(got.lines().nth(2), Some("- a b c d"), "{got}");
    }

    #[test]
    fn the_cut_counts_utf16_units_and_a_split_pair_reads_as_a_replacement() {
        // The engine keeps 299 `x` and the emoji's high surrogate alone (`'\ud83d'`), which reaches
        // a UTF-8 reader as U+FFFD.
        let got = section(&[format!("{}\u{1F600}tail", "x".repeat(299))]);
        assert_eq!(
            got.lines().nth(2),
            Some(format!("- {}\u{FFFD}", "x".repeat(299)).as_str()),
            "{got}"
        );
    }

    #[test]
    fn a_line_of_what_javascript_trims_away_counts_as_nothing() {
        assert_eq!(section(&lines(&["\u{FEFF}"])), "");
    }
}
