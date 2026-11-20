use std::collections::HashMap;
use std::path::PathBuf;

use super::{Ctx, Declared, decide};

fn speaks(text: &str) -> bool {
    let ctx = Ctx {
        env: HashMap::new(),
        home: None,
        fallback_cwd: PathBuf::new(),
        now: 0,
    };
    let declared = Declared {
        agents: Vec::new(),
        rules: vec![("AGENTS.md".to_owned(), text.to_owned())],
    };
    decide(&declared, &ctx).is_ok()
}

#[test]
fn only_a_phrase_of_the_process_counts_as_work_rules() {
    for text in [
        "Config uses a deep merge of defaults.",
        "Keep branch coverage above 80%.",
        "Review the docs/ folder for the API.",
        "The parser handles pr, prs and Pr tokens.",
        "The reviews table stores ratings.",
    ] {
        assert!(!speaks(text), "{text}");
    }
    for text in [
        "Open a pull request.",
        "PRs need a green CI.",
        "Every code review is async.",
        "Ask the reviewer.",
        "Run the review loop.",
        "Rebase before merging.",
        "Squash before merge.",
    ] {
        assert!(speaks(text), "{text}");
    }
}
