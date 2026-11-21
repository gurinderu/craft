use super::{Error, manifest::Raw, pattern::Engine, text};
use crate::sources::spec::{is_system_name, repo_parts};
use craft_store::js::{Js, JsString, Obj};

pub(super) struct Candidate {
    pub system: String,
    repo: String,
    guessed: bool,
    from: String,
    pattern: String,
    version: String,
    scope: String,
    note: JsString,
}

fn rel_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 300
        && !p.starts_with('/')
        && !p.split('/').any(|s| s == "..")
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._@+/ -".contains(c))
}

fn control(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\0'..='\u{001f}' | '\u{007f}'))
}

fn repo_key(repo: &str) -> Option<String> {
    repo_parts(repo)
        .ok()
        .map(|p| format!("{}/{}", p.host, p.path).to_lowercase())
}

impl Candidate {
    pub(super) fn checked(
        engine: &Engine,
        mut raw: Raw,
        file: &str,
        value: &str,
    ) -> Result<Option<Self>, Error> {
        let pattern = raw.pattern.as_str().into();
        let read = engine
            .check(&pattern)
            .and_then(|()| engine.read_ref(&pattern, &value.into()));
        match read {
            Ok(rev) if rev == raw.version => {}
            Err(e @ (Error::Engine(_) | Error::Transport(_))) => return Err(e),
            Ok(_) | Err(_) => return Ok(None),
        }
        if !raw.repo.starts_with("https://") || repo_parts(&raw.repo).is_err() {
            raw.repo.clear();
        }
        let scope = file.rsplit_once('/').map_or(".", |(dir, _)| dir);
        let fields = [
            &raw.system,
            &raw.repo,
            &raw.version,
            &raw.pattern,
            &raw.note,
            file,
            scope,
        ];
        if fields.iter().any(|s| control(s))
            || !is_system_name(&raw.system)
            || !rel_path(file)
            || !rel_path(scope)
            || raw.pattern.contains('`')
        {
            return Ok(None);
        }
        let note = text::slice(&raw.note.replace('`', " ").into(), 200);
        Ok(Some(Self {
            system: raw.system,
            guessed: raw.guessed && !raw.repo.is_empty(),
            repo: raw.repo,
            from: file.into(),
            pattern: raw.pattern,
            version: raw.version,
            scope: scope.into(),
            note,
        }))
    }

    pub(super) fn covered(&self, known: &[Js], origin: &str) -> bool {
        let key = repo_key(&self.repo);
        if key.is_some() && key == repo_key(origin) {
            return true;
        }
        known.iter().filter(|v| active(v)).any(|v| {
            (key.is_some() && key == repo_key(text::field(v, "repo").as_str().unwrap_or("")))
                || ((text::field(v, "versionFrom") == self.from
                    || !text::field(v, "version").is_empty())
                    && text::field(v, "system").map_unicode(str::to_lowercase)
                        == self.system.to_lowercase())
        })
    }

    pub(super) fn json(self) -> Js {
        let mut o = Obj::new()
            .with("system", Js::str(self.system))
            .with("repo", Js::str(self.repo))
            .with("repoGuessed", Js::Bool(self.guessed))
            .with("versionFrom", Js::str(self.from))
            .with("versionMatch", Js::str(self.pattern))
            .with("version", Js::str(self.version))
            .with("scope", Js::str(self.scope));
        if !self.note.is_empty() {
            o.set("note", Js::str(self.note));
        }
        Js::Obj(o)
    }
}

fn active(v: &Js) -> bool {
    if matches!(v, Js::Arr(_)) {
        return true;
    }
    let Some(o) = v.as_obj() else {
        return false;
    };
    [("kind", "external"), ("status", "active")]
        .iter()
        .all(|(k, expected)| {
            o.get(*k)
                .is_none_or(|v| !v.truthy() || v.as_str() == Some(*expected))
        })
}
