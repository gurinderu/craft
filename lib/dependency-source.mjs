// How an agent finds the source of a dependency it must open to settle a premise: one instruction
// shared by the prompts that demand the opening, so none of them leaves the agent to search blindly.
// Inlined into src/triage-findings.js and src/adversarial-review.js.

export const DEPENDENCY_SOURCE_HOW = 'Finding a dependency\'s source: open the version the project pins, not the newest or a remembered one. For a Rust crate, take the package\'s `manifest_path` from `cargo metadata --format-version 1` — its directory is the source of the version Cargo.lock pins; if that directory is missing, run `cargo fetch` first; in a vendored tree, the crate\'s directory under the vendor directory is the source. For another ecosystem, the same way: the version from the project\'s lockfile, the code from the package manager\'s cache or the vendor directory.'
