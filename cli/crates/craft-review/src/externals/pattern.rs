//! `RegExp` transport only: no discovery/import business logic in JS (#574, #570).
use super::{Error, text};
use craft_store::js::{self, Js, JsString};
use rquickjs::{Context, Function, Runtime};
use std::cell::Cell;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod setup;
use setup::SETUP;

/// The longest one call evaluating a record's `versionMatch` may run: a backtracking-heavy pattern
/// from an old record is interrupted there and refused for that record, so `craft init` never
/// hangs on it.
pub(super) const CALL_BUDGET: Duration = Duration::from_secs(2);
/// Discovery's own patterns are linear in a line but one call carries every line of a manifest,
/// and a lazy group before a trailing class can still go quadratic on one long line: their budget
/// grows with the batch, a second per this many bytes on top of [`CALL_BUDGET`].
const BYTES_PER_SECOND: usize = 64 * 1024;
/// The most memory the engine may hold; past it the call fails and is refused.
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;

pub(super) struct Engine {
    context: Context,
    calls: Cell<usize>,
    /// When the running call must stop, and whether the interrupt handler stopped it.
    deadline: Arc<Mutex<(Option<Instant>, bool)>>,
    _runtime: Runtime,
}

/// What a call into the engine evaluates, which sets its budget and how running past it is named.
#[derive(Clone, Copy)]
enum Bound {
    /// A record's `versionMatch`: [`CALL_BUDGET`], refused for that record.
    Record,
    /// Discovery's built-in patterns over this many bytes of a manifest.
    Builtin(usize),
}

impl Bound {
    fn budget(self) -> Duration {
        match self {
            Self::Record => CALL_BUDGET,
            Self::Builtin(bytes) => {
                CALL_BUDGET + Duration::from_secs((bytes / BYTES_PER_SECOND) as u64)
            }
        }
    }

    fn what(self) -> &'static str {
        match self {
            Self::Record => "versionMatch",
            Self::Builtin(_) => "discovery's manifest patterns",
        }
    }
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
        let bytes = values.iter().map(|v| v.len()).sum();
        let output = self.call(
            Bound::Builtin(bytes),
            "__craftExec",
            (source, "", values.to_vec()),
        )?;
        Ok(Self::answer(&output)?.iter().map(strings).collect())
    }

    pub(super) fn new() -> Result<Self, Error> {
        let runtime = Runtime::new()?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        let deadline = Arc::new(Mutex::new((None, false)));
        let watch = Arc::clone(&deadline);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let Ok(mut d) = watch.lock() else {
                return true;
            };
            let past = d.0.is_some_and(|at| Instant::now() >= at);
            d.1 |= past;
            past
        })));
        let context = Context::full(&runtime)?;
        context.with(|ctx| ctx.eval::<(), _>(SETUP))?;
        Ok(Self {
            context,
            calls: Cell::new(0),
            deadline,
            _runtime: runtime,
        })
    }

    /// How many calls went into the engine so far.
    #[cfg(test)]
    pub(super) fn calls(&self) -> usize {
        self.calls.get()
    }

    fn call<A>(&self, bound: Bound, name: &str, args: A) -> Result<String, Error>
    where
        A: for<'js> rquickjs::function::IntoArgs<'js>,
    {
        self.calls.set(self.calls.get() + 1);
        let budget = bound.budget();
        self.arm(Some(Instant::now() + budget));
        let out = self
            .context
            .with(|ctx| -> rquickjs::Result<Result<String, String>> {
                match ctx.globals().get::<_, Function<'_>>(name)?.call(args) {
                    Ok(s) => Ok(Ok(s)),
                    Err(rquickjs::Error::Exception) => {
                        let e = ctx.catch();
                        let message = e.as_exception().and_then(rquickjs::Exception::message);
                        Ok(Err(message.unwrap_or_default()))
                    }
                    Err(e) => Err(e),
                }
            });
        let interrupted = self.arm(None);
        match out? {
            Ok(s) => Ok(s),
            Err(_) if interrupted => Err(Error::budget(format!(
                "{} ran past {} budget of {} s — refused",
                bound.what(),
                if matches!(bound, Bound::Record) {
                    "its"
                } else {
                    "their"
                },
                budget.as_secs()
            ))),
            Err(m) if m.contains("out of memory") => Err(Error::budget(format!(
                "{} ran past the engine's memory limit of {} MiB — refused",
                bound.what(),
                MEMORY_LIMIT >> 20
            ))),
            Err(m) => Err(Error::budget(format!("{} failed: {m}", bound.what()))),
        }
    }

    /// Sets the running call's deadline, and says whether the handler interrupted the last one.
    fn arm(&self, at: Option<Instant>) -> bool {
        self.deadline
            .lock()
            .map_or(true, |mut d| std::mem::replace(&mut *d, (at, false)).1)
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

    /// One match of discovery's own `source` over `value`.
    pub(super) fn exec(
        &self,
        source: &JsString,
        flags: &str,
        value: &JsString,
    ) -> Result<Option<Vec<Js>>, Error> {
        self.exec_bounded(
            Bound::Builtin(value.units().count() * 2),
            source,
            flags,
            value,
        )
    }

    fn exec_bounded(
        &self,
        bound: Bound,
        source: &JsString,
        flags: &str,
        value: &JsString,
    ) -> Result<Option<Vec<Js>>, Error> {
        // Well-formed strings cross as they are; one with an unpaired surrogate only through JSON.
        let output = if let (Some(s), Some(v)) = (source.as_str(), value.as_str()) {
            self.call(bound, "__craftExec", (s, flags, vec![v]))?
        } else {
            let input = Js::Arr(vec![Js::str(source), Js::str(flags), Js::str(value)]).compact();
            self.call(bound, "__craftExecJson", (input,))?
        };
        let found = Self::answer(&output)?.into_iter().next();
        Ok(found.and_then(|f| f.as_arr().map(<[Js]>::to_vec)))
    }

    pub(super) fn check(&self, source: &JsString) -> Result<(), Error> {
        if source.units().count() > 200 {
            return Err(Error::refused("versionMatch over 200 characters"));
        }
        let empty = JsString::default();
        self.exec_bounded(Bound::Record, source, "m", &empty)?;
        let counting = text::join(&[source.clone(), "|".into()]);
        let groups = self
            .exec_bounded(Bound::Record, &counting, "m", &empty)?
            .map_or(0, |m| m.len().saturating_sub(1));
        if groups != 1 {
            return Err(Error::refused(format!(
                "versionMatch has {groups} capture groups, not exactly one"
            )));
        }
        Ok(())
    }

    pub(super) fn read_ref(&self, source: &JsString, value: &JsString) -> Result<JsString, Error> {
        let found = self.exec_bounded(Bound::Record, source, "m", value)?;
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
