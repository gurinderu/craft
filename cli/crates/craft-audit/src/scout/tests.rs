use super::{PROFILES, Scouted, profiles, scout};
use crate::batch::Tracked;

mod tracked;

fn file(path: &str, bytes: u64) -> Tracked {
    Tracked {
        path: path.into(),
        bytes,
    }
}

#[test]
fn each_file_goes_to_the_profile_the_review_gives_it_and_the_rest_is_outside() {
    let all = profiles().unwrap();
    let ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, PROFILES);
    let files = [
        file("src/lib.rs", 5),
        file("flake.nix", 5),
        file("db/0001.sql", 5),
        file("web/app.ts", 5),
        file("README.md", 5),
        file("RUNBOOK.md", 5),
        file("Dockerfile", 5),
    ];
    let got = scout(&files, &all, 100);
    let parts: Vec<(&str, Vec<String>)> = got
        .parts
        .iter()
        .map(|p| {
            (
                p.profile.as_str(),
                p.batches
                    .iter()
                    .flat_map(crate::batch::Batch::paths)
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        parts,
        [
            ("rust", vec!["src/lib.rs".to_owned()]),
            ("nix", vec!["flake.nix".to_owned()]),
            ("sql", vec!["db/0001.sql".to_owned()]),
            ("general", vec!["web/app.ts".to_owned()]),
        ]
    );
    assert_eq!(got.outside, ["README.md", "RUNBOOK.md", "Dockerfile"]);
    assert_eq!((got.tracked, got.audited()), (7, 4));
}

#[test]
fn a_part_is_cut_by_the_budget_with_each_file_keeping_its_size() {
    let all = profiles().unwrap();
    let files = [file("a.rs", 6), file("b.rs", 6), file("c.rs", 1)];
    let got: Scouted = scout(&files, &all, 10);
    let rust = &got.parts[0];
    assert_eq!(rust.batches.len(), 2);
    assert_eq!(rust.batches[1].paths(), ["b.rs", "c.rs"]);
    assert_eq!(rust.batches[1].bytes(), 7);
}
