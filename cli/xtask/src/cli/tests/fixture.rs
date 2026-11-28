//! A scratch repository and a `just` that logs.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub(super) const JUSTFILE: &str = "gate *args:\n    cd cli && cargo xtask gate \"$@\"\n\n[group('gate')]\nok:\n    eslint .\n\n[group('gate')]\nred:\n    node integrations/shared/check-a.mjs\n\n[group('gate')]\nlast base=\"\":\n    vitest run\n";

/// A `just` answering `--summary` with `summary` (exit `summary_exit`), failing the step `red`, logging the others.
pub(super) fn fake_just(dir: &Path, summary: &str, summary_exit: u8) -> std::path::PathBuf {
    let path = dir.join("fake-just");
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = --summary ]; then echo '{summary}'; echo 'no justfile' >&2; exit {summary_exit}; fi\necho \"$*\" >> log\n[ \"$1\" = red ] && exit 3\nexit 0\n"
    );
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

pub(super) fn repo(justfile: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("integrations/shared")).unwrap();
    fs::create_dir_all(root.join(".github/workflows")).unwrap();
    fs::write(root.join("justfile"), justfile).unwrap();
    fs::write(
        root.join("package.json"),
        r#"{"scripts": {"lint": "eslint .", "test": "vitest run"}}"#,
    )
    .unwrap();
    fs::write(root.join("integrations/shared/check-a.mjs"), "").unwrap();
    fs::write(
        root.join(".github/workflows/ci.yml"),
        "jobs:\n  test:\n    steps:\n      - run: npm ci\n",
    )
    .unwrap();
    fs::write(
        root.join("AGENTS.md"),
        "## Commands\n| What | Command |\n|---|---|\n| Gate | `just gate` |\n",
    )
    .unwrap();
    dir
}
