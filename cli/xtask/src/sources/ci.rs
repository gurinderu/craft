//! The `run:` commands of CI's `test` job (.github/workflows/ci.yml).

/// Every `run:` of CI's `test` job, a block scalar joined.
pub fn ci_test_runs(yml: &str) -> Result<Vec<String>, String> {
    let lines: Vec<&str> = yml.lines().collect();
    let start = lines
        .iter()
        .position(|l| *l == "  test:")
        .ok_or("ci.yml has no `test` job")?;
    let job: Vec<&str> = lines
        .iter()
        .skip(start)
        .enumerate()
        .take_while(|(i, l)| *i == 0 || !is_job_header(l))
        .map(|(_, l)| *l)
        .collect();
    let mut runs = Vec::new();
    for (i, line) in job.iter().enumerate() {
        let Some((indent, head)) = run_head(line) else {
            continue;
        };
        if !head.starts_with(['|', '>']) {
            runs.push(head.to_owned());
            continue;
        }
        let body: Vec<&str> = job
            .iter()
            .skip(i + 1)
            .take_while(|next| next.trim().is_empty() || indent_of(next) > indent)
            .copied()
            .collect();
        runs.push(body.join("\n"));
    }
    Ok(runs)
}

/// A line at the jobs' own level: two spaces, then a key.
fn is_job_header(line: &str) -> bool {
    line.strip_prefix("  ")
        .is_some_and(|rest| rest.starts_with(|c: char| !c.is_whitespace()))
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// `(indent, value)` of a `run:` line, the key's own indent (a step's first key, `- run:`, sits past its dash).
fn run_head(line: &str) -> Option<(usize, &str)> {
    let key = line.trim_start();
    let (dash, key) = key.strip_prefix("- ").map_or((0, key), |k| (2, k));
    let rest = key.strip_prefix("run:")?;
    Some((
        indent_of(line) + dash,
        rest.strip_prefix(' ').unwrap_or(rest),
    ))
}
