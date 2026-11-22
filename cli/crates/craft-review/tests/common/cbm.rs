//! A code graph the reviewer's profile records, as a stand-in program, for the step tests.

use std::path::{Path, PathBuf};

use craft_review::project::{self, CodeGraph, ProjectProfile};
use craft_review::sources::{Git, SourcesSetup};
use craft_review::step::StartOptions;

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

/// A stand-in graph over the checkout at `top`: every `index_repository` logged to `log`, a ready
/// index of `top`, no callers, and the numbers of one function `f` at `web/app.ts:1`.
pub fn stand_in(dir: &Path, top: &Path) -> (PathBuf, PathBuf) {
    let tool = dir.join("cbm");
    let log = dir.join("index-calls");
    let top = top.canonicalize().unwrap();
    let script = format!(
        "#!/bin/sh\ncase \"$3\" in\n index_repository) echo \"$4\" >> {log}; echo '{{\"status\":\"indexed\"}}';;\n index_status) echo '{{\"status\":\"ready\",\"indexed_at\":\"2099-01-01T00:00:00Z\",\"root_path\":\"{top}\"}}';;\n query_graph) case \"$4\" in *web/app.ts*'IS NOT NULL'*) echo '{{\"rows\":[[\"f\",\"1\",\"1\",\"3\",\"2\",\"1\",\"1\",\"0\",\"0\",\"false\",\"false\",\"false\"]]}}';; *) echo '{{\"rows\":[]}}';; esac;;\n *) echo '{{\"projects\":[]}}';;\nesac\n",
        log = log.display(),
        top = top.display(),
    );
    super::exe::write_executable(&tool, &script).unwrap();
    (tool, log)
}
