mod origin;
mod walk;

use super::{Error, files, manifest, pattern::Engine};
use craft_store::js::{Js, JsString, Obj};
use std::path::Path;

pub(super) fn discover(root: &Path, paths: Option<&[JsString]>, known: &[Js]) -> Result<Js, Error> {
    let engine = Engine::new()?;
    let (walked, cut) = if paths.is_none() {
        walk::manifests(root)
    } else {
        (Vec::new(), false)
    };
    let files = paths.unwrap_or(&walked);
    let origin = origin::url(root);
    let (mut candidates, mut unread, mut more) = (Vec::new(), Vec::new(), 0_u32);
    for file in files {
        let value = match files::read(root, file, 1024 * 1024, "manifest") {
            Ok(value) => value,
            Err(e) => {
                unread.push(Js::Obj(
                    Obj::new()
                        .with("file", Js::str(file))
                        .with("error", Js::str(e.message())),
                ));
                continue;
            }
        };
        for c in manifest::candidates(&engine, file.as_str().unwrap_or(""), &value)? {
            if c.covered(known, &origin) {
                continue;
            }
            if candidates.len() < 64 {
                candidates.push(c.json());
            } else {
                more += 1;
            }
        }
    }
    let mut out = Obj::new()
        .with("candidates", Js::Arr(candidates))
        .with("more", Js::Num(f64::from(more)))
        .with("unread", Js::Arr(unread));
    if cut {
        out.set("walkCut", Js::str("the walk stopped at its bound of 100000 directory entries: files past it were not read — name them with --paths"));
    }
    Ok(Js::Obj(out))
}
