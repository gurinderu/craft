//! A profile that `extends` another is resolved once, at load, into the whole profile the rest of
//! the review reads (realm @nick/craft, node #552): nothing downstream knows a profile had a base.
//!
//! The merge, base first:
//! - every key of the base is inherited unless the profile names it — except who the profile is
//!   and what it takes (`id`, `lang`, `detect`), never inherited, and `extends`/`exclude`, which
//!   are the merge's own;
//! - the rubric (`rubricSkill`, `fpRules`, `ruleCatalog`) is inherited whole or not at all: a
//!   profile naming its own `rubricSkill` takes neither the base's exclusion file nor its catalog
//!   flag;
//! - `lenses` and `floorLenses` merge by `id`, each list on its own: the base's lenses in their
//!   order, less those `exclude` names; then each of the profile's own, in its order, replaces the
//!   base's lens of its id where it stood, or is appended.
//!
//! Refused with [`ContentError::BadProfile`]: a cycle of `extends`, a base that does not exist, an
//! `exclude` without a base or naming a lens the base lacks, a lens both excluded and declared, a
//! replacement that moves a lens between the roster and the floors, flips `metrics` or drops the
//! base lens's own rubric; and, once merged, an always, safety or security-floor lens the roster
//! lacks, or a lens gated on a signal that is unknown, unconditional or always run.

use serde_json::{Map, Value};

use super::Profile;
use crate::content::ContentError;

/// Keys a profile never inherits.
const OWN: [&str; 5] = ["id", "lang", "detect", "extends", "exclude"];
/// The rubric, inherited whole.
const RUBRIC: [&str; 3] = ["rubricSkill", "fpRules", "ruleCatalog"];
/// The lens lists, merged by id.
const LISTS: [&str; 2] = ["lenses", "floorLenses"];

fn bad(id: &str, why: impl Into<String>) -> ContentError {
    ContentError::BadProfile(id.to_owned(), why.into())
}

/// The profile `id` as JSON, every base it extends merged in.
pub(super) fn resolve(
    id: &str,
    read: &dyn Fn(&str) -> Result<String, ContentError>,
) -> Result<Value, ContentError> {
    resolve_from(id, read, &mut Vec::new())
}

fn resolve_from(
    id: &str,
    read: &dyn Fn(&str) -> Result<String, ContentError>,
    chain: &mut Vec<String>,
) -> Result<Value, ContentError> {
    if chain.iter().any(|c| c == id) {
        let first = chain.first().map_or(id, String::as_str);
        return Err(bad(
            first,
            format!("extends cycle: {} -> {id}", chain.join(" -> ")),
        ));
    }
    let path = format!("profiles/{id}.json");
    let own: Value = serde_json::from_str(&read(id)?)
        .map_err(|e| ContentError::NotJson(path.clone(), e.to_string()))?;
    let Some(own) = own.as_object() else {
        return Err(ContentError::NotJson(path, "not an object".into()));
    };
    let Some(base_id) = own.get("extends") else {
        if own.contains_key("exclude") {
            return Err(bad(
                id,
                "exclude names lenses of a base, but it extends none",
            ));
        }
        return Ok(Value::Object(own.clone()));
    };
    let base_id = base_id
        .as_str()
        .ok_or_else(|| bad(id, "extends must name a profile"))?;
    chain.push(id.to_owned());
    let base = match resolve_from(base_id, read, chain) {
        Err(ContentError::UnknownFile(_)) => {
            return Err(bad(id, format!("extends unknown profile {base_id:?}")));
        }
        other => other?,
    };
    chain.pop();
    merge(id, base.as_object().cloned().unwrap_or_default(), own).map(Value::Object)
}

fn merge(
    id: &str,
    mut out: Map<String, Value>,
    own: &Map<String, Value>,
) -> Result<Map<String, Value>, ContentError> {
    let [roster, floors] = LISTS.map(|k| lenses_of(&out, k));
    let excluded = excludes(id, own, &[&roster, &floors])?;
    for k in OWN {
        out.remove(k);
    }
    if own.contains_key("rubricSkill") {
        for k in RUBRIC {
            out.remove(k);
        }
    }
    for (k, v) in own {
        if !matches!(k.as_str(), "extends" | "exclude") && !LISTS.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }
    let [own_roster, own_floors] = LISTS.map(|k| lenses_of(own, k));
    let merged = [
        merge_list(id, (&roster, &floors), &own_roster, &excluded)?,
        merge_list(id, (&floors, &roster), &own_floors, &excluded)?,
    ];
    for (key, list) in LISTS.into_iter().zip(merged) {
        out.insert(key.to_owned(), Value::Array(list));
    }
    Ok(out)
}

