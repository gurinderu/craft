mod chart;
mod images;
pub(super) mod lines;
mod paths;
pub(super) mod patterns;
mod pins;

use super::{Error, candidate::Candidate, pattern::Engine};
pub(super) use paths::kind;

pub(super) struct Raw {
    pub system: String,
    pub repo: String,
    pub guessed: bool,
    pub version: String,
    pub pattern: String,
    pub note: String,
}

pub(super) fn candidates(engine: &Engine, file: &str, text: &str) -> Result<Vec<Candidate>, Error> {
    let kind = paths::kind(file);
    if kind.is_none() {
        return Ok(Vec::new());
    }
    let doc = lines::Document::new(engine, text)?;
    let raw = match kind {
        Some(paths::Kind::Chart) => chart::candidates(engine, &doc)?,
        Some(paths::Kind::Values) => {
            let mut out = images::inline(engine, &doc)?;
            out.extend(images::pairs(engine, &doc, false)?);
            out
        }
        Some(paths::Kind::Kustomization) => images::pairs(engine, &doc, true)?,
        Some(paths::Kind::Compose) => images::inline(engine, &doc)?,
        Some(paths::Kind::Terraform) => pins::candidates(engine, &doc)?,
        Some(paths::Kind::K8s) => {
            if engine
                .exec(&"^apiVersion:".into(), "m", &text.into())?
                .is_some()
                && engine.exec(&"^kind:".into(), "m", &text.into())?.is_some()
            {
                images::inline(engine, &doc)?
            } else {
                Vec::new()
            }
        }
        None => Vec::new(),
    };
    let mut out: Vec<Candidate> = Vec::new();
    for raw in raw {
        if let Some(c) = Candidate::checked(engine, raw, file, text)?
            && !out.iter().any(|o| o.system == c.system)
        {
            out.push(c);
        }
    }
    Ok(out)
}
