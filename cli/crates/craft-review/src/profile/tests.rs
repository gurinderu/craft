use super::*;

#[test]
fn the_rust_profile_reads_and_every_brief_is_carried() {
    let p = Profile::rust().unwrap();
    assert_eq!(p.id, "rust");
    assert!(p.offers("intent") && !p.offers("negative-space"));
    assert!(p.lens("negative-space").is_some());
    assert_eq!(
        p.lens_agent, None,
        "its lenses run on the host's task agent"
    );
    for l in p.lenses.iter().chain(&p.floor_lenses) {
        content::text(&l.brief).unwrap();
    }
    content::text(&p.scout_rules).unwrap();
    assert!(p.covers("a/Cargo.toml") && p.covers("src/x.rs") && !p.covers("x.rsx"));
}

#[test]
fn every_profile_reads_and_carries_its_briefs_and_scout_rules() {
    let all = Profile::all().unwrap();
    assert_eq!(
        all.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        IDS,
        "in the order a file is offered to them"
    );
    for p in &all {
        for l in p.lenses.iter().chain(&p.floor_lenses) {
            content::text(&l.brief).unwrap();
        }
        content::text(&p.scout_rules).unwrap();
        for l in &p.always_lenses {
            assert!(p.offers(l), "{}: {l}", p.id);
        }
        assert_eq!(
            p.lens("negative-space").is_some(),
            p.negative_space.is_some(),
            "{}: a negative-space lens names its surface",
            p.id
        );
    }
    Profile::load("go").unwrap_err();
}

#[test]
fn the_nix_profile_runs_its_lenses_on_the_hosts_task_agent_over_its_globs() {
    let p = Profile::load("nix").unwrap();
    assert_eq!(
        p.lens_agent, None,
        "its lenses run on the host's task agent"
    );
    assert!(p.rule_catalog, "nix-review ships rules.md");
    assert_eq!(
        (
            p.rubric_skill.as_str(),
            p.fp_rules.as_str(),
            p.safety_lens.as_str()
        ),
        ("nix-review", "", "injection")
    );
    assert!(p.covers("a/b.nix") && p.covers("flake.lock") && !p.covers("a.nixx"));
    assert_eq!(p.pathspec(&["x.nix".into()]), "'*.nix' 'flake.lock'");
}

#[test]
fn the_general_profile_takes_code_but_not_prose_or_configuration() {
    let p = Profile::load("general").unwrap();
    assert_eq!(
        p.lens_agent, None,
        "its lenses run on the host's default agent"
    );
    assert!(
        p.lens("negative-space").is_some_and(|l| l.whole_diff) && p.negative_space.is_some(),
        "negative space over any language's exported surface"
    );
    assert!(!p.rule_catalog, "review-rules ships no rules.md");
    assert!(
        p.lens("complexity").is_some_and(|l| l.metrics) && crate::complexity::wanted(&p),
        "complexity, behind its code-metrics index"
    );
    for f in ["web/app.ts", "main.py", "src/lib.rs", "scripts/build.sh"] {
        assert!(p.covers(f), "{f}");
    }
    for f in [
        "README.md",
        "Cargo.lock",
        "Dockerfile",
        ".github/workflows/ci.yml",
    ] {
        assert!(!p.covers(f), "{f}");
    }
    assert_eq!(
        p.pathspec(&["web/app.ts".into(), "it's.py".into()]),
        r"':(literal)web/app.ts' ':(literal)it'\''s.py'",
        "its own files, each literal and quoted"
    );
}

#[test]
fn an_unknown_agent_or_model_token_refuses_the_profile() {
    let raw: serde_json::Value =
        serde_json::from_str(content::raw("profiles/rust.json").unwrap()).unwrap();
    for (key, bad) in [("lensAgent", "craft:rust-reviewer"), ("scoutModel", "gpt")] {
        let mut v = raw.clone();
        v[key] = serde_json::json!(bad);
        let err = serde_json::from_value::<Profile>(v).unwrap_err();
        assert!(err.to_string().contains("unknown variant"), "{key}: {err}");
    }
}

#[test]
fn the_sql_profile_takes_sql_files_on_the_default_agent_with_its_two_lenses() {
    let p = Profile::load("sql").unwrap();
    assert_eq!(
        p.lens_agent, None,
        "its lenses run on the host's default agent"
    );
    assert_eq!(p.roster(), ["sql-migrations", "sql-queries"]);
    assert_eq!(p.always_lenses, ["sql-migrations", "sql-queries"]);
    assert!(p.rule_catalog, "sql-review ships rules.md");
    assert_eq!(
        (
            p.rubric_skill.as_str(),
            p.fp_rules.as_str(),
            p.safety_lens.as_str()
        ),
        ("sql-review", "", "sql-queries")
    );
    assert!(p.covers("db/migrations/0001_init.sql") && p.covers("q.sql"));
    assert!(!p.covers("a.sqlx") && !p.covers("src/db.rs"));
    assert_eq!(p.pathspec(&["q.sql".into()]), "'*.sql'");
}

#[test]
fn the_rust_and_general_profiles_hold_the_queries_lens_behind_a_code_signal() {
    for id in ["rust", "general"] {
        let p = Profile::load(id).unwrap();
        let l = p.lens("sql-queries").unwrap();
        assert!(
            l.conditional,
            "{id}: admitted by the embedded-SQL signal only"
        );
        assert_eq!(
            l.brief,
            Profile::load("sql")
                .unwrap()
                .lens("sql-queries")
                .unwrap()
                .brief
        );
    }
    assert!(Profile::load("nix").unwrap().lens("sql-queries").is_none());
}

