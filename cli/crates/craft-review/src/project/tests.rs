use super::{IntegrationPoint, PROFILE_VERSION, ProjectProfile, load, project_id, save};

fn kube_ovn() -> IntegrationPoint {
    IntegrationPoint::parse("kube-ovn=https://github.com/kubeovn/kube-ovn.git@v1.12.3").unwrap()
}

#[test]
fn a_point_reads_name_url_and_revision_split_at_the_last_at() {
    assert_eq!(
        kube_ovn(),
        IntegrationPoint {
            name: "kube-ovn".into(),
            repo: "https://github.com/kubeovn/kube-ovn.git".into(),
            rev: "v1.12.3".into()
        }
    );
    let ssh = IntegrationPoint::parse("linstor=git@github.com:LINBIT/linstor-server.git@v1.29.0")
        .unwrap();
    assert_eq!(
        (ssh.repo.as_str(), ssh.rev.as_str()),
        ("git@github.com:LINBIT/linstor-server.git", "v1.29.0")
    );
    for bad in [
        "kube-ovn",
        "kube-ovn=https://github.com/kubeovn/kube-ovn",
        "kube ovn=https://github.com/a/b@v1",
        "x=file:///tmp/r@v1",
        "x=https://github.com/a/b@-v1",
    ] {
        assert!(IntegrationPoint::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_profile_round_trips_through_its_file_and_keeps_unknown_sections_readable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p/review.toml");
    assert_eq!(load(&path).unwrap(), None);
    let p = ProjectProfile::new("/r/.git".into(), vec![kube_ovn()]).unwrap();
    save(&path, &p).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("[[integration]]") && text.contains("ref = \"v1.12.3\""),
        "{text}"
    );
    assert_eq!(load(&path).unwrap(), Some(p));
    // A later format's section the binary does not know yet: its points still read.
    std::fs::write(&path, format!("{text}\n[lenses]\nskip = [\"compat\"]\n")).unwrap();
    assert_eq!(load(&path).unwrap().unwrap().integrations, [kube_ovn()]);
    // Written again: the points replaced, that section kept.
    save(
        &path,
        &ProjectProfile::new("/r/.git".into(), Vec::new()).unwrap(),
    )
    .unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("[lenses]") && text.contains("skip = [\"compat\"]"),
        "{text}"
    );
    assert_eq!(load(&path).unwrap().unwrap().integrations, []);
    // A file that is not TOML is not overwritten.
    std::fs::write(&path, "not = = toml").unwrap();
    save(
        &path,
        &ProjectProfile::new(String::new(), Vec::new()).unwrap(),
    )
    .unwrap_err();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "not = = toml");
}

#[test]
fn another_format_a_point_named_twice_or_a_bad_point_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("review.toml");
    std::fs::write(&path, format!("version = {}\n", PROFILE_VERSION + 1)).unwrap();
    assert!(
        load(&path)
            .unwrap_err()
            .to_string()
            .contains("is not a review profile")
    );
    ProjectProfile::new(String::new(), vec![kube_ovn(), kube_ovn()]).unwrap_err();
    std::fs::write(
        &path,
        "version = 1\n[[integration]]\nname = \"x\"\nrepo = \"https://h/a\"\nref = \"a..b\"\n",
    )
    .unwrap();
    load(&path).unwrap_err();
}

#[test]
fn the_id_names_the_repository_and_tells_two_clones_apart() {
    let a = project_id("/home/u/src/craft/.git");
    assert!(
        a.starts_with("craft-") && a.len() == "craft-".len() + 12,
        "{a}"
    );
    assert_eq!(a, project_id("/home/u/src/craft/.git"));
    assert_ne!(a, project_id("/home/u/other/craft/.git"));
    assert!(project_id("/srv/mirror.git").starts_with("mirror-"));
}

#[test]
fn a_write_over_a_stored_profile_of_another_format_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("review.toml");
    let profile = ProjectProfile::new("/r/.git".into(), vec![kube_ovn()]).unwrap();
    for stored in [
        format!(
            "version = {}\n[lenses]\nskip = [\"compat\"]\n",
            PROFILE_VERSION + 1
        ),
        "[lenses]\nskip = [\"compat\"]\n".to_owned(),
    ] {
        std::fs::write(&path, &stored).unwrap();
        let err = save(&path, &profile).unwrap_err().to_string();
        assert!(err.contains("this craft writes 1"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            stored,
            "nothing written"
        );
    }
    std::fs::write(&path, format!("version = {PROFILE_VERSION}\n")).unwrap();
    save(&path, &profile).unwrap();
    assert_eq!(load(&path).unwrap(), Some(profile));
}
