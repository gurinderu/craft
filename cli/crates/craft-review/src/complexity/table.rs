//! The graph's numbers as a metrics lens and its verifier read them: one line per function the
//! change touches, read by the binary from its own index (realm @nick/craft, node #529).

use serde_json::Value;

use crate::consumers::{Consumers, Measured};
use crate::profile::{Profile, literal_pathspec};

/// How many functions one lens's table shows.
const SHOWN: usize = 200;

/// `s` as one line of a prompt, its backticks gone so it cannot close the quote it sits in: a
/// function's or a file's name keeps its underscores, as the finding must spell it.
fn plain(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .filter(|c| *c != '`')
        .collect()
}

/// One function's line: `file:start-end` `name` and its numbers as the graph names them.
fn line(m: &Measured) -> String {
    format!(
        "- `{}:{}-{}` `{}`: {}",
        plain(&m.file),
        m.start,
        m.end,
        plain(&m.function),
        Value::Object(m.metrics.clone())
    )
}

/// Whether `file` is in the part of the change `pathspec` names for `profile`: a literal pathspec
/// names its files one by one, a profile's globs take the files it covers.
fn in_part(profile: &Profile, pathspec: &str, file: &str) -> bool {
    if pathspec.contains(":(literal)") {
        pathspec.contains(&literal_pathspec(&[file.to_owned()]))
    } else {
        profile.covers(file)
    }
}

/// The table of a metrics lens of `profile` over the part `pathspec` names: each measured
/// function there, at most [`SHOWN`], then the files whose functions were not read.
#[must_use]
pub fn lens_table(c: &Consumers, profile: &Profile, pathspec: &str) -> String {
    let mine: Vec<&Measured> = c
        .metrics
        .iter()
        .filter(|m| in_part(profile, pathspec, &m.file))
        .collect();
    let mut out: Vec<String> = mine.iter().take(SHOWN).map(|m| line(m)).collect();
    if mine.len() > SHOWN {
        out.push(format!(
            "- … {} more functions not shown: judge only those above",
            mine.len() - SHOWN
        ));
    }
    if out.is_empty() {
        out.push(
            "- (none: no function of this part of the change carries the graph's numbers)".into(),
        );
    }
    let unread: Vec<String> = c
        .metrics_unread
        .iter()
        .filter(|u| in_part(profile, pathspec, u.split(" (").next().unwrap_or(u)))
        .map(|u| plain(u))
        .collect();
    if !unread.is_empty() {
        out.push(format!(
            "Files whose functions were not read (no numbers, so no finding there): {}",
            unread.join(" · ")
        ));
    }
    out.join("\n")
}

/// The rows the review holds for the function finding `f` is about (its `file` and
/// `metrics.function`), for its verifier; a line saying there is none when it holds none.
#[must_use]
pub fn rows_of(c: &Consumers, f: &Value) -> String {
    let file = f.get("file").and_then(Value::as_str).unwrap_or("");
    let function = f.pointer("/metrics/function").and_then(Value::as_str);
    let rows: Vec<String> = c
        .metrics
        .iter()
        .filter(|m| m.file == file && Some(m.function.as_str()) == function)
        .map(line)
        .collect();
    if rows.is_empty() {
        return "- (none: the review read no numbers for this function at head)".into();
    }
    rows.join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{lens_table, rows_of};
    use crate::complexity::tests::measured;
    use crate::consumers::Consumers;
    use crate::profile::Profile;

    fn consumers() -> Consumers {
        Consumers {
            metrics: vec![measured("src/a.rs", "f"), measured("web/app.ts", "g")],
            metrics_unread: vec!["src/b.rs (not indexed by the graph)".into()],
            ..Consumers::default()
        }
    }

    #[test]
    fn a_lens_sees_only_its_own_parts_functions_and_unread_files() {
        let rust = Profile::rust().unwrap();
        let t = lens_table(&consumers(), &rust, "'*.rs'");
        assert!(
            t.contains(r#"- `src/a.rs:3-9` `f`: {"cognitive":24}"#),
            "{t}"
        );
        assert!(!t.contains("web/app.ts"), "{t}");
        assert!(t.contains("src/b.rs (not indexed by the graph)"), "{t}");
        let general = Profile::load("general").unwrap();
        let t = lens_table(&consumers(), &general, "':(literal)web/app.ts'");
        assert!(
            t.contains("`web/app.ts:3-9` `g`") && !t.contains("src/"),
            "{t}"
        );
        let none = lens_table(&Consumers::default(), &general, "':(literal)x.ts'");
        assert!(none.contains("(none:"), "{none}");
    }

    #[test]
    fn a_verifier_gets_the_row_of_its_findings_function_or_hears_there_is_none() {
        let f = json!({"file": "src/a.rs", "metrics": {"function": "f", "cognitive": 24}});
        assert!(rows_of(&consumers(), &f).contains("`src/a.rs:3-9` `f`"));
        let other = json!({"file": "src/a.rs", "metrics": {"function": "h"}});
        assert!(rows_of(&consumers(), &other).contains("(none:"));
    }
}
