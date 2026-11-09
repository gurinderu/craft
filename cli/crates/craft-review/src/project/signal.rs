//! The signal a CI check carries in the CI map (realm @nick/craft, node #482): one of the four the
//! gate establishes for a Rust change, each named by the cargo commands that give it.

use serde::{Deserialize, Serialize};

/// What a CI check establishes, in the gate's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Signal {
    Clippy,
    Test,
    Fmt,
    Build,
}

impl Signal {
    pub const ALL: [Self; 4] = [Self::Clippy, Self::Test, Self::Fmt, Self::Build];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Clippy => "clippy",
            Self::Test => "test",
            Self::Fmt => "fmt",
            Self::Build => "build",
        }
    }

    /// The signal a `cargo <sub>` command gives, `None` for another subcommand.
    #[must_use]
    pub fn of_cargo(sub: &str) -> Option<Self> {
        match sub {
            "clippy" => Some(Self::Clippy),
            "test" | "nextest" => Some(Self::Test),
            "fmt" => Some(Self::Fmt),
            "build" | "check" => Some(Self::Build),
            _ => None,
        }
    }
}
