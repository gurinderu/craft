use super::{Error, files, pattern::Engine, text};
use crate::sources::spec::{SYSTEMS_MAX, is_system_name};
use craft_store::js::{Js, JsString, Obj};
use std::path::Path;

struct Record {
    system: JsString,
    repo: JsString,
    scope: JsString,
    from: JsString,
    pattern: JsString,
    version: JsString,
}

impl Record {
    fn new(value: &Js) -> Self {
        let field = |key| craft_store::js::trim_text(&text::field(value, key));
        let (from, pattern) = (field("versionFrom"), field("versionMatch"));
        let version = if from.is_empty() && pattern.is_empty() {
            field("version")
        } else {
            JsString::default()
        };
        Self {
            system: field("system"),
            repo: field("repo"),
            scope: field("scope"),
            from,
            pattern,
            version,
        }
    }

    fn named(&self) -> bool {
        self.system.as_str().is_some_and(is_system_name)
    }

    fn fault(&self, status: &JsString, kept: &[Self]) -> Option<JsString> {
        if !status.is_empty() && status != "active" {
            return Some(text::join(&["status ".into(), status.clone()]));
        }
        if !self.named() {
            return Some("no system name of letters, digits, `.`, `_` or `-`".into());
        }
        let need = if self.version.is_empty() {
            vec![
                ("repo", &self.repo),
                ("versionFrom", &self.from),
                ("versionMatch", &self.pattern),
            ]
        } else {
            vec![("repo", &self.repo), ("version", &self.version)]
        };
        if let Some((key, _)) = need
            .iter()
            .find(|(_, v)| v.is_empty() || v.units().count() > 300)
        {
            return Some(format!("{key} missing or over 300 characters").into());
        }
        if kept.iter().any(|r| r.system == self.system) {
            return Some("a second record of the same system".into());
        }
        (kept.len() >= SYSTEMS_MAX)
            .then(|| format!("past the bound of {SYSTEMS_MAX} systems").into())
    }

    fn revision(&self, engine: &Engine, root: &Path) -> Result<JsString, Error> {
        if !self.version.is_empty() {
            if let Some(why) = text::ref_fault(&self.version) {
                return Err(Error::refused(format!("version: {why}")));
            }
            return Ok(self.version.clone());
        }
        engine.check(&self.pattern)?;
        let value = files::read(root, &self.from, 4 * 1024 * 1024, "versionFrom")?;
        engine.read_ref(&self.pattern, &value.into())
    }

    fn candidate(&self, rev: JsString) -> Js {
        let mut o = Obj::new()
            .with("system", Js::str(&self.system))
            .with("repo", Js::str(&self.repo))
            .with("ref", Js::str(rev))
            .with("scope", Js::str(&self.scope));
        if self.version.is_empty() {
            o.set("versionFrom", Js::str(&self.from));
            o.set("versionMatch", Js::str(&self.pattern));
        } else {
            o.set("version", Js::str(&self.version));
        }
        Js::Obj(o)
    }
}

fn relevant(v: &Js) -> bool {
    v.as_obj()
        .is_none_or(|o| !o.has("kind") || o.get("kind").and_then(Js::as_str) == Some("external"))
}

fn select(list: &[Js]) -> (Vec<Record>, Vec<Js>) {
    let (mut records, mut refused) = (Vec::new(), Vec::new());
    for (i, v) in list.iter().filter(|v| relevant(v)).enumerate() {
        let record = Record::new(v);
        if let Some(why) = record.fault(
            &craft_store::js::trim_text(&text::field(v, "status")),
            &records,
        ) {
            let name = if record.named() {
                format!(" ({})", record.system.to_utf8_lossy())
            } else {
                String::new()
            };
            refused.push(Js::str(text::join(&[
                format!("external record #{i}{name}: ").into(),
                why,
            ])));
        } else {
            records.push(record);
        }
    }
    (records, refused)
}

pub(super) fn import(root: &Path, list: &[Js]) -> Result<Js, Error> {
    let engine = Engine::new()?;
    let (records, mut refused) = select(list);
    let mut candidates = Vec::new();
    for record in records {
        match record.revision(&engine, root) {
            Ok(rev) => candidates.push(record.candidate(rev)),
            Err(e @ (Error::Engine(_) | Error::Transport(_))) => return Err(e),
            Err(e) => refused.push(Js::str(text::join(&[
                "external record ".into(),
                record.system,
                ": ".into(),
                e.message(),
            ]))),
        }
    }
    Ok(Js::Obj(
        Obj::new()
            .with("candidates", Js::Arr(candidates))
            .with("refused", Js::Arr(refused)),
    ))
}
