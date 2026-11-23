//! A code graph the reviewer's profile records, as a stand-in program, for the step tests.

use std::path::{Path, PathBuf};

use craft_review::project::{self, CodeGraph, ProjectProfile};
use craft_review::sources::{Git, SourcesSetup};
use craft_review::step::{self, StartOptions};
use serde_json::{Value, json};

use super::{fixture, git, ids, lens, opts, scout, submit};

/// `opts`, its profiles under `out/projects`; with `tool`, the profile records it as the code
/// graph (indexing a project of the reviewer's own, `theirs`); `probe` the program a review asks
/// when the profile records none.
pub fn with_profile(
    mut opts: StartOptions,
    out: &Path,
    (tool, probe): (Option<&Path>, &Path),
) -> StartOptions {
    let projects = out.join("projects");
    if let Some(tool) = tool {
        let (path, common) = project::profile_path(&projects, &opts.cwd).unwrap();
        let mut p = ProjectProfile::new(common, Vec::new(), Vec::new()).unwrap();
        p.code_graph = Some(CodeGraph::indexed(&tool.display().to_string(), "theirs"));
        project::save(&path, &p).unwrap();
    }
    opts.sources = Some(SourcesSetup {
        projects,
        cache: Err("no cache in the tests".into()),
        git: Git::prompt_free(),
        code_graph: probe.display().to_string(),
    });
    opts
}

/// The numbers the stand-in graph holds for its one function `f`, by property.
const F: &str = "f.name) x=f;; f.start_line|f.end_line) x=1;; f.cognitive) x=3;; f.complexity) x=2;; \
f.loop_depth|f.transitive_loop_depth) x=1;; f.param_count|f.linear_scan_in_loop) x=0;; \
f.alloc_in_loop|f.recursion_in_loop|f.unguarded_recursion) x=false;;";

/// A stand-in graph over the checkout at `top`: every `index_repository` logged to `log`, a ready
/// index of `top`, no callers, and the numbers of one function `f` at `web/app.ts:1`, answered
/// column by column as the question's RETURN names them — a property it does not hold reads as an
/// empty cell — so the question and the reading of its answer cannot drift apart unseen.
pub fn stand_in(dir: &Path, top: &Path) -> (PathBuf, PathBuf) {
    stand_in_answering(dir, top, (None, None))
}

/// [`stand_in`], the metrics question over `web/app.ts` answered by `metrics` and the probe for
/// any function's numbers by `probe` (shell: what each prints) when given; by default the probe
/// finds one.
pub fn stand_in_answering(
    dir: &Path,
    top: &Path,
    (metrics, probe): (Option<&str>, Option<&str>),
) -> (PathBuf, PathBuf) {
    let tool = dir.join("cbm");
    let log = dir.join("index-calls");
    let top = top.canonicalize().unwrap();
    let answer = format!(
        "cols=$(printf '%s' \"$4\" | sed -n 's/.* RETURN \\(.*\\) LIMIT .*/\\1/p' | tr -d ' ' | tr ',' ' '); \
         c=; v=; for k in $cols; do case $k in {F} *) x=;; esac; c=\"$c,\\\"$k\\\"\"; v=\"$v,\\\"$x\\\"\"; done; \
         echo \"{{\\\"columns\\\":[${{c#,}}],\\\"rows\\\":[[${{v#,}}]]}}\""
    );
    let answer = metrics.map_or(answer, str::to_owned);
    let probe = probe.unwrap_or(r#"echo '{"columns":["f.name"],"rows":[["f"]]}'"#);
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_repository) echo \"$4\" >> '{log}'; echo '{{\"status\":\"indexed\"}}';;\n index_status) echo '{{\"status\":\"ready\",\"indexed_at\":\"2099-01-01T00:00:00Z\",\"root_path\":\"{top}\"}}';;\n query_graph) case \"$4\" in *'WHERE f.file_path IS NOT NULL AND f.cognitive IS NOT NULL RETURN f.name LIMIT 1'*) {probe};; *web/app.ts*'IS NOT NULL'*) {answer};; *) echo '{{\"rows\":[]}}';; esac;;\n *) echo '{{\"projects\":[]}}';;\nesac\n",
        log = log.display(),
        top = top.display(),
    );
    super::exe::write_executable(&tool, &script).unwrap();
    (tool, log)
}

/// A run over a change adding `files` (path, text) to the fixture, whose code graph answers the
/// metrics question over `web/app.ts` with `metrics` and its probe with `probe` (shell; `None`:
/// one function's numbers, one function found), past its scout sized `size` and picking `picks`:
/// its run directory, the step, and the directories the caller keeps while it reads them.
pub fn scouted_over(
    files: &[(&str, &str)],
    (metrics, probe): (Option<&str>, Option<&str>),
    (size, picks): (&str, &[&str]),
) -> (PathBuf, Value, [tempfile::TempDir; 3]) {
    let repo = fixture(false);
    let d = repo.path();
    for (file, text) in files {
        let path = d.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f"]);
    let out = tempfile::tempdir().unwrap();
    let graphs = tempfile::tempdir().unwrap();
    let (tool, _) = stand_in_answering(graphs.path(), d, (metrics, probe));
    let unused = out.path().join("unused");
    let o = with_profile(opts(d, out.path()), out.path(), (Some(&tool), &unused));
    step::start(&o).unwrap();
    let run = out.path().join("run");
    let s = submit(&run, json!({"scout-general": scout(size, picks)}));
    (run, s, [repo, out, graphs])
}

/// The run in `run` driven from step `s` until done, each pending task answered by `answer` of its
/// id; a run still going after a dozen steps fails the test.
pub fn drive(run: &Path, mut s: Value, answer: impl Fn(&str) -> Value) -> Value {
    for _ in 0..12 {
        if s.get("done") != Some(&json!(false)) {
            break;
        }
        let answers: serde_json::Map<String, Value> = ids(&s)
            .into_iter()
            .map(|id| (answer(&id), id))
            .map(|(a, id)| (id, a))
            .collect();
        s = submit(run, Value::Object(answers));
    }
    assert!(
        s.get("done") != Some(&json!(false)),
        "the run did not finish: {s}"
    );
    s
}

/// The lens answer of task `id`, finding nothing.
pub fn quiet(id: &str) -> Value {
    let name = id.strip_prefix("lens-general-").unwrap();
    lens(name.split('-').next().unwrap(), &[])
}

/// [`scouted_over`], a medium scout, driven to its end with every lens finding nothing; the run's
/// directories stay on disk, so the step's report can be read.
pub fn finished_over(
    files: &[(&str, &str)],
    graph: (Option<&str>, Option<&str>),
    picks: &[&str],
) -> Value {
    let (run, s, [repo, out, graphs]) = scouted_over(files, graph, ("medium", picks));
    let s = drive(&run, s, quiet);
    let _keep = (out.keep(), graphs.keep(), repo);
    s
}
