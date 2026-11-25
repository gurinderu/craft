//! What cargo-mutants wrote of its run: `mutants.out/outcomes.json`, as 27.1.0 shapes it (realm
//! @nick/craft, node #624) — written as the run goes, so a run stopped short still reads as far as
//! it got, its `end_time` then `null`.

use serde::Deserialize;

/// One mutant the suite let live: where it is and what it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Survivor {
    /// Its file, relative to the workspace cargo-mutants ran in.
    pub file: String,
    pub line: u32,
    /// The lines of the function it is in, first and last: a survivor whose function the change
    /// did not touch is a neighbour cargo-mutants chose by adjacency (node #624), not the change's.
    pub function: (u32, u32),
    /// cargo-mutants' own name of it: `src/lib.rs:2:32: replace >= with < in big`.
    pub name: String,
    /// Its genre (`FnValue`, `BinaryOperator`, …): the rule a finding of it carries.
    pub genre: String,
}

/// What the run came to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Outcomes {
    /// The mutants it chose on the diff.
    pub total: u32,
    /// The mutants it ran to an outcome.
    pub tested: u32,
    pub caught: u32,
    pub timeout: u32,
    pub unviable: u32,
    pub missed: Vec<Survivor>,
    /// Whether the unmutated tree's tests passed first: without that no outcome means anything.
    pub baseline_ok: bool,
    /// Whether it ran to its end rather than being stopped.
    pub complete: bool,
}

#[derive(Deserialize)]
struct Raw {
    #[serde(default)]
    total_mutants: u32,
    #[serde(default)]
    end_time: Option<String>,
    #[serde(default)]
    outcomes: Vec<RawOutcome>,
}

#[derive(Deserialize)]
struct RawOutcome {
    scenario: serde_json::Value,
    #[serde(default)]
    summary: String,
}

#[derive(Deserialize)]
struct RawMutant {
    #[serde(default)]
    name: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    genre: String,
    span: RawSpan,
    #[serde(default)]
    function: Option<RawFunction>,
}

#[derive(Deserialize)]
struct RawFunction {
    span: RawRange,
}

#[derive(Deserialize)]
struct RawRange {
    start: RawPos,
    end: RawPos,
}

#[derive(Deserialize)]
struct RawSpan {
    start: RawPos,
}

#[derive(Deserialize)]
struct RawPos {
    line: u32,
}

/// `outcomes.json`'s text read; `Err` names what was wrong with it.
pub(crate) fn parse(text: &str) -> Result<Outcomes, String> {
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("outcomes.json: {e}"))?;
    let mut out = Outcomes {
        total: raw.total_mutants,
        complete: raw.end_time.is_some(),
        ..Outcomes::default()
    };
    for o in raw.outcomes {
        if o.scenario.as_str() == Some("Baseline") {
            out.baseline_ok = o.summary == "Success";
            continue;
        }
        let Some(m) = o.scenario.get("Mutant") else {
            continue;
        };
        out.tested += 1;
        match o.summary.as_str() {
            "CaughtMutant" => out.caught += 1,
            "Timeout" => out.timeout += 1,
            "Unviable" => out.unviable += 1,
            "MissedMutant" => {
                let m: RawMutant = serde_json::from_value(m.clone())
                    .map_err(|e| format!("outcomes.json: a missed mutant: {e}"))?;
                let line = m.span.start.line;
                out.missed.push(Survivor {
                    file: m.file,
                    line,
                    function: m
                        .function
                        .map_or((line, line), |f| (f.span.start.line, f.span.end.line)),
                    name: m.name,
                    genre: m.genre,
                });
            }
            _ => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mutant's scenario as 27.1.0 writes it.
    fn mutant(name: &str, file: &str, line: u32, genre: &str) -> String {
        format!(
            r#"{{"Mutant":{{"name":"{name}","package":"probe","file":"{file}","function":{{"function_name":"f","return_type":"","span":{{"start":{{"line":{line},"column":1}},"end":{{"line":{line},"column":9}}}}}},"span":{{"start":{{"line":{line},"column":3}},"end":{{"line":{line},"column":4}}}},"replacement":"*","genre":"{genre}"}}}}"#
        )
    }

    fn file(end: &str, outcomes: &[(String, &str)]) -> String {
        let rows: Vec<String> = outcomes
            .iter()
            .map(|(s, sum)| {
                format!(r#"{{"scenario":{s},"summary":"{sum}","log_path":"l","phase_results":[]}}"#)
            })
            .collect();
        format!(
            r#"{{"outcomes":[{}],"total_mutants":5,"missed":1,"caught":1,"timeout":0,"unviable":0,"success":0,"start_time":"t","end_time":{end},"cargo_mutants_version":"27.1.0"}}"#,
            rows.join(",")
        )
    }

    #[test]
    fn a_missed_mutant_is_a_survivor_and_a_caught_one_is_not() {
        let text = file(
            r#""t2""#,
            &[
                (r#""Baseline""#.into(), "Success"),
                (
                    mutant(
                        "src/lib.rs:1:37: replace add -> i32 with 0",
                        "src/lib.rs",
                        1,
                        "FnValue",
                    ),
                    "CaughtMutant",
                ),
                (
                    mutant(
                        "src/lib.rs:2:32: replace >= with < in big",
                        "src/lib.rs",
                        2,
                        "BinaryOperator",
                    ),
                    "MissedMutant",
                ),
            ],
        );
        let o = parse(&text).unwrap();
        assert_eq!(
            o.missed,
            vec![Survivor {
                file: "src/lib.rs".into(),
                line: 2,
                function: (2, 2),
                name: "src/lib.rs:2:32: replace >= with < in big".into(),
                genre: "BinaryOperator".into(),
            }]
        );
        assert_eq!((o.total, o.tested, o.caught), (5, 2, 1));
        assert!(o.baseline_ok && o.complete);
    }

    #[test]
    fn a_run_stopped_short_reads_as_incomplete_with_what_it_tested() {
        let text = file(
            "null",
            &[
                (r#""Baseline""#.into(), "Success"),
                (mutant("a", "src/a.rs", 3, "FnValue"), "Timeout"),
                (mutant("b", "src/a.rs", 4, "FnValue"), "Unviable"),
            ],
        );
        let o = parse(&text).unwrap();
        assert!(!o.complete);
        assert_eq!((o.tested, o.timeout, o.unviable), (2, 1, 1));
        assert!(o.missed.is_empty());
    }

    #[test]
    fn a_failed_baseline_is_read_as_such() {
        let text = file("null", &[(r#""Baseline""#.into(), "Failure")]);
        assert!(!parse(&text).unwrap().baseline_ok);
    }

    #[test]
    fn a_broken_file_is_an_error_not_an_empty_run() {
        parse("{not json").unwrap_err();
    }
}
