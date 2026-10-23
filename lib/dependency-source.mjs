// How an agent finds the source of a dependency it must open to settle a premise: one instruction,
// so no prompt that demands the opening leaves the agent to search blindly or lets a tool re-resolve
// the lockfile. Inlined into src/triage-findings.js (the validator's premise discipline),
// src/adversarial-review.js (the lenses' WHERE-CHECKED rule) and src/review.js (the lenses'
// WHERE-CHECKED rule and the single and batch verifiers' premiseSupported step).

export const DEPENDENCY_SOURCE_HOW = 'Finding a dependency\'s source: open the version the project pins, never the newest or a remembered one, and never let a tool rewrite the lockfile to find it. For a Rust crate, take the package\'s `manifest_path` from `cargo metadata --locked --format-version 1` — its directory is the source of the version Cargo.lock pins (under `~/.cargo/registry`, a git checkout, or the vendored tree); if that directory is missing, run `cargo fetch --locked` first; if `--locked` refuses (Cargo.lock missing or stale), the pinned version cannot be determined — do not run cargo without it: treat the premise as one you could not open. For a Nix flake input, open the input at the revision flake.lock pins, not a channel or its current head. For another ecosystem, the same way: the version from the project\'s lockfile, the code from the package manager\'s cache or the vendor directory.'
