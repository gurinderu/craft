//! The Validate phase: each finding the sift left is judged against the code by its own
//! validator, unless the prior ledger settled it; a validator that gave nothing leaves its finding
//! unjudged, never dropped; a noise class settles some verdicts (realm @nick/craft, node #303).

use craft_step::Model;
use craft_store::js::{Js, JsString};

use crate::TriageError;
use crate::field;
use crate::kind::TriageKind;
use crate::ledger::Row;
use crate::noise::{class_one_base_line, classified_verdict, effective_pr_base};
use crate::prior::{ledger_by_id, settled_prior};
use crate::prompts::{self, Schema, directive};
use crate::sift::Sifted;

use super::sift::Sift;
use super::{Answers, Args, Ask, Phase, Ready};

/// The verdicts, in the order the sift left their findings, and how many no validator judged.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Validated {
    pub validations: Vec<Row>,
    pub unjudged: usize,
}

/// The first 40 UTF-16 units of `s`, as `slice(0, 40)` cuts them.
fn head(s: &JsString) -> String {
    JsString::from_utf16(s.units().take(40).collect()).to_utf8_lossy()
}

/// The validator of the `n`-th finding left, `s`.
fn ask(args: &Args, n: usize, s: &Sifted) -> Result<Ask, TriageError> {
    let base = &args.base;
    let class_one = class_one_base_line(&effective_pr_base(&args.pr_base, base));
    let at = prompts::At {
        id: &s.stable_id.to_utf8_lossy(),
        pin: &prompts::pin(base),
        class_one_base: &class_one,
        memory_note: &s.memory_note.to_utf8_lossy(),
    };
    let o = &s.finding.0;
    let site = if field::truthy(o, "location") {
        "location"
    } else {
        "title"
    };
    Ok(Ask {
        kind: TriageKind::Validate {
            finding: s.stable_id.to_utf8_lossy(),
        },
        id: format!("validate-{n}"),
        label: format!("validate:{}", head(&field::js_text(o, site))),
        prompt: format!("{}{}", directive(&args.repo), prompts::validate(o, &at)?),
        schema: Schema::Validation.value()?,
        model: Model::Opus,
    })
}

/// Each finding's verdict, or the validators' asks while any is not in.
///
/// # Errors
/// When a prompt or schema cannot be rendered.
pub(crate) fn validate(
    args: &Args,
    answers: &dyn Answers,
    sift: &Sift,
) -> Result<Ready<Validated>, TriageError> {
    let ledger: Vec<Js> = args.prior_ledger.iter().map(Js::from).collect();
    let prior = ledger_by_id(&ledger);
    let pr_base = effective_pr_base(&args.pr_base, &args.base);
    let (mut out, mut asks) = (Validated::default(), Vec::new());
    for (n, s) in sift.settled.to_validate.iter().enumerate() {
        let id = &s.stable_id;
        let v = if let Some(p) = settled_prior(&prior, id) {
            Row::carried(p)
        } else {
            match answers.answer(&TriageKind::Validate {
                finding: id.to_utf8_lossy(),
            }) {
                None => {
                    asks.push(ask(args, n, s)?);
                    continue;
                }
                Some(a) => {
                    if let Some(Ok(row)) = a.as_ref().map(Row::validation) {
                        row
                    } else {
                        out.unjudged += 1;
                        Row::unjudged(id)
                    }
                }
            }
        };
        out.validations.push(classified_verdict(v, &pr_base));
    }
    if !asks.is_empty() {
        return Ok(Ready::Ask(Phase::Validate, asks));
    }
    Ok(Ready::Got(out))
}

#[cfg(test)]
mod tests {
    use craft_store::js::{Js, Obj};

    use super::{Args, ask};
    use crate::finding::{Finding, id_of};
    use crate::sift::Sifted;

    fn sifted(location: &str, title: &str) -> Sifted {
        let f = Finding(
            Obj::new()
                .with("severity", Js::str("Low"))
                .with("title", Js::str(title))
                .with("location", Js::str(location))
                .with("source", Js::str("review")),
        );
        let id = id_of(&f);
        Sifted::new(f, id)
    }

    #[test]
    fn a_validators_label_is_its_site_cut_at_forty_units_else_its_title() {
        // Each 😀 is two UTF-16 units: forty units are `src/` and eighteen of them.
        let long = format!("src/{}.rs:7", "😀".repeat(30));
        let a = ask(&Args::default(), 3, &sifted(&long, "t")).unwrap();
        assert_eq!(a.label, format!("validate:src/{}", "😀".repeat(18)));
        assert_eq!(a.id, "validate-3");
        let b = ask(&Args::default(), 0, &sifted("", "a title")).unwrap();
        assert_eq!(b.label, "validate:a title");
    }
}
