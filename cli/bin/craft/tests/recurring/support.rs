use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::{Value, json};

pub struct Store {
    pub root: tempfile::TempDir,
    pub store: PathBuf,
    pub project: PathBuf,
    bin: PathBuf,
}

impl Store {
    pub fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("recurring-131-")
            .tempdir()
            .unwrap();
        let store = root.path().join("runs");
        let project = root.path().join("project");
        let bin = root.path().join("bin");
        for dir in [&store, &project, &bin] {
            std::fs::create_dir(dir).unwrap();
        }
        let git_name = format!("git{}", std::env::consts::EXE_SUFFIX);
        let git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|p| p.join(&git_name))
            .find(|p| p.is_file())
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(git, bin.join(git_name)).unwrap();
        #[cfg(not(unix))]
        std::fs::copy(git, bin.join(git_name)).unwrap();
        Self {
            root,
            store,
            project: std::fs::canonicalize(project).unwrap(),
            bin,
        }
    }

    pub fn command(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_craft"));
        cmd.env("PATH", &self.bin)
            .env("HOME", self.root.path())
            .current_dir(&self.project);
        cmd
    }

    pub fn output(&self, args: &[&str]) -> Output {
        self.command()
            .args(["runs", "--store"])
            .arg(&self.store)
            .args(["recurring", "--project"])
            .arg(&self.project)
            .args(args)
            .output()
            .unwrap()
    }

    pub fn read(&self, args: &[&str]) -> Value {
        let out = self.output(args);
        assert_eq!(
            out.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            out.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }

    pub fn write(&self, name: &str, rec: &Value) {
        std::fs::write(self.store.join(format!("{name}.json")), rec.to_string()).unwrap();
    }

    pub fn record(&self, name: &str, branch: &str, ledger: Value) {
        let mut record = json!({"project":self.project,"branch":branch,"ts":name});
        drop(
            record
                .as_object_mut()
                .unwrap()
                .insert("ledger".into(), ledger),
        );
        self.write(name, &record);
    }
}

pub fn row(file: &str, title: &str) -> Value {
    json!({"file":file,"title":title,"severity":"Medium","tier":"confirmed","disposition":"open"})
}