#[test]
fn the_embedded_queries_lens_carries_the_sql_rubric_not_its_hosts() {
    for id in ["rust", "general"] {
        let p = Profile::load(id).unwrap();
        assert_eq!(p.rubric_of("sql-queries"), "sql-review", "{id}");
        assert!(
            p.catalog_of("sql-queries"),
            "{id}: sql-review ships rules.md"
        );
        assert_eq!(
            p.fp_rules_of("sql-queries"),
            "",
            "{id}: sql-review ships no fp-rules"
        );
    }
    let rust = Profile::rust().unwrap();
    assert_eq!(
        (
            rust.rubric_of("errors"),
            rust.catalog_of("errors"),
            rust.fp_rules_of("errors")
        ),
        ("rust-review", true, "fp-rules.md")
    );
    let general = Profile::load("general").unwrap();
    assert_eq!(
        (
            general.rubric_of("security"),
            general.catalog_of("security")
        ),
        ("review-rules", false)
    );
}

#[test]
fn rust_and_nix_extend_the_general_lenses_and_sql_stays_narrow() {
    let general = Profile::load("general").unwrap();
    assert_eq!(
        general.roster(),
        [
            "correctness",
            "security",
            "money",
            "concurrency",
            "errors",
            "performance",
            "intent",
            "tests",
            "maintainability",
            "compat",
            "invariants",
            "design",
            "sql-queries",
            "complexity"
        ]
    );
    assert_eq!(general.flagged(|_| true).last().unwrap(), "negative-space");
    let rust = Profile::rust().unwrap();
    assert_eq!(
        rust.roster(),
        [
            "correctness",
            "security",
            "money",
            "concurrency",
            "errors",
            "performance",
            "intent",
            "tests",
            "maintainability",
            "compat",
            "invariants",
            "design",
            "sql-queries",
            "complexity",
            "safety",
            "api-idioms",
            "api-boundary",
            "reconciler",
            "failure-windows"
        ],
        "general's lenses where they stand, then Rust's own"
    );
    for (id, brief) in [
        ("correctness", "lens-briefs/general-correctness"),
        ("errors", "lens-briefs/rust-errors"),
        ("intent", "lens-briefs/rust-intent"),
        ("tests", "lens-briefs/general-tests"),
        ("compat", "lens-briefs/general-compat"),
        ("negative-space", "lens-briefs/rust-negative-space"),
    ] {
        assert_eq!(rust.lens(id).unwrap().brief, brief, "{id}");
    }
    assert!(
        crate::complexity::wanted(&rust),
        "complexity, behind its index"
    );
    assert_eq!(
        (
            rust.always_lenses.as_slice(),
            rust.safety_lens.as_str(),
            rust.rubric_skill.as_str(),
            rust.rule_catalog
        ),
        (
            ["intent".to_owned()].as_slice(),
            "safety",
            "rust-review",
            true
        ),
        "its own, not general's"
    );
    let nix = Profile::load("nix").unwrap();
    assert_eq!(
        nix.roster(),
        [
            "correctness",
            "security",
            "intent",
            "maintainability",
            "compat",
            "design",
            "purity",
            "reproducibility",
            "injection",
            "packaging",
            "dev-env",
            "modules"
        ]
    );
    assert_eq!(nix.lens("intent").unwrap().brief, "lens-briefs/nix-intent");
    assert!(!crate::complexity::wanted(&nix));
    let sql = Profile::load("sql").unwrap();
    assert!(sql.lens("correctness").is_none() && sql.lens("negative-space").is_none());
}

#[test]
fn every_profile_extending_the_general_one_holds_the_design_lens_optional_and_conditional() {
    for id in ["general", "rust", "nix"] {
        let p = Profile::load(id).unwrap();
        let d = p.lens("design").unwrap();
        assert!(d.optional && d.conditional && d.whole_diff, "{id}");
        assert_eq!(d.brief, "lens-briefs/general-design", "{id}");
    }
    assert!(Profile::load("sql").unwrap().lens("design").is_none());
}

#[test]
fn no_shipped_profile_runs_a_lens_on_a_reviewer_agent() {
    // A reviewer agent carries the CLAUDE.md a lens never needs; the lean task agent reads the
    // rubric the prompt's SKILL FILES name instead, and the reviewer agents stay for a review by hand.
    for p in Profile::all().unwrap() {
        assert_eq!(p.lens_agent, None, "{}", p.id);
        for lens in p.lenses.iter().chain(&p.floor_lenses) {
            assert_eq!(p.agent_of(&lens.id), None, "{}:{}", p.id, lens.id);
        }
    }
    let mut rust = Profile::rust().unwrap();
    rust.lens_agent = Some(AgentKind::RustReviewer);
    assert_eq!(
        rust.agent_of("complexity"),
        None,
        "a metrics lens never names one"
    );
    assert_eq!(rust.agent_of("correctness"), Some(AgentKind::RustReviewer));
}

/// Which files a lens reads (realm @nick/craft, node #625): the general profile's per-file lenses
/// read no data file; its whole-diff lenses and its security lens read them all, as every lens of
/// a profile taking files by name does.
#[test]
fn a_general_per_file_lens_reads_no_data_and_security_and_whole_diff_lenses_read_all() {
    let files = vec!["web/app.ts".to_owned(), "web/rows.csv".to_owned()];
    let general = Profile::load("general").unwrap();
    assert_eq!(general.reads("correctness", &files), ["web/app.ts"]);
    for lens in ["security", "compat", "intent", "complexity"] {
        assert_eq!(general.reads(lens, &files), files, "{lens}");
    }
    let rust = Profile::rust().unwrap();
    assert_eq!(rust.reads("errors", &files), files);
}
