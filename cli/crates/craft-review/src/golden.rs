//! The parity files under `content/parity/` this crate owns: a test reads its frozen input there and checks what it
//! renders against the expected side; with `CRAFT_UPDATE_PARITY=1` it writes what it rendered into the expected side
//! instead, the input kept: `CRAFT_UPDATE_PARITY=1 cargo test -p craft-review parity`. The files the engines still
//! write (`memory-cases.json`, `sort-cases.json`, `judge-prompt-cases.json`) are read with `include_str!`, never
//! through this.
//!
//! The switch needs one test process: the lock below serialises the tests of one file across the threads of one
//! `cargo test` binary, not across processes, so a runner that starts a process per test (cargo-nextest) can lose
//! a write. Regenerate with plain `cargo test`.

mod de;
mod ordered;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::Value;

use ordered::Node;

/// One file at a time: the tests of one file run on parallel threads of one process and each writes it whole.
static LOCK: Mutex<()> = Mutex::new(());

pub(crate) struct Golden {
    path: PathBuf,
    file: Node,
    update: bool,
    _held: MutexGuard<'static, ()>,
}

impl Golden {
    /// `content/parity/<name>`, read now.
    pub(crate) fn open(name: &str) -> Self {
        let held = LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/parity")
            .join(name);
        let text =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let file =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let update = std::env::var_os("CRAFT_UPDATE_PARITY").is_some_and(|v| v == "1");
        Self {
            path,
            file,
            update,
            _held: held,
        }
    }

    /// The whole file as it was read: its inputs, and the expected side a test reads beside what it checks.
    pub(crate) fn file(&self) -> Value {
        self.file.to_value()
    }

    /// What the crate renders at `ptr` (a JSON pointer from the file's root into an expected side) against what the
    /// file holds there; written there instead when regenerating.
    pub(crate) fn check(&mut self, ptr: &str, got: impl Into<Value>) {
        let got = got.into();
        if self.update {
            self.file.set(ptr, &got);
        } else {
            let want = self.file.at(ptr).map(Node::to_value);
            assert_eq!(
                Some(&got),
                want.as_ref(),
                "{}{ptr}: regenerate with CRAFT_UPDATE_PARITY=1 cargo test -p craft-review parity",
                self.path.display()
            );
        }
    }
}

impl Drop for Golden {
    fn drop(&mut self) {
        if self.update && !std::thread::panicking() {
            let text = format!("{}\n", self.file.pretty());
            std::fs::write(&self.path, text)
                .unwrap_or_else(|e| panic!("{}: {e}", self.path.display()));
        }
    }
}
