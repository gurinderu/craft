use std::path::Path;

use super::*;
use crate::profile::Profile;
use crate::state::Track;

#[test]
fn a_profile_without_units_or_a_failed_discovery_keeps_the_normal_mode_with_its_reason() {
    let profiles = [
        Profile::load("nix").unwrap(),
        Profile::load("rust").unwrap(),
    ];
    let tracks = [
        Track::new("nix", Vec::new()),
        Track::new("rust", Vec::new()),
    ];
    let none = Path::new("/nonexistent/craft-units");
    let units = open(true, none, "origin/main", &[], &tracks, &profiles);
    assert!(units.tracks.is_empty());
    assert_eq!(
        units.notices[0],
        "Unit mode not available for Nix: its profile finds no units — the review ran in the normal mode."
    );
    assert!(
        units.notices[1]
            .starts_with("Unit mode skipped, the crate probe failed on the Rust change ("),
        "{}",
        units.notices[1]
    );
    assert_eq!(
        open(false, none, "origin/main", &[], &tracks, &profiles),
        Units::default()
    );
}
