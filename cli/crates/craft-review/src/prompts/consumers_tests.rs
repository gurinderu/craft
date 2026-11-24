//! Which prompts carry the consumers list: a Rust lens all of it, a lens confined to some crates
//! only their lines, the seam pass every line, and a lens of another profile none.

use super::{LensIn, PromptContext, ReScope, lens_prompt, seam_prompt, slice_lens_prompt};
use crate::consumers::{Consumers, Listed, Site};
use crate::plan::Plan;
use crate::profile::Profile;
use crate::units::Slice;

fn site(file: &str, line: u32) -> Site {
    Site {
        file: file.into(),
        line,
        text: format!("call_{line}()"),
        from: vec!["name search".into()],
        kind: String::new(),
    }
}

fn ctx() -> PromptContext {
    PromptContext {
        repo: "/work/repo".into(),
        base: "origin/main".into(),
        spec: String::new(),
        craft_root: None,
        craft_version: None,
        re_review: ReScope::First,
        strict: false,
        sources: crate::sources::Sources::default(),
        consumers: Consumers {
            sources: vec!["name search".into()],
            symbols: vec![Listed {
                name: "shared".into(),
                file: "crates/a/src/lib.rs".into(),
                line: 3,
                sites: vec![site("crates/a/src/x.rs", 11), site("crates/c/src/y.rs", 22)],
            }],
            ..Consumers::default()
        },
        graph_project: String::new(),
        design: crate::design::Seed::default(),
        scope: None,
    }
}

fn plan() -> Plan {
    Plan {
        size_bucket: "small".into(),
        lenses: Vec::new(),
        max_rounds: 1,
        verify_votes: 1,
        is_library: false,
        security_sensitive: false,
        intent: String::new(),
        spec: String::new(),
        churn: Vec::new(),
        repo_rules: Vec::new(),
        surface_dropped: Vec::new(),
        light_skipped: Vec::new(),
        metrics_dropped: Vec::new(),
        signal_skipped: Vec::new(),
        data_skipped: Vec::new(),
        data_files: Vec::new(),
    }
}

fn lens(ctx: &PromptContext, profile: &Profile, lens: &str) -> String {
    let plan = plan();
    let pathspec = profile.pathspec(&[]);
    let at = LensIn {
        profile,
        lens,
        plan: &plan,
        pathspec: &pathspec,
        prior: "",
    };
    lens_prompt(ctx, &at).unwrap()
}

#[test]
fn a_lens_of_another_profile_carries_no_consumers_block() {
    let ctx = ctx();
    let rust = Profile::load("rust").unwrap();
    assert!(lens(&ctx, &rust, "errors").contains("CONSUMERS: the"));
    assert!(lens(&ctx, &rust, "negative-space").contains("CONSUMERS: the"));
    for (id, names) in [
        ("nix", ["purity", "negative-space"]),
        ("general", ["correctness", "errors"]),
    ] {
        let profile = Profile::load(id).unwrap();
        for name in names {
            let got = lens(&ctx, &profile, name);
            assert!(!got.contains("CONSUMERS"), "{id} {name}: {got}");
            assert!(!got.contains("call_11"), "{id} {name}: {got}");
        }
    }
}

#[test]
fn a_confined_lens_gets_its_crates_lines_and_hands_the_rest_to_the_seam() {
    let ctx = ctx();
    let rust = Profile::load("rust").unwrap();
    let plan = plan();
    let at = LensIn {
        profile: &rust,
        lens: "errors",
        plan: &plan,
        pathspec: "",
        prior: "",
    };
    let batch = Slice {
        key: "unit:crates/a unit:crates/b".into(),
        files: vec!["crates/a/src/lib.rs".into()],
        units: vec!["crates/a".into(), "crates/b".into()],
    };
    let got = slice_lens_prompt(&ctx, &at, &batch).unwrap();
    assert!(got.contains("the 1 line(s) below"), "{got}");
    assert!(got.contains("- crates/a/src/x.rs:11: call_11()"), "{got}");
    assert!(!got.contains("crates/c/src/y.rs"), "{got}");
    assert!(
        got.contains(
            "1 more line(s) name these symbols in other crates: not yours — the seam pass starts from them, to its own budget."
        ),
        "{got}"
    );

    let words = rust.units.as_ref().unwrap();
    let seam = seam_prompt(&ctx, &rust, words, &batch.units, &[], &[]).unwrap();
    assert!(seam.contains("- crates/c/src/y.rs:22: call_22()"), "{seam}");
    assert!(!seam.contains("CONSUMERS: the"), "{seam}");
}

#[test]
fn a_directory_slice_carries_its_own_symbols_and_no_commit_log_the_whole_diff_keeps_it() {
    let ctx = ctx();
    let rust = Profile::load("rust").unwrap();
    let plan = Plan {
        spec: "feat: the commit log".into(),
        ..plan()
    };
    let at = LensIn {
        profile: &rust,
        lens: "errors",
        plan: &plan,
        pathspec: "",
        prior: "",
    };
    let slice = |file: &str| Slice {
        key: "crates".into(),
        files: vec![file.into()],
        units: Vec::new(),
    };
    let mine = slice_lens_prompt(&ctx, &at, &slice("crates/a/src/lib.rs")).unwrap();
    assert!(mine.contains("- crates/c/src/y.rs:22: call_22()"), "{mine}");
    assert!(!mine.contains("feat: the commit log"), "{mine}");
    let other = slice_lens_prompt(&ctx, &at, &slice("crates/b/src/lib.rs")).unwrap();
    assert!(!other.contains("CONSUMERS"), "{other}");
    assert!(
        lens_prompt(&ctx, &at)
            .unwrap()
            .contains("feat: the commit log")
    );
}
