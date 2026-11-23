//! Which profile takes each changed file: the first whose suffixes or names match it, else the one
//! taking the rest (`general`), so a file is reviewed by one profile only and a mixed diff is
//! planned per profile over its own files. A profile taking files by their steps (`runbook`) takes
//! one only when `steps` says its change touches one (realm @nick/craft, node #620).

use crate::profile::Profile;

/// Each profile's part of `files`, in the order of `profiles`, as the profile's index and the
/// files it takes in diff order; a profile taking none is left out. `steps` says whether a file
/// touches an operator step ([`crate::runbook::taken`]).
#[must_use]
pub fn assign(
    files: &[String],
    profiles: &[Profile],
    steps: &dyn Fn(&str) -> bool,
) -> Vec<(usize, Vec<String>)> {
    let mut parts: Vec<(usize, Vec<String>)> = Vec::new();
    let named_by =
        |p: &Profile, f: &str| !p.detect.rest && p.covers(f) && (!p.detect.steps || steps(f));
    for f in files {
        let named = profiles.iter().position(|p| named_by(p, f));
        let taker = named.or_else(|| profiles.iter().position(|p| p.detect.rest && p.covers(f)));
        let Some(at) = taker else {
            continue;
        };
        match parts.iter_mut().find(|(i, _)| *i == at) {
            Some((_, part)) => part.push(f.clone()),
            None => parts.push((at, vec![f.clone()])),
        }
    }
    parts.sort_by_key(|(i, _)| *i);
    parts
}

/// What `profiles` review, as a coverage exit names it.
#[must_use]
pub fn supported(profiles: &[Profile]) -> String {
    let named: Vec<&str> = profiles
        .iter()
        .filter(|p| !p.detect.rest)
        .map(|p| p.lang.as_str())
        .collect();
    let named = match named.split_last() {
        Some((last, [])) => (*last).to_owned(),
        Some((last, rest)) => format!("{}, {last}", rest.join(", ")),
        None => String::new(),
    };
    if profiles.iter().any(|p| p.detect.rest) {
        format!(
            "{named} and source in any other language, but no project configuration or build recipe"
        )
    } else {
        format!("{named} only")
    }
}

#[cfg(test)]
mod tests {
    use super::{assign, supported};
    use crate::profile::Profile;

    fn owned(files: &[&str]) -> Vec<String> {
        files.iter().map(|f| (*f).to_owned()).collect()
    }

    #[test]
    fn each_file_goes_to_one_profile_and_config_and_prose_without_steps_to_none_runbooks_even_under_github()
     {
        let all = Profile::all().unwrap();
        let files = owned(&[
            "web/app.ts",
            "src/lib.rs",
            "flake.nix",
            "Cargo.toml",
            "README.md",
            "RUNBOOK.md",
            ".github/RELEASE.md",
            "Dockerfile",
            "flake.lock",
            "x.py",
            "db/migrations/0001_init.sql",
        ]);
        let parts: Vec<(String, Vec<String>)> = assign(&files, &all, &|f| {
            f == "RUNBOOK.md" || f == ".github/RELEASE.md"
        })
        .into_iter()
        .map(|(i, f)| (all[i].id.clone(), f))
        .collect();
        assert_eq!(
            parts,
            [
                ("rust".into(), owned(&["src/lib.rs", "Cargo.toml"])),
                ("nix".into(), owned(&["flake.nix", "flake.lock"])),
                ("sql".into(), owned(&["db/migrations/0001_init.sql"])),
                (
                    "runbook".into(),
                    owned(&["RUNBOOK.md", ".github/RELEASE.md"])
                ),
                ("general".into(), owned(&["web/app.ts", "x.py"])),
            ]
        );
    }

    #[test]
    fn the_label_names_what_the_profiles_review() {
        let all = Profile::all().unwrap();
        assert_eq!(
            supported(&all),
            "Rust, Nix, SQL, Markdown runbook and source in any other language, but no project configuration or build recipe"
        );
        assert_eq!(supported(&all[..1]), "Rust only");
    }
}
