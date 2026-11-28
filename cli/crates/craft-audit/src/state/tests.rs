use super::{AuditState, Phase, STATE_VERSION, StateError, load, save, state_path};
use crate::scout::Scouted;

fn state() -> AuditState {
    AuditState {
        version: STATE_VERSION,
        cwd: "/repo".into(),
        args: super::Args {
            paths: vec!["src".into()],
            batch_bytes: 10,
            lens_agents: Some(3),
            craft_version: "9.9.9".into(),
            craft_root: Some("/plugins/craft".into()),
            record: Some(super::Recording {
                root: "/plugins/craft".into(),
                session: "s-1".into(),
            }),
        },
        scout: Scouted::default(),
        phase: Phase::Lens,
        pass: 1,
        tasks: Vec::new(),
        degraded: vec!["ran on a smaller model".into()],
        notes: vec!["a note".into()],
        stopped: None,
    }
}

#[test]
fn a_saved_state_loads_back_whole_and_leaves_no_temporary_file() {
    let d = tempfile::tempdir().unwrap();
    save(d.path(), &state()).unwrap();
    assert_eq!(load(d.path()).unwrap(), state());
    assert!(!d.path().join("state.json.tmp").exists());
}

#[test]
fn a_state_of_another_format_is_named_as_such_whatever_its_shape() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(state_path(d.path()), r#"{"version": 2, "other": true}"#).unwrap();
    let got = load(d.path());
    assert!(
        matches!(got, Err(StateError::Version { found: 2, .. })),
        "{got:?}"
    );
}

#[test]
fn a_state_that_is_not_json_or_not_there_is_refused() {
    let d = tempfile::tempdir().unwrap();
    assert!(matches!(load(d.path()), Err(StateError::Unreadable { .. })));
    std::fs::write(state_path(d.path()), "{").unwrap();
    assert!(matches!(load(d.path()), Err(StateError::Malformed { .. })));
}
