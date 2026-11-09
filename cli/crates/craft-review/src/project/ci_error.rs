//! Why a CI map entry is refused (realm @nick/craft, node #482): each a line for the reviewer.

/// Why a CI map entry is not one.
#[derive(Debug, thiserror::Error)]
pub enum CiError {
    #[error(
        "{given:?} is not {{\"check\",\"signal\",\"command\",\"workflow\"[,\"sources\"][,\"hashes\"]}}: {why}"
    )]
    Shape { given: String, why: String },
    #[error("{0:?}: a check is one non-empty line")]
    Check(String),
    #[error(
        "{check}: the command {command:?} does not run `cargo {signal}` — quote the command line the check runs"
    )]
    Command {
        check: String,
        command: String,
        signal: &'static str,
    },
    #[error("{0:?}: a workflow or source is a path inside the repository")]
    Outside(String),
    #[error("{path}: cannot be read: {error}")]
    Unreadable { path: String, error: std::io::Error },
    #[error("{check}: no SHA-256 hash of {path} is recorded")]
    Hash { check: String, path: String },
    #[error(
        "{check}: its workflow runs `uses: ./{uses}`, which the entry's sources do not name — list the file it runs"
    )]
    LocalUses { check: String, uses: String },
    #[error(
        "{check}: the check matches no job of {workflow} — name a job's `name:` (or its id), as GitHub reports it"
    )]
    NoJob { check: String, workflow: String },
    #[error(
        "{check}: the command {command:?} is not found in a `run:` line of its job in {workflow} nor in any of the entry's sources — list the file that spells it"
    )]
    Unfound {
        check: String,
        command: String,
        workflow: String,
    },
}
