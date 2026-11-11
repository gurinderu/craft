//! What the integration tests of this crate share: an executable a test writes and then runs, from
//! the workspace's one copy.

#[path = "../../../../test-support/exe.rs"]
mod exe;

pub use exe::write_executable;