fn lenses_of(p: &Map<String, Value>, key: &str) -> Vec<Value> {
    p.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn lens_id(l: &Value) -> &str {
    l.get("id").and_then(Value::as_str).unwrap_or("")
}

/// The base's lenses `own` excludes, each checked to be one.
fn excludes(
    id: &str,
    own: &Map<String, Value>,
    base_lists: &[&Vec<Value>],
) -> Result<Vec<String>, ContentError> {
    let Some(raw) = own.get("exclude") else {
        return Ok(Vec::new());
    };
    let names: Vec<String> = serde_json::from_value(raw.clone())
        .map_err(|e| bad(id, format!("exclude must be a list of lens ids: {e}")))?;
    let declared: Vec<Value> = LISTS.iter().flat_map(|k| lenses_of(own, k)).collect();
    for n in &names {
        if !base_lists
            .iter()
            .copied()
            .flatten()
            .any(|l| lens_id(l) == n)
        {
            return Err(bad(
                id,
                format!("exclude names {n:?}, a lens its base lacks"),
            ));
        }
        if declared.iter().any(|l| lens_id(l) == n) {
            return Err(bad(id, format!("excludes {n:?} and declares it too")));
        }
    }
    Ok(names)
}

/// One lens list: `base` less `excluded`, each of `own` replacing its id in place or appended;
/// `other` is the base's other list, which no lens of `own` may take an id from.
fn merge_list(
    id: &str,
    (base, other): (&[Value], &[Value]),
    own: &[Value],
    excluded: &[String],
) -> Result<Vec<Value>, ContentError> {
    let mut out: Vec<Value> = base
        .iter()
        .filter(|l| !excluded.iter().any(|x| x == lens_id(l)))
        .cloned()
        .collect();
    for l in own {
        let lid = lens_id(l);
        if other.iter().any(|o| lens_id(o) == lid) {
            return Err(bad(
                id,
                format!("lens {lid:?} moves between lenses and floorLenses of its base"),
            ));
        }
        match out.iter_mut().find(|o| lens_id(o) == lid) {
            Some(slot) => {
                compatible(id, slot, l)?;
                slot.clone_from(l);
            }
            None => out.push(l.clone()),
        }
    }
    Ok(out)
}

/// A replacement keeps what makes the lens run the way it does: `metrics` (a metrics lens's brief
/// is its whole prompt, its findings and verifier are other) and the base lens's own rubric.
fn compatible(id: &str, base: &Value, own: &Value) -> Result<(), ContentError> {
    let lid = lens_id(own);
    let flag = |l: &Value| l.get("metrics").and_then(Value::as_bool).unwrap_or(false);
    if flag(base) != flag(own) {
        return Err(bad(
            id,
            format!("lens {lid:?} replaces its base's with metrics flipped"),
        ));
    }
    if let Some(rubric) = base.get("rubric").filter(|r| !r.is_null())
        && own.get("rubric") != Some(rubric)
    {
        return Err(bad(
            id,
            format!("lens {lid:?} replaces its base's without its rubric {rubric}"),
        ));
    }
    Ok(())
}

/// The merged profile's always and safety lenses are in its roster.
pub(super) fn check(p: &Profile) -> Result<(), ContentError> {
    if let Some(l) = p.always_lenses.iter().find(|l| !p.offers(l)) {
        return Err(bad(
            &p.id,
            format!("alwaysLenses names {l:?}, not in its lenses"),
        ));
    }
    if !p.offers(&p.safety_lens) {
        return Err(bad(
            &p.id,
            format!("safetyLens names {:?}, not in its lenses", p.safety_lens),
        ));
    }
    if let Some(l) = p.security_floor.iter().find(|l| !p.offers(l)) {
        return Err(bad(
            &p.id,
            format!("securityFloor names {l:?}, not in its lenses"),
        ));
    }
    signals(p)
}

/// Each lens's `signal` is one [`crate::lens_signal`] reads, on a `conditional` lens — a blanket
/// fill would plan it signal or not — that no always set holds (realm @nick/craft, node #625).
fn signals(p: &Profile) -> Result<(), ContentError> {
    for l in p.lenses.iter().chain(&p.floor_lenses) {
        let Some(s) = &l.signal else {
            continue;
        };
        let why = if !crate::lens_signal::SIGNALS.contains(&s.as_str()) {
            format!("lens {:?} names the unknown signal {s:?}", l.id)
        } else if !l.conditional {
            format!("lens {:?} is gated on {s:?} but not conditional", l.id)
        } else if p.always_lenses.contains(&l.id) {
            format!("lens {:?} is gated on {s:?} and in alwaysLenses", l.id)
        } else {
            continue;
        };
        return Err(bad(&p.id, why));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
