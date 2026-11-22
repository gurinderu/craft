//! `RegExp` transport only: no discovery/import business logic in JS (#574, #570).
use super::{Error, text};
use craft_store::js::{self, Js, JsString};
use rquickjs::{Context, Function, Runtime};
use std::cell::Cell;

mod setup;
use setup::SETUP;

pub(super) struct Engine {
    context: Context,
    calls: Cell<usize>,
    _runtime: Runtime,
}

fn strings(found: &Js) -> Option<Vec<String>> {
    found.as_arr().map(|m| {
        m.iter()
            .map(|v| v.as_str().unwrap_or("").to_owned())
            .collect()
    })
}

impl Engine {
    pub(super) fn captures(&self, source: &str, value: &str) -> Result<Option<Vec<String>>, Error> {
        Ok(self.captures_all(source, &[value])?.pop().flatten())
    }

    pub(super) fn matches(&self, source: &str, value: &str) -> Result<bool, Error> {
        Ok(self.captures(source, value)?.is_some())
    }

    /// One match per value, in one call into the engine.
    pub(super) fn captures_all(
        &self,
        source: &str,
        values: &[&str],
    ) -> Result<Vec<Option<Vec<String>>>, Error> {
        let output = self.call("__craftExec", (source, "", values.to_vec()))?;
        Ok(Self::answer(&output)?.iter().map(strings).collect())
    }

    pub(super) fn new() -> Result<Self, Error> {
        let runtime = Runtime::new()?;
        let context = Context::full(&runtime)?;
        context.with(|ctx| ctx.eval::<(), _>(SETUP))?;
        Ok(Self {
            context,
            calls: Cell::new(0),
            _runtime: runtime,
        })
    }

    /// How many calls went into the engine so far.
    #[cfg(test)]
    pub(super) fn calls(&self) -> usize {
        self.calls.get()
    }

    fn call<A>(&self, name: &str, args: A) -> Result<String, Error>
    where
        A: for<'js> rquickjs::function::IntoArgs<'js>,
    {
        self.calls.set(self.calls.get() + 1);
        Ok(self.context.with(|ctx| -> rquickjs::Result<String> {
            ctx.globals().get::<_, Function<'_>>(name)?.call(args)
        })?)
    }

    fn answer(output: &str) -> Result<Vec<Js>, Error> {
        let answer = js::parse(output)?;
        if let Some(o) = answer.as_obj() {
            return Err(Error::refused(text::join(&[
                "versionMatch does not compile: ".into(),
                o.text_units("error"),
            ])));
        }
        Ok(answer.as_arr().map(<[Js]>::to_vec).unwrap_or_default())
    }

    pub(super) fn exec(
        &self,
        source: &JsString,
        flags: &str,
        value: &JsString,
    ) -> Result<Option<Vec<Js>>, Error> {
        // Well-formed strings cross as they are; one with an unpaired surrogate only through JSON.
        let output = if let (Some(s), Some(v)) = (source.as_str(), value.as_str()) {
            self.call("__craftExec", (s, flags, vec![v]))?
        } else {
            let input = Js::Arr(vec![Js::str(source), Js::str(flags), Js::str(value)]).compact();
            self.call("__craftExecJson", (input,))?
        };
        let found = Self::answer(&output)?.into_iter().next();
        Ok(found.and_then(|f| f.as_arr().map(<[Js]>::to_vec)))
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
