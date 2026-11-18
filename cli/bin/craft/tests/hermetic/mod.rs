//! A PATH for `craft init` whose code graph is a stand-in that is not there, so a test never asks
//! the machine's own `codebase-memory-mcp` and reads the same on every machine.

#[path = "../../../../test-support/exe.rs"]
mod exe;

use std::path::Path;

/// The PATH with a failing `codebase-memory-mcp` first, written under `t`.
pub fn path(t: &Path) -> String {
    let bin = t.join("hermetic-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let stub = "#!/bin/sh\necho 'not installed in this test' >&2\nexit 127\n";
    exe::write_executable(&bin.join("codebase-memory-mcp"), stub).unwrap();
    let rest = std::env::var("PATH").unwrap_or_default();
    format!("{}:{rest}", bin.display())
}
