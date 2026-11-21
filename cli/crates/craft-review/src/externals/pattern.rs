//! `RegExp` transport only: no discovery/import business logic in JS (#574, #570).
use super::{Error, text};
use craft_store::js::{self, Js, JsString};
use rquickjs::{Context, Runtime};

const EXEC: &str = r"(() => {
    const [source, flags, text] = JSON.parse(input);
    let re;
    try { re = new RegExp(source, flags); }
    catch (e) { return JSON.stringify({error: e.message}); }
    return JSON.stringify(re.exec(text));
})()";

pub(super) struct Engine {
    context: Context,
    _runtime: Runtime,
}

impl Engine {
    pub(super) fn captures(&self, source: &str, value: &str) -> Result<Option<Vec<String>>, Error> {
        Ok(self.exec(&source.into(), "", &value.into())?.map(|m| {
            m.iter()
                .map(|v| v.as_str().unwrap_or("").to_owned())
                .collect()
        }))
    }

    pub(super) fn matches(&self, source: &str, value: &str) -> Result<bool, Error> {
        Ok(self.captures(source, value)?.is_some())
    }

    pub(super) fn new() -> Result<Self, Error> {
        let runtime = Runtime::new()?;
        let context = Context::full(&runtime)?;
        Ok(Self {
            context,
            _runtime: runtime,
        })
    }

    pub(super) fn exec(
        &self,
        source: &JsString,
        flags: &str,
        value: &JsString,
    ) -> Result<Option<Vec<Js>>, Error> {
        let input = Js::Arr(vec![Js::str(source), Js::str(flags), Js::str(value)]).compact();
        let output: String = self.context.with(|ctx| -> rquickjs::Result<_> {
            ctx.globals().set("input", input)?;
            ctx.eval(EXEC)
        })?;
        let answer = js::parse(&output)?;
        if let Some(o) = answer.as_obj() {
            return Err(Error::refused(text::join(&[
                "versionMatch does not compile: ".into(),
                o.text_units("error"),
            ])));
        }
        Ok(answer.as_arr().map(<[Js]>::to_vec))
    }

    pub(super) fn check(&self, source: &JsString) -> Result<(), Error> {
        if source.units().count() > 200 {
            return Err(Error::refused("versionMatch over 200 characters"));
        }
        self.exec(source, "m", &JsString::default())?;
        let counting = text::join(&[source.clone(), "|".into()]);
        let groups = self
            .exec(&counting, "m", &JsString::default())?
            .map_or(0, |m| m.len().saturating_sub(1));
        if groups != 1 {
            return Err(Error::refused(format!(
                "versionMatch has {groups} capture groups, not exactly one"
            )));
        }
        Ok(())
    }

    pub(super) fn read_ref(&self, source: &JsString, value: &JsString) -> Result<JsString, Error> {
        let found = self.exec(source, "m", value)?;
        let capture = found
            .as_ref()
            .and_then(|m| m.get(1))
            .filter(|v| v.is_string())
            .map(Js::to_js_text)
            .unwrap_or_default();
        let rev = text::trim(&capture);
        if rev.is_empty() {
            return Err(Error::refused(
                "versionMatch found no version in versionFrom",
            ));
        }
        if let Some(why) = text::ref_fault(&rev) {
            return Err(Error::refused(format!(
                "{why}: {}",
                Js::str(text::slice(&rev, 60)).compact()
            )));
        }
        Ok(rev)
    }
}
