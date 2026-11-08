use super::*;

fn def(name: &str, description: &str, tools: &str, disallowed: &str) -> Definition {
    Definition {
        name: name.into(),
        description: description.into(),
        tools: tools.into(),
        disallowed: disallowed.into(),
    }
}

#[test]
fn a_request_is_named_off_or_left_to_discovery() {
    assert_eq!(request(None, true).how, How::Discovered);
    assert_eq!(request(None, false).how, How::Off);
    for off in ["", "off", "none", "false", " , "] {
        assert_eq!(request(Some(off), true).how, How::Off, "{off:?}");
    }
    let named = request(Some("reviewer, team.security-v2 reviewer bad/name"), false);
    assert_eq!(named.how, How::Named);
    assert_eq!(named.agents, ["reviewer", "team.security-v2"]);
    assert_eq!(named.failed.len(), 1);
    assert_eq!(named.failed[0].why, "not an agent type name");
}

#[test]
fn reviewers_are_those_that_review_and_cannot_edit() {
    let defs = [
        def(
            "reviewer",
            "Cold review of a finished batch. Not for writing fixes.",
            "Read, Grep, Bash",
            "",
        ),
        def("worker", "Mechanical execution; writes code files.", "", ""),
        def("auditor", "Audits the diff for security.", "Read, Edit", ""),
        def(
            "critic",
            "A critic of changes.",
            "",
            "Edit, Write, MultiEdit, NotebookEdit",
        ),
        def("inherits", "Reviews code.", "", "Edit"),
        def(
            "fixer",
            "Reviews the diff and applies fixes to the code.",
            "Read",
            "",
        ),
        def("craft:reviewer", "Reviews code.", "Read", ""),
        def("reader", "Finds files.", "Read", ""),
    ];
    assert_eq!(pick_reviewers(&defs), ["reviewer", "critic"]);
    assert!(may_edit("*", "") && may_edit("", "Edit") && !may_edit("Read", ""));
}

#[test]
fn frontmatter_reads_scalars_blocks_and_lists() {
    let text = "---\nname: \"team.rev\"\ndescription: >\n  Reviews the change,\n  read-only.\ntools:\n  - Read\n  - Grep\ndisallowedTools: [Edit, 'Write']\nmodel: opus\n---\nBody: not read.\n";
    let d = parse_definition(text, "file");
    assert_eq!(
        d,
        def(
            "team.rev",
            "Reviews the change, read-only.",
            "Read Grep",
            "Edit Write"
        )
    );
    assert_eq!(parse_definition("no frontmatter", "stem").name, "stem");
    assert_eq!(
        parse_definition("---\ndescription: x\n---\n", "stem").name,
        "stem"
    );
}

#[test]
fn discovery_reads_the_session_project_and_skips_a_foreign_repository() {
    let project = tempfile::tempdir().unwrap();
    let agents = project.path().join(".claude").join("agents");
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(
        agents.join("reviewer.md"),
        "---\ndescription: Reviews code.\ntools: Read\n---\n",
    )
    .unwrap();
    let (found, _) = discover(project.path(), project.path());
    assert_eq!(found, ["reviewer"]);
    let foreign = tempfile::tempdir().unwrap();
    let (none, why) = discover(project.path(), foreign.path());
    assert!(none.is_empty());
    assert_eq!(why, DISCOVERY_SKIPPED);
    let empty = tempfile::tempdir().unwrap();
    let (none, why) = discover(empty.path(), empty.path());
    assert!(none.is_empty());
    assert!(why.contains("declares no agent"), "{why}");
}
