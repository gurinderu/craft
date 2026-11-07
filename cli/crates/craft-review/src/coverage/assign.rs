//! Which profile takes each changed file: the first whose suffixes or names match it, else the one
//! taking the rest (`general`), so a file is reviewed by one profile only and a mixed diff is
//! planned per profile over its own files.

use crate::profile::Profile;

/// Each profile's part of `files`, in the order of `profiles`, as the profile's index and the
/// files it takes in diff order; a profile taking none is left out.
#[must_use]
pub fn assign(files: &[String], profiles: &[Profile]) -> Vec<(usize, Vec<String>)> {
    let mut parts: Vec<(usize, Vec<String>)> = Vec::new();
    for f in files {
        let named = profiles.iter().position(|p| !p.detect.rest && p.covers(f));
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
    fn each_file_goes_to_one_profile_and_config_and_prose_to_none() {
        let all = Profile::all().unwrap();
        let files = owned(&[
            "web/app.ts",
            "src/lib.rs",
            "flake.nix",
            "Cargo.toml",
            "README.md",
            "Dockerfile",
            "flake.lock",
            "x.py",
        ]);
        let parts: Vec<(String, Vec<String>)> = assign(&files, &all)
            .into_iter()
            .map(|(i, f)| (all[i].id.clone(), f))
            .collect();
        assert_eq!(
            parts,
            [
                ("rust".into(), owned(&["src/lib.rs", "Cargo.toml"])),
                ("nix".into(), owned(&["flake.nix", "flake.lock"])),
                ("general".into(), owned(&["web/app.ts", "x.py"])),
            ]
        );
    }

    #[test]
    fn the_label_names_what_the_profiles_review() {
        let all = Profile::all().unwrap();
        assert_eq!(
            supported(&all),
            "Rust, Nix and source in any other language, but no project configuration or build recipe"
        );
        assert_eq!(supported(&all[..1]), "Rust only");
    }
}
